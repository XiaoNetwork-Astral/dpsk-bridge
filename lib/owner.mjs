/**
 * Which host-agent session started a job. Jobs from every workspace share one
 * DSH_HOME, so dsb uses this to show a session only its own jobs and to refuse
 * state-changing commands on jobs owned by someone else.
 *
 * The host agent has no session identifier we can read, so the owner is derived
 * from the process tree: walk up from this process past the layers that exist
 * only to run this command, and take the first ancestor that is not one. That
 * ancestor is the host session itself, and it disappears when the session ends,
 * which is what makes an orphaned job recognizable.
 *
 * On Windows the chain can break in Git Bash: bash forks a child to run the
 * shim, the child execs sh as a new Windows process, and the forked child then
 * exits, so the sh.exe left behind has a parent PID that no longer exists. The
 * MSYS runtime still knows the link, so when a parent is missing this walk asks
 * the runtime's own ps.exe for its table and follows the real Windows parent
 * across the break. An intact chain never pays for that lookup.
 *
 * A layer is skipped when it is a shell, or when it is a Node process running
 * this package's own launcher or a package manager wrapping it. Deciding that
 * from the command line rather than from the name matters: a host that is
 * itself a Node program, such as Codex, must be recognized as the host and not
 * mistaken for one of our own wrappers.
 *
 * This is cooperative, like --scope: it keeps an agent from acting on jobs it
 * did not start, and it is not a sandbox. Anything that can read DSH_HOME can
 * still reach every job record.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { processExists } from './job-state.mjs';

/** Interactive and scripting shells the host spawns per command. */
const SHELLS = new Set([
  'bash',
  'sh',
  'dash',
  'zsh',
  'fish',
  'ksh',
  'csh',
  'tcsh',
  'nu',
  'elvish',
  'xonsh',
  'cmd',
  'powershell',
  'pwsh',
  'login',
  'env',
  'winpty',
  'mintty',
  'conhost',
  'sudo',
  'doas',
]);

/** Node-ish runtimes, which are judged by what they are running. */
const RUNTIMES = new Set(['node', 'node.js', 'nodejs', 'bun', 'deno']);

/**
 * Command lines that mean "this process exists only to run dsb/dsv", so the
 * real owner is further up: our own launcher, and the package managers and
 * shims that may wrap it.
 */
