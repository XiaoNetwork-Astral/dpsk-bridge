/** dsv command line: ls / show / watch / update / snapshot / TUI dispatch. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readEvents, createEventReader, listSessionFiles } from '../sessions.mjs';
import { checkForUpdate, applyUpdate, setAutoUpdate, recoverUpdate } from '../updater.mjs';
import { buildBlocks } from './blocks.mjs';
import { summarizeSession } from './store.mjs';
import { runSnapshot, runTui } from './app.mjs';
import { ago, cut, safeText, styler, when } from './text.mjs';

const PACKAGE = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

const rootOf = () =>
  process.env.DSH_SESSIONS_ROOT ||
  path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions');
const ROOT = rootOf();

const USAGE = `dsv — read DeepSeek Harness session logs

Usage: dsv [COMMAND] [OPTIONS]

Commands:
  (none)                    Full-screen viewer; prints the ls table when not on a terminal
  ls [N]                    List the N most recent sessions [default: 15]
  show [ID|latest]          Show a session, result first
  watch [ID]                Follow a session live; without an ID, follow the newest one
  update                    Check for and install a release

Options:
  --details                 show: the full process in time order
  --full                    show: do not shorten tool output
  --reasoning               show: include model thinking
  --no-reasoning            show: hide model thinking
  --all                     show: also system and developer messages (implies --details)
  --snapshot <COLS>x<ROWS>  Print one frame of the viewer as plain text
      --focus list|detail   with --snapshot: which panel has focus
      --select <ID_PREFIX>  with --snapshot: which session to show
  --check                   update: only check, do not install
  --auto on|off             update: turn automatic updates on or off [default: off]
  --recover --confirm-stopped
                            update: release a held update after the old processes exited
  --no-update-check         Do not check for updates in the viewer
  -V, --version             Print version
  -h, --help                Print help

States come from the logs: Ended does not mean accepted, and No updates does not mean
the process stopped. Check bridge jobs with dsb status`;

function valueAfter(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function resolveSession(selector, root = ROOT) {
  const all = listSessionFiles(root);

  if (!all.length) {
    console.error(`No dsh sessions found in ${root}`);
    process.exitCode = 1;
    return null;
  }
  if (!selector || selector === 'latest') return all[0];

  const hit = all.filter((session) =>
    session.id.startsWith(String(selector).replace(/^session-/, '')),
  );
  if (hit.length !== 1) {
    console.error(
      hit.length
        ? `Prefix ${selector} matches several sessions; use a longer one`
        : `No session matches ${selector}`,
    );
    process.exitCode = 1;
    return null;
  }

  return hit[0];
}

const errorCount = (count) => `${count} error${count === 1 ? '' : 's'}`;

function headerLines(summary, { full = false } = {}) {
  const title = safeText(summary.title || summary.prompt || 'Untitled task');
  const project = safeText(path.basename(summary.cwd || '')) || '?';

  const state =
    summary.state === 'done'
      ? '✓ Ended'
      : summary.state === 'active'
        ? '● Running'
        : summary.state === 'quiet'
          ? '◌ No updates (this does not prove the process stopped)'
          : summary.state === 'interrupted'
            ? '■ Interrupted (the bridge job is no longer running)'
            : summary.state === 'error'
              ? '✗ Failed'
              : summary.state === 'aborted'
                ? '✗ Aborted'
                : summary.state === 'empty'
                  ? '· Empty'
                  : `✗ ${safeText(summary.state)}`;

  if (!full) {
    return [
      title,
      `${project}  ${state}${summary.errors ? `  ${errorCount(summary.errors)}` : ''}`,
      ...(summary.readError ? [`Could not read the log: ${safeText(summary.readError)}`] : []),
    ];
  }

  const usage = summary.usage;
  const token = (key) =>
    usage?.available && usage.tokens?.[key] !== null && usage.tokens?.[key] !== undefined
      ? usage.tokens[key]
      : '?';

  return [
    title,
    `Project  ${project}   path ${safeText(summary.cwd || '?')}`,
    `Session  ${safeText(summary.id.slice(0, 8))}   format v${summary.version ?? '?'}   started ${when(summary.created)}`,
    `${state}   ${summary.tools} tool call${summary.tools === 1 ? '' : 's'}${summary.errors ? `   ${errorCount(summary.errors)}` : ''}`,
    usage?.available
      ? `Usage    input ${token('uncachedInputTokens')}   output ${token('outputTokens')}   cache read ${token('cacheReadTokens')}   cache write ${token('cacheWriteTokens')}${usage.missingSamples ? '   (incomplete samples)' : ''}`
      : 'Usage    unavailable (not the same as zero)',
    ...(summary.logComplete === false
      ? ['The log ends with an unfinished or unreadable record; showing everything before it']
      : []),
    ...(summary.readError ? [`Could not read the log: ${safeText(summary.readError)}`] : []),
    ...(['active', 'quiet'].includes(summary.state)
      ? ['Log state does not prove the process is alive; check bridge jobs with dsb status']
      : []),
  ];
}

// Commands
export function show(selector, flags, { root = ROOT, read = readEvents } = {}) {
  const session = resolveSession(selector, root);
  if (!session) return;

  let decoded;
  try {
    decoded = read(session.file);
  } catch (error) {
    console.error(`Could not read the log: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const summary = summarizeSession(session, decoded.events, {
    complete: decoded.complete,
    error: decoded.error,
  });
  const full = flags.full || flags.all;
  console.log(headerLines(summary, { full }).join('\n'));

  const blocks = buildBlocks(decoded.events, {
    view: full ? 'process' : flags.details ? 'process' : 'reading',
    columns: Math.max(60, Math.min(process.stdout.columns || 100, 140)),
    reasoning: flags.reasoning,
    system: flags.all,
    interactive: false,
    st: styler(false),
  });

  if (full) {
    for (const block of blocks) console.log((block.full || block.lines).join('\n'));
  } else {
    for (const block of blocks) console.log(block.lines.join('\n'));
  }
  console.log();
}

function ls(count = 15) {
  const all = listSessionFiles(ROOT);
  if (!all.length) return console.log('No DeepSeek sessions yet');

  const rows = all
    .slice(0, count)
    .map((session) => {
      try {
        const decoded = readEvents(session.file);
        return summarizeSession(session, decoded.events, {
          complete: decoded.complete,
          error: decoded.error,
        });
      } catch (error) {
        return {
          ...summarizeSession(session, []),
          title: `Could not read the log: ${error.message}`,
          state: 'unreadable',
          readError: error.message,
        };
      }
    })
    .filter((row) => row.state !== 'empty');

  const running = rows.filter((row) => row.state === 'active').length;

  console.log(
    `\n  DeepSeek sessions   ${rows.length} of ${all.length}${running ? `   ${running} running` : ''}\n`,
  );
  console.log(
    '  ' +
      ['State', 'ID', 'Project', 'Tools', 'Updated']
        .map((value, index) => value.padEnd([14, 10, 18, 6, 17][index]))
        .join('') +
      'Task',
  );

  for (const row of rows) {
    const state =
      row.state === 'done'
        ? '✓ Ended'
        : row.state === 'active'
          ? '● Running'
          : row.state === 'quiet'
            ? '◌ No updates'
            : row.state === 'interrupted'
              ? '■ Interrupted'
              : row.state === 'error'
                ? '✗ Failed'
                : row.state === 'aborted'
                  ? '✗ Aborted'
                  : `✗ ${row.state}`;

    const project = safeText(path.basename(row.cwd || '')) || '?';
    console.log(
      '  ' +
        state.padEnd(14) +
        safeText(row.id.slice(0, 8)).padEnd(10) +
        cut(project, 16).padEnd(18) +
        String(row.tools).padEnd(4) +
        (row.errors ? '!' : ' ').padEnd(2) +
        ago(row.mtime).padEnd(17) +
        cut(row.title || '', 80),
    );
  }

  console.log(
    '\n  dsv show <ID>  read a session   dsv watch  follow live   --full  no shortening   --no-reasoning  hide thinking\n',
  );
}

export function watch(
  selector,
  {
    root = ROOT,
    out = console,
    createReader = createEventReader,
    list = listSessionFiles,
    columns = () => Math.max(60, Math.min(process.stdout.columns || 100, 140)),
    scanMs = 5000,
    now = Date.now,
    schedule = (callback, ms) => setInterval(callback, ms),
  } = {},
) {
  const pinned = !!selector && selector !== 'latest';

  let current = resolveSession(selector, root);
  if (!current) return;

  let reader = null,
    printedHeader = false,
    lastScan = 0;

  const printed = new Map();
  const plain = styler(false);

  const printBlocks = (events) => {
    const blocks = buildBlocks(events, {
      view: 'process',
      columns: columns(),
      interactive: false,
      st: plain,
    });
    for (const block of blocks) {
      const text = block.lines.join('\n');
      if (text && printed.get(block.key) !== text) {
        out.log(text);
        printed.set(block.key, text);
      }
    }
  };

  const begin = () => {
    let decoded;
    try {
      reader = createReader(current.file);
      decoded = reader.read();
    } catch (error) {
      printedHeader = false;
      out.error(`Could not read the log: ${error.message}`);
      return;
    }

    const summary = summarizeSession(current, decoded.events, {
      complete: decoded.complete,
      error: decoded.error,
    });
    out.log(headerLines(summary).join('\n'));

    printed.clear();
    printBlocks(decoded.events);
    printedHeader = true;
  };

  const tick = () => {
    if (!printedHeader) {
      begin();
      return;
    }

    const nowMs = now();

    // The transcript is polled every second, but the session tree only needs
    // an occasional rescan for new sessions or a newer generation.
    if (nowMs - lastScan >= scanMs) {
      lastScan = nowMs;
      const all = list(root);
      const newest = pinned ? all.find((session) => session.id === current.id) : all[0];
      if (newest && newest.file !== current.file) {
        current = newest;
        out.log(`\n  ⇢ A new session started; switching to ${safeText(current.id.slice(0, 8))}\n`);
        begin();
        return;
      }
    }

    let result;
    try {
      result = reader.read();
    } catch (error) {
      out.error(`Could not read the log: ${error.message}`);
      return;
    }

    if (result.reset) {
      printed.clear();
      begin();
      return;
    }
    if (result.added.length) printBlocks(result.events);
  };

  out.log(
    `  Following live   Ctrl+C to stop${pinned ? '' : '   switches to new sessions automatically'}\n`,
  );
  tick();
  schedule(tick, 1000);
}

async function updateCommand(argv, flags) {
  try {
    if (flags.has('--recover')) {
      console.log(
        JSON.stringify(await recoverUpdate({ confirmedStopped: flags.has('--confirm-stopped') })),
      );
    } else if (flags.has('--auto')) {
      const value = valueAfter(argv, '--auto');
      if (!['on', 'off'].includes(value)) throw new Error('Usage: dsv update --auto on|off');
      console.log(JSON.stringify(setAutoUpdate(value === 'on')));
    } else {
      const info = await checkForUpdate({ force: true });
      if (flags.has('--check') || !info.available) {
        console.log(JSON.stringify(info));
        if (info.error) process.exitCode = 1;
      } else {
        console.log(
          JSON.stringify(
            await applyUpdate(info, { onProgress: (message) => console.error(message) }),
          ),
        );
      }
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

// Entry point
export async function main(argv = process.argv.slice(2)) {
  const VALUE_FLAGS = new Set(['--snapshot', '--focus', '--select', '--auto']);
  const flags = new Set(argv.filter((value) => value.startsWith('--')));
  const args = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index].startsWith('--')) {
      if (VALUE_FLAGS.has(argv[index])) index++;
      continue;
    }
    args.push(argv[index]);
  }

  const command = args[0];
  if (flags.has('--version') || argv.includes('-V')) {
    console.log(PACKAGE.version);
    return 0;
  }
  if (flags.has('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }

  if (flags.has('--snapshot')) {
    const size = valueAfter(argv, '--snapshot') || '';
    const match = /^(\d+)[xX](\d+)$/.exec(size);
    if (!match) {
      console.error('Usage: dsv --snapshot <COLS>x<ROWS>');
      process.exitCode = 1;
      return 1;
    }

    const focus = valueAfter(argv, '--focus');
    if (focus && !['list', 'detail'].includes(focus)) {
      console.error('Usage: --focus list|detail');
      process.exitCode = 1;
      return 1;
    }

    const code = await runSnapshot({
      root: ROOT,
      columns: Number(match[1]),
      rows: Number(match[2]),
      focus: focus || 'list',
      select: valueAfter(argv, '--select'),
      details: flags.has('--details') || flags.has('--all'),
      version: PACKAGE.version,
    });

    if (code) process.exitCode = code;
    return code;
  }

  if (command === 'update') {
    await updateCommand(argv, flags);
    return process.exitCode || 0;
  }

  const reasoning = flags.has('--reasoning') && !flags.has('--no-reasoning');
  const all = flags.has('--all');
  const details = flags.has('--details') || all;
  const full = flags.has('--full');

  if ((!command || command === 'tui') && process.stdout.isTTY && process.stdin.isTTY) {
    await runTui({
      root: ROOT,
      version: PACKAGE.version,
      noUpdateCheck: flags.has('--no-update-check'),
      initial: { view: details ? 'process' : 'reading', reasoning, system: all, allExpanded: full },
    });
    return 0;
  }

  if (!command || command === 'ls' || /^\d+$/.test(command)) {
    const requested = /^\d+$/.test(command) ? Number(command) : Number(args[1]);
    ls(Number.isFinite(requested) && requested > 0 ? requested : 15);
    return process.exitCode || 0;
  }

  if (command === 'show' || command === 's') {
    show(args[1] || 'latest', { full, reasoning, all, details });
    return process.exitCode || 0;
  }

  if (command === 'watch' || command === 'w') {
    watch(args[1]);
    return 0;
  }

  console.log(USAGE);
  return 0;
}