const OWN_LAUNCHER = /[\\/](?:dsb|dsv)(?:\.mjs|\.js|\.cmd|\.ps1)?(?:["']|\s|$)/i;
const PACKAGE_MANAGER =
  /[\\/](?:npm-cli\.js|npx-cli\.js|npm-prefix\.js|yarn\.js|pnpm\.cjs|corepack(?:\.js)?)(?:["']|\s|$)/i;

/** How far up the process tree to look before giving up. */
const MAX_DEPTH = 16;

/** One `ps -a` row from an MSYS/Cygwin runtime: PID, PPID, PGID, WINPID. */
const MSYS_ROW = /^\s*(?:[A-Za-z]\s*)?(\d+)\s+(\d+)\s+(\d+)\s+(\d+)(?:\s|$)/;

const baseName = (name) =>
  String(name || '')
    .toLowerCase()
    .replace(/\.exe$/, '');

/**
 * True when a process is only a step on the way from the host to this command.
 * An unreadable command line makes a runtime ambiguous; it is treated as one of
 * ours, because mistaking the host for a wrapper merely widens the owner to the
 * terminal, while mistaking a wrapper for the host would pick a process that
 * dies with the command and make every job look orphaned.
 */
function isPassThrough(entry) {
  const name = baseName(entry?.name);
  if (SHELLS.has(name)) return true;
  if (!RUNTIMES.has(name)) return false;

  const command = String(entry?.command || '');
  if (!command.trim()) return true;
  return OWN_LAUNCHER.test(command) || PACKAGE_MANAGER.test(command);
}

/**
 * A readable name for a process, preferring the script a runtime is running:
 * `codex 4812` says more than `node 4812`.
 */
function displayName(entry) {
  const name = baseName(entry?.name);
  if (!RUNTIMES.has(name)) return name;

  const script = scriptOf(String(entry?.command || ''));
  return script ? `${script} (${name})` : name;
}

/** The script path a runtime was invoked with, reduced to a bare name. */
function scriptOf(command) {
  // Arguments are either quoted or whitespace separated; the runtime is first.
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  for (const raw of tokens.slice(1)) {
    const token = raw.replace(/^["']|["']$/g, '');
    if (!token || token.startsWith('-')) continue;

    const base = token.split(/[\\/]/).filter(Boolean).at(-1) || '';
    const stem = base.replace(/\.(?:mjs|cjs|js|ts)$/i, '');
    if (stem && stem !== 'index') return stem.toLowerCase();
    if (stem === 'index') return token.split(/[\\/]/).filter(Boolean).at(-2)?.toLowerCase() || '';
  }

  return '';
}

/**
 * Snapshot of every process, as
 * `pid -> { pid, ppid, name, command, executablePath, startedAt }`.
 * `startedAt` is epoch milliseconds, or null when the platform does not give
 * one; it guards against a recycled PID being read as a live owner.
 */
function processTable() {
  if (process.platform === 'win32') return windowsTable();
  return procTable() || psTable();
}

function windowsTable() {
  const script =
    'Get-CimInstance Win32_Process | ForEach-Object { ' +
    '[PSCustomObject]@{ p = $_.ProcessId; r = $_.ParentProcessId; n = $_.Name; ' +
    'c = if ($_.CommandLine) { $_.CommandLine.Substring(0, [Math]::Min(500, $_.CommandLine.Length)) } else { $null }; ' +
    'e = $_.ExecutablePath; ' +
    's = if ($_.CreationDate) { [int64]($_.CreationDate.ToUniversalTime() - ' +
    "[datetime]'1970-01-01Z').TotalMilliseconds } else { $null } } } | ConvertTo-Json -Compress";

  let raw;
  try {
    raw = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
    );
  } catch {
    return null;
  }

  let rows;
  try {
    rows = JSON.parse(raw);
  } catch {
    return null;
  }

  const table = new Map();
  for (const row of Array.isArray(rows) ? rows : [rows]) {
    if (!Number.isSafeInteger(row?.p)) continue;
    table.set(row.p, {
      pid: row.p,
      ppid: Number.isSafeInteger(row.r) ? row.r : null,
      name: String(row.n || ''),
      command: typeof row.c === 'string' ? row.c : '',
      executablePath: typeof row.e === 'string' ? row.e : '',
      startedAt: Number.isSafeInteger(row.s) ? row.s : null,
    });
  }

  return table.size ? table : null;
}

/** Linux: /proc is cheaper and needs no child process. */
function procTable() {
  let names;
  try {
    names = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch {
    return null;
  }

  // CLK_TCK is 100 on every Linux this runs on; a wrong guess only shifts the
  // recorded start time, which is compared with a tolerance.
  const ticks = 100,
    bootMs = Date.now() - os.uptime() * 1000;
  const table = new Map();

  for (const name of names) {
    let stat;
    try {
      stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
    } catch {
      continue;
    }

    // The executable name is parenthesized and may itself contain spaces.
    const close = stat.lastIndexOf(')');
    if (close < 0) continue;
    const executable = stat.slice(stat.indexOf('(') + 1, close);
    const fields = stat.slice(close + 2).split(' ');
    const pid = Number(name),
      ppid = Number(fields[1]),
      startTicks = Number(fields[19]);

    let command = '';
    try {
      command = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    } catch {}

    table.set(pid, {
      pid,
      ppid: Number.isSafeInteger(ppid) ? ppid : null,
      name: executable,
      command,
      startedAt: Number.isFinite(startTicks)
        ? Math.round(bootMs + (startTicks / ticks) * 1000)
        : null,
    });
  }

  return table.size ? table : null;
}

/** macOS and other Unix: one `ps` covers the whole table. */
function psTable() {
  let raw;
  try {
    raw = execFileSync('ps', ['-axo', 'pid=,ppid=,lstart=,command='], {
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return null;
  }

  const table = new Map();
  for (const line of raw.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.*)$/.exec(line);
    if (!match) continue;

    const started = Date.parse(match[3]),
      command = String(match[4] || '');
    table.set(Number(match[1]), {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      name: (command.match(/^"[^"]*"|^\S+/)?.[0] || command)
        .replace(/"/g, '')
        .split(/[\\/]/)
        .at(-1),
      command,
      startedAt: Number.isFinite(started) ? started : null,
    });
  }

  return table.size ? table : null;
}

/**
 * Parse the `ps -a` table of an MSYS2 or Cygwin runtime into rows of
 * `{ pid, ppid, winpid }`. A leading status flag may precede the PID.
 */
export function parseMsysTable(raw) {
  const rows = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const match = MSYS_ROW.exec(line);
    if (!match) continue;

    const pid = Number(match[1]),
      ppid = Number(match[2]),
      winpid = Number(match[4]);
    if (![pid, ppid, winpid].every(Number.isSafeInteger)) continue;
    rows.push({ pid, ppid, winpid });
  }

  return rows;
}

/** Windows image path of a process, from the table field or its command line. */
function executableOf(entry) {
  const explicit = String(entry?.executablePath || '').trim();
  if (explicit) return explicit;

  const token = (String(entry?.command || '').match(/"[^"]*"|'[^']*'|\S+/g) || [])[0] || '';
  const command = token.replace(/^["']|["']$/g, '');
  return /\.exe$/i.test(command) ? command : '';
}

/** Directory of the MSYS/Cygwin runtime that owns a process, if it is one. */
function runtimeDirOf(entry) {
  const executable = executableOf(entry);
  if (!/^(?:[A-Za-z]:[\\/]|\\\\)/.test(executable)) return null;

  const dir = path.win32.dirname(executable);
  return dir && dir !== '.' ? dir : null;
}

/** True when a directory holds an MSYS2 or Cygwin runtime we can ask about. */
function hasMsysRuntime(dir) {
  const ps = path.join(dir, 'ps.exe');
  if (!fs.existsSync(ps)) return false;
  return ['msys-2.0.dll', 'cygwin1.dll'].some((name) => fs.existsSync(path.join(dir, name)));
}

/**
 * Read an MSYS runtime's own process table. A missing runtime, a failed call,
 * or unparsable output all mean the same thing: there is no bridge to use.
 */
function readMsysTable(dir) {
  if (process.platform !== 'win32') return null;
  if (!hasMsysRuntime(dir)) return null;

  let raw;
  try {
    raw = execFileSync(path.join(dir, 'ps.exe'), ['-a'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    return null;
  }

  const rows = parseMsysTable(raw);
  return rows.length ? rows : null;
}

/** Stable id for an owner, so the same host session keeps it across commands. */
const ownerId = (name, pid, startedAt) =>
  crypto
    .createHash('sha256')
    .update(`${name}|${pid}|${startedAt ?? ''}`)
    .digest('hex')
    .slice(0, 16);

const describe = (entry, source) => ({
  id: ownerId(displayName(entry), entry.pid, entry.startedAt),
  label: `${displayName(entry)} ${entry.pid}`,
  pid: entry.pid,
  startedAt: entry.startedAt,
  source,
});

const unknownOwner = () => ({
  id: null,
  label: 'unknown',
  pid: null,
  startedAt: null,
  source: 'unknown',
});

/**
 * Reading the process table costs over a second on Windows, so commands that
 * need the owner resolve it once. Commands that only read a job (status,
 * result, events, wait) never call this and pay nothing.
 */
let cached = null;

export function currentOwner() {
  return (cached ??= resolveOwner());
}

/**
 * The host session that is running this command.
 *
 * `DPSK_OWNER` overrides the walk: a host that does expose a session id can set
 * it, which is both cheaper and exact. `source` records which rule applied, so
 * callers can tell an exact identity from a guess. `msysSource` replaces the
 * MSYS runtime reader for tests; it receives the runtime directory.
 */
export function resolveOwner({
  env = process.env,
  pid = process.pid,
  table,
  msysSource = readMsysTable,
} = {}) {
  const override = String(env.DPSK_OWNER || '').trim();
  if (override)
    return {
      id: crypto.createHash('sha256').update(override).digest('hex').slice(0, 16),
      label: override.slice(0, 80),
      pid: null,
      startedAt: null,
      source: 'env',
    };

  const processes = table ?? processTable();
  if (!processes) return unknownOwner();

  // The MSYS table is read lazily, at most once, and only when the Windows
  // walk actually hits a missing parent.
  let msysRows;
  const bridgeFrom = (visited) => {
    if (msysRows === undefined) {
      const runtimeDir = runtimeDirOf(visited.at(-1));
      if (!runtimeDir) return null;
      msysRows = msysSource(runtimeDir) || null;
    }
    if (!msysRows?.length) return null;

    const byWinpid = new Map();
    const byPid = new Map();
    for (const row of msysRows) {
      byWinpid.set(row.winpid, row);
      byPid.set(row.pid, row);
    }

    // Prefer the visited process nearest the break whose Windows PID the
    // runtime still lists; its PPID gives the real Windows parent.
    const anchor = visited.map((entry) => byWinpid.get(entry.pid)).findLast(Boolean);
    if (!anchor) return null;

    const parentRow = byPid.get(anchor.ppid);
    if (!parentRow) return null;

    const parent = processes.get(parentRow.winpid);
    if (!parent || visited.some((entry) => entry.pid === parent.pid)) return null;
    return parent;
  };

  const visited = [];
  let current = processes.get(pid),
    depth = 0;
  while (current && depth++ < MAX_DEPTH) {
    visited.push(current);

    const parent = current.ppid == null ? null : processes.get(current.ppid);
    if (!parent) {
      const bridged = bridgeFrom(visited);
      if (!bridged || bridged.pid === current.pid) break;
      if (!isPassThrough(bridged)) return describe(bridged, 'process');
      current = bridged;
      continue;
    }

    if (parent.pid === current.pid) break;
    if (!isPassThrough(parent)) return describe(parent, 'process');
    current = parent;
  }

  // Every ancestor was a pass-through layer, or the walk ran out: fall back to
  // the outermost one reached, which still separates one terminal from another.
  if (current && current.pid !== pid) return describe(current, 'shell');

  return unknownOwner();
}

/**
 * Whether an owner's host session is still present.
 *
 * `null` means undecidable: the record has no owner, or it came from
 * `DPSK_OWNER` and carries no process to check. A recorded start time must
 * match, otherwise a recycled PID would make a dead session look alive.
 */
export function ownerAlive(owner, { table } = {}) {
  if (!owner?.id || !Number.isSafeInteger(owner.pid)) return null;
  if (!processExists(owner.pid)) return false;
  if (owner.startedAt == null) return true;

  const processes = table ?? processTable();
  const current = processes?.get(owner.pid);
  if (!current || current.startedAt == null) return true;

  // Clock resolution differs between the table and what was recorded.
  return Math.abs(current.startedAt - owner.startedAt) < 2000;
}

/**
 * Cheap liveness for display, costing no process-table read. A recycled PID can
 * read as live here, which is acceptable for a label but not for a decision;
 * use `ownerAlive` when the answer governs what happens to a job.
 */
export const ownerPresent = (owner) =>
  Number.isSafeInteger(owner?.pid) ? processExists(owner.pid) : null;

/** True when the job was started by the session running this command. */
export const ownedBy = (job, owner) => Boolean(job?.owner?.id) && job.owner.id === owner?.id;

/**
 * Two hex characters identifying an owner in dense output such as dsv's list.
 * Derived from the id, so it is stable across runs and independent of the order
 * jobs appear in.
 */
export const ownerBadge = (ownerId) =>
  ownerId ? crypto.createHash('sha256').update(ownerId).digest('hex').slice(0, 2) : '--';
