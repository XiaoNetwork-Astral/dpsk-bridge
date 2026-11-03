#!/usr/bin/env node
/**
 * Cross-platform installer core for dpsk-bridge.
 *
 * This module is the only place that owns the install layout: the Git
 * checkout stays the install root (linked with `npm link`), while host skills,
 * ownership manifests and the install record live under `~/.dpsk-bridge`.
 * It intentionally imports dependency-free modules only: `install` runs before
 * the checkout's own `npm ci`, when `node_modules` may not exist yet. The
 * scheduler is imported for the same reason it is dependency-free.
 *
 * Commands: install, upgrade, uninstall, sync.
 * The thin `installer.ps1` / `installer.sh` wrappers translate the positional
 * command line (`install` / `uninstall`, optional target) into these options.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireSlot } from '../lib/scheduler.mjs';

const scriptFile = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptFile);
const checkoutRoot = path.resolve(scriptDir, '..');
const packageFile = path.join(checkoutRoot, 'package.json');
const skillsRoot = path.join(checkoutRoot, 'skill');
const presetFile = path.join(scriptDir, 'host-presets.json');
const home = os.homedir();
const stateDir = path.join(home, '.dpsk-bridge');
const backupDir = path.join(stateDir, 'backups');
const installRecordFile = path.join(stateDir, 'install.json');
const legacyStateDir = path.join(home, '.claude-deepseek-bridge');
const migrationMarker = path.join(stateDir, 'legacy-manifests-migrated');
const hostRecordPattern = /^installed-skills(?:-[A-Za-z0-9-]+)?\.host\.json$/;
const manifestPattern = /^installed-skills(?:-[A-Za-z0-9-]+)?\.txt$/;
const skillNamePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

// Tests redirect HOME/USERPROFILE and must never run npm or touch the network.
// The seam skips npm ci, the global dsh install, npm link and command checks.
const skipSystem = process.env.DPSK_INSTALLER_SKIP_SYSTEM === '1';
// Test-only seam: use an already fetched local tag instead of querying GitHub.
const upgradeTagOverride = process.env.DPSK_INSTALLER_UPGRADE_TAG;

const color = !process.env.NO_COLOR && process.stdout.isTTY && process.env.TERM !== 'dumb';
const paint = (code, text) => color ? `\x1b[${code}m${text}\x1b[0m` : String(text);
const bold = text => paint('1', text);
const dim = text => paint('2', text);
const green = text => paint('32', text);
const yellow = text => paint('33', text);
const red = text => paint('31', text);

class InstallerError extends Error {
  constructor(message, fix) {
    super(message);
    this.name = 'InstallerError';
    this.fix = fix;
  }
}

function fail(message, fix) { throw new InstallerError(message, fix); }

function step(mark, message, detail) {
  const symbol = mark === '✓' ? green('✓') : mark === '!' ? yellow('!') : red('✗');
  process.stdout.write(`  ${symbol} ${message}${detail ? ` ${dim(detail)}` : ''}\n`);
}

function reportError(error) {
  const message = error instanceof InstallerError ? error.message : (error?.message || String(error));
  process.stderr.write(`  ${red('✗')} ${message}\n`);
  if (error instanceof InstallerError && error.fix) process.stderr.write(`    ${dim(`→ ${error.fix}`)}\n`);
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function readPackage({ requireDshVersion = false } = {}) {
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8')); }
  catch (error) {
    fail(`Cannot read ${packageFile}: ${error.message}`,
      `Run the installer from a dpsk-bridge checkout (git clone https://github.com/XiaoNetwork-Astral/dpsk-bridge.git)`);
  }
  if (pkg?.name !== 'dpsk-bridge') fail(`Not a dpsk-bridge checkout: ${checkoutRoot}`,
    'Clone the official repository and run scripts/installer-core.mjs from inside it');
  if (!parseVersion(pkg.version)) fail('package.json has an invalid version',
    'Update the checkout to a published dpsk-bridge release');
  if (requireDshVersion && !parseVersion(pkg.dshVersion)) fail('package.json is missing a valid dshVersion',
    'Update the checkout to 0.5.0 or newer with: node scripts/installer-core.mjs upgrade');
  return pkg;
}

function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = versionPattern.exec(value.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [] };
}

// Semver precedence, including prerelease ordering. Returns -1, 0 or 1.
function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  if (!a || !b) fail(`Invalid version: ${!a ? left : right}`, 'Use a semantic version such as 0.5.0');
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index++) {
    const x = a.prerelease[index], y = b.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x), yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const difference = Number(x) - Number(y);
      if (difference) return difference < 0 ? -1 : 1;
    } else if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function stableTagVersion(tag) {
  if (typeof tag !== 'string' || tag.length > 200 ||
      !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(tag)) {
    fail(`Release has an invalid version tag: ${tag}`, 'Publish a stable v<major>.<minor>.<patch> GitHub Release');
  }
  const parsed = parseVersion(tag.replace(/^v/i, ''));
  if (!parsed || parsed.prerelease.length) {
    fail(`Only stable semantic-version releases can be installed: ${tag}`,
      'Publish a stable release, or install the release manually with git');
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

function canonical(value) {
  if (!value) return null;
  let resolved = path.resolve(value);
  try { resolved = fs.realpathSync.native(resolved); } catch {}
  if (process.platform === 'win32') resolved = resolved.replace(/^\\\\\?\\/, '').toLowerCase();
  return resolved;
}

function samePath(left, right) { return !!left && !!right && canonical(left) === canonical(right); }

function lstatIfExists(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function listFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  visit(directory);
  return files.sort();
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function timestamp() {
  const date = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function backupPath(source, label) {
  fs.mkdirSync(backupDir, { recursive: true });
  const suffix = `${timestamp()}-${crypto.randomBytes(4).toString('hex')}`;
  const destination = path.join(backupDir, `${String(label).replace(/[\\/:~]/g, '_')}.${suffix}.bak`);
  const stat = fs.lstatSync(source);
  if (stat.isDirectory()) fs.cpSync(source, destination, { recursive: true, force: true });
  else fs.copyFileSync(source, destination);
  return destination;
}

function hostRecordPath(manifest) { return manifest.replace(/\.txt$/, '.host.json'); }

function readManifest(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const names = [];
  for (const raw of text.split(/\r?\n/)) {
    const name = raw.trim();
    if (!name) continue;
    if (!skillNamePattern.test(name)) {
      fail(`Invalid skill name in ${file}: ${name}`, `Fix or delete the manifest: ${file}`);
    }
    names.push(name);
  }
  return names;
}

function writeManifest(file, names) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const wanted = `${names.join(os.EOL)}${os.EOL}`;
  let current = null;
  try { current = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current !== wanted) fs.writeFileSync(file, wanted);
}

function listManifests() {
  let names;
  try { names = fs.readdirSync(stateDir); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.filter(name => manifestPattern.test(name)).sort().map(name => path.join(stateDir, name));
}

// ---------------------------------------------------------------------------
// Presets, other keys and host records
// ---------------------------------------------------------------------------

function loadPresets() {
  let presets;
  try { presets = JSON.parse(fs.readFileSync(presetFile, 'utf8')); }
  catch (error) { fail(`Missing or invalid host preset list: ${presetFile}`, `Restore scripts/host-presets.json (${error.message})`); }
  const names = Object.keys(presets);
  if (!names.length) fail(`Host preset list is empty: ${presetFile}`, 'Restore scripts/host-presets.json from the repository');
  for (const name of names) {
    const preset = presets[name];
    if (!preset || typeof preset.manifest !== 'string' || !/^installed-skills(?:-[A-Za-z0-9-]+)?\.txt$/.test(preset.manifest.replace('{key}', '0123456789ABCDEF'))) {
      fail(`Host preset ${name} has an invalid manifest name`, `Fix scripts/host-presets.json`);
    }
    if (preset.skills !== null && typeof preset.skills !== 'string') {
      fail(`Host preset ${name} has an invalid skills directory`, `Fix scripts/host-presets.json`);
    }
  }
  return presets;
}

const presets = loadPresets();
const presetNames = Object.keys(presets);
const fallbackPreset = presetNames.find(name => !presets[name].skills);
if (!fallbackPreset) fail('Host preset list has no fallback preset',
  'Restore scripts/host-presets.json with an "other" entry');

function presetName(value) {
  const text = String(value ?? '').toLowerCase();
  // "Generic" was the pre-0.6 name of the fallback preset; keep accepting it so
  // old scripts and records keep working while every message says "other".
  const key = presetNames.find(name => name.toLowerCase() === text) ||
    (text === 'generic' ? fallbackPreset : null);
  if (!key) {
    fail(`Unknown target "${value}"; available presets: ${presetNames.join(', ')}`,
      `Use --target Claude, --target Codex, or --target ${fallbackPreset} --skills <absolute-directory>`);
  }
  return key;
}

// The old PowerShell installer keyed Generic manifests by this exact value:
// SHA-256 over the lower-cased absolute path without a trailing separator,
// first 16 hex characters, upper case. The key formula is kept unchanged so
// pre-0.6 manifests are reused rather than duplicated.
function genericKey(directory) {
  let absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  while (absolute.length > root.length && (absolute.endsWith(path.sep) || absolute.endsWith('/') || absolute.endsWith('\\'))) {
    absolute = absolute.slice(0, -1);
  }
  return crypto.createHash('sha256').update(absolute.toLowerCase(), 'utf8').digest('hex').slice(0, 16).toUpperCase();
}

function defaultRoot(preset) { return path.join(home, presets[preset].skills); }

function buildHost(preset, root) {
  if (!presets[preset].skills && !path.isAbsolute(root)) {
    fail(`The ${preset} preset requires an absolute skills directory; found ${root}`,
      'Pass --skills <absolute-directory> (for example ~/host/skills)');
  }
  const resolved = path.resolve(root);
  const manifestName = presets[preset].skills ? presets[preset].manifest
    : presets[preset].manifest.replace('{key}', genericKey(resolved));
  return { target: preset, root: resolved, manifest: path.join(stateDir, manifestName) };
}

function readHostRecords() {
  let names;
  try { names = fs.readdirSync(stateDir); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const records = [];
  for (const name of names.filter(entry => hostRecordPattern.test(entry)).sort()) {
    const file = path.join(stateDir, name);
    let record;
    try { record = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { fail(`Invalid host record: ${name}`, `Fix or delete ${file} (${error.message})`); }
    if (typeof record.root !== 'string' || !path.isAbsolute(record.root)) {
      fail(`Invalid host record: ${name}`, `Fix the "root" in ${file} to an absolute skills directory`);
    }
    const requested = typeof record.target === 'string' ? record.target : '';
    let known = presetNames.find(preset => preset.toLowerCase() === requested.toLowerCase());
    // Pre-0.6 records used "Generic"; treat them as the fallback preset without
    // reporting an unknown preset.
    if (!known && requested.toLowerCase() === 'generic') known = fallbackPreset;
    records.push({ file, requested, target: known ?? fallbackPreset, unknown: !known, root: path.resolve(record.root),
      manifest: path.join(stateDir, name.replace(/\.host\.json$/, '.txt')) });
  }
  return records;
}

function dedupeHosts(hosts) {
  const seen = [];
  for (const host of hosts) {
    if (seen.some(other => samePath(other.manifest, host.manifest))) continue;
    seen.push(host);
  }
  return seen;
}

function chooseHosts({ targets = [], skillsDir = null } = {}) {
  const notices = [];
  const requested = [...new Set(targets.map(presetName))];
  if (skillsDir && !requested.includes(fallbackPreset)) {
    fail(`--skills is only valid with --target ${fallbackPreset}`,
      `Drop --skills or add --target ${fallbackPreset}`);
  }
  if (requested.includes(fallbackPreset)) {
    if (!skillsDir) fail(`${fallbackPreset} requires an absolute --skills`,
      'Add --skills <absolute-directory>');
    if (!path.isAbsolute(skillsDir)) fail(`--skills must be an absolute path; found ${skillsDir}`,
      'Pass the full path, for example ~/.config/host/skills');
  }
  if (requested.length) {
    return { hosts: dedupeHosts(requested.map(preset => buildHost(preset,
      preset === fallbackPreset ? skillsDir : defaultRoot(preset)))), notices };
  }
  // Default install: every recorded harness plus every newly detected one.
  const records = readHostRecords();
  for (const record of records) {
    if (record.unknown) {
      notices.push(`Synchronizing ${path.basename(record.file)}: unknown preset ${JSON.stringify(record.requested)} ` +
        `is handled as ${fallbackPreset} at ${record.root}.`);
    }
  }
  const hosts = records.map(record => buildHost(record.target, record.root));
  const detected = [];
  if (fs.existsSync(path.join(home, '.claude'))) detected.push('Claude');
  if (fs.existsSync(path.join(home, '.agents')) || fs.existsSync(path.join(home, '.codex'))) detected.push('Codex');
  for (const preset of detected) {
    const root = defaultRoot(preset);
    if (hosts.some(host => host.target === preset || samePath(host.root, root))) continue;
    hosts.push(buildHost(preset, root));
  }
  return { hosts: dedupeHosts(hosts), notices };
}

// ---------------------------------------------------------------------------
// Skill path safety
// ---------------------------------------------------------------------------

function assertInside(root, destination) {
  const relative = path.relative(path.resolve(root), path.resolve(destination));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`Skill path escapes destination: ${destination}`, 'Use a skills directory that contains only managed skill folders');
  }
}

function assertNoLinkAncestors(root, destination) {
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, path.resolve(destination));
  let current = resolvedRoot;
  const stat = lstatIfExists(current);
  if (stat?.isSymbolicLink()) fail(`Linked skill path needs manual handling: ${current}`,
    'Replace the link with a real directory, then re-run');
  if (stat && !stat.isDirectory()) fail(`Skills path is not a directory: ${current}`, 'Choose a directory path');
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const entry = lstatIfExists(current);
    if (!entry) break;
    if (entry.isSymbolicLink()) fail(`Linked skill path needs manual handling: ${current}`,
      'Replace the link with a real directory, then re-run');
  }
}

function assertNoLinksInTree(directory) {
  const stat = lstatIfExists(directory);
  if (!stat) return;
  if (stat.isSymbolicLink()) fail(`Linked skill content needs manual handling: ${directory}`,
    'Replace the link with a real file or directory, then re-run');
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) fail(`Linked skill content needs manual handling: ${full}`,
      'Replace the link with a real file or directory, then re-run');
    if (entry.isDirectory()) assertNoLinksInTree(full);
  }
}

function assertSafePath(root, destination) {
  assertInside(root, destination);
  assertNoLinkAncestors(root, destination);
  assertNoLinksInTree(destination);
}

// ---------------------------------------------------------------------------
// Repository skills and synchronization
// ---------------------------------------------------------------------------

function repositorySkills() {
  let names;
  try { names = fs.readdirSync(skillsRoot, { withFileTypes: true }); }
  catch (error) { fail(`Cannot read ${skillsRoot}: ${error.message}`, 'Restore the skill/ directory (git checkout -- skill)'); }
  const found = names.filter(entry => entry.isDirectory() && fs.existsSync(path.join(skillsRoot, entry.name, 'SKILL.md')))
    .map(entry => entry.name).sort();
  if (!found.length) fail('No skills found in this checkout', 'Restore the skill/ directory (git checkout -- skill)');
  return found;
}

function syncHosts(hosts) {
  const names = repositorySkills();
  let totalChanged = 0, totalBackups = 0;
  for (const host of hosts) {
    assertNoLinkAncestors(host.root, host.root);
    fs.mkdirSync(host.root, { recursive: true });
    const previous = readManifest(host.manifest);
    let changed = 0, backups = 0;
    const backup = (source, label) => { backups++; return backupPath(source, label); };
    for (const skill of names) {
      const sourceDirectory = path.join(skillsRoot, skill);
      const destinationDirectory = path.join(host.root, skill);
      assertSafePath(host.root, destinationDirectory);
      for (const sourceFile of listFiles(sourceDirectory)) {
        const relative = path.relative(sourceDirectory, sourceFile);
        const destinationFile = path.join(destinationDirectory, relative);
        assertInside(host.root, destinationFile);
        if (fs.existsSync(destinationFile)) {
          const sourceBytes = fs.readFileSync(sourceFile);
          const destinationBytes = fs.readFileSync(destinationFile);
          if (sourceBytes.equals(destinationBytes)) continue;
          backup(destinationFile, `${host.target}/${skill}/${relative}`);
          fs.copyFileSync(sourceFile, destinationFile);
        } else {
          fs.mkdirSync(path.dirname(destinationFile), { recursive: true });
          fs.copyFileSync(sourceFile, destinationFile);
        }
        changed++;
      }
      for (const destinationFile of listFiles(destinationDirectory)) {
        const relative = path.relative(destinationDirectory, destinationFile);
        if (fs.existsSync(path.join(sourceDirectory, relative))) continue;
        backup(destinationFile, `${host.target}/${skill}/${relative}`);
        fs.rmSync(destinationFile, { force: true });
        changed++;
      }
    }
    for (const old of previous) {
      if (names.includes(old)) continue;
      const destination = path.join(host.root, old);
      assertSafePath(host.root, destination);
      if (!fs.existsSync(destination)) continue;
      backup(destination, `${host.target}-${old}`);
      fs.rmSync(destination, { recursive: true, force: true });
      changed++;
    }
    writeManifest(host.manifest, names);
    writeJson(hostRecordPath(host.manifest), { target: host.target, root: host.root });
    if (changed) {
      step('✓', `${host.target} skills updated (${changed} file${changed === 1 ? '' : 's'}, ` +
        `${backups} backup${backups === 1 ? '' : 's'})`, host.root);
    } else {
      step('✓', `${host.target} skills up to date (${names.length} skills)`, host.root);
    }
    totalChanged += changed; totalBackups += backups;
  }
  return { changed: totalChanged, backups: totalBackups };
}

// Migrate pre-0.4 ownership manifests once, exactly like the PowerShell installer.
function migrateLegacyManifests() {
  if (!fs.existsSync(legacyStateDir) || fs.existsSync(migrationMarker)) return;
  fs.mkdirSync(stateDir, { recursive: true });
  for (const name of fs.readdirSync(legacyStateDir)) {
    if (!manifestPattern.test(name)) continue;
    const target = path.join(stateDir, name);
    if (!fs.existsSync(target)) fs.copyFileSync(path.join(legacyStateDir, name), target);
  }
  fs.writeFileSync(migrationMarker, 'Legacy ownership manifests copied once. Original backups preserved.');
}

// ---------------------------------------------------------------------------
// npm, dsh and global links
// ---------------------------------------------------------------------------

function resolveNpmCli() {
  const directories = [...new Set([path.dirname(process.execPath),
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean)])];
  const candidates = [process.env.npm_execpath, ...directories.flatMap(directory => [
    path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(directory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(directory, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ])];
  for (const candidate of candidates) {
    if (!candidate || path.basename(candidate) !== 'npm-cli.js') continue;
    try { if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate); } catch {}
  }
  fail('Cannot locate npm/bin/npm-cli.js', 'Install Node.js with npm and reopen the terminal');
}

function runNpm(args, { cwd = checkoutRoot, timeoutMs = 900000, allowFailure = false } = {}) {
  const npmCli = resolveNpmCli();
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) fail(`Cannot run npm ${args[0]}: ${result.error.message}`,
    'Install Node.js with npm and reopen the terminal');
  if (!allowFailure && result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
    fail(`npm ${args[0]} failed (exit ${result.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`,
      `cd "${checkoutRoot}" && npm ${args.join(' ')}`);
  }
  return result;
}

function npmPrefix() {
  if (skipSystem) {
    const configured = process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX;
    return configured ? path.resolve(configured) : null;
  }
  const result = runNpm(['prefix', '-g'], { timeoutMs: 60000 });
  const prefix = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
  if (!prefix) fail('Cannot read the npm global prefix', 'Run: npm prefix -g');
  return path.resolve(prefix);
}

function findOnPath(name) {
  const directories = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension.toLowerCase());
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

function runShim(file, args, { timeoutMs = 60000 } = {}) {
  const options = { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 };
  if (process.platform !== 'win32') return spawnSync(file, args, options);
  const line = [file, ...args].map(value => /[\s"&|<>^]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value).join(' ');
  return spawnSync(line, { ...options, shell: true });
}

function readDshVersion() {
  const command = findOnPath('dsh');
  if (!command) return null;
  const result = runShim(command, ['--version'], { timeoutMs: 30000 });
  if (result.error || result.status !== 0) return null;
  const text = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/.exec(text);
  return match ? match[1] : null;
}

function checkNode(pkg) {
  const range = typeof pkg.engines?.node === 'string' ? pkg.engines.node : '';
  const match = />=\s*(\d+)\.(\d+)/.exec(range);
  if (!match) return;
  const required = [Number(match[1]), Number(match[2])];
  const current = process.versions.node.split('.').map(Number);
  if (current[0] < required[0] || (current[0] === required[0] && current[1] < required[1])) {
    fail(`Node.js >= ${required[0]}.${required[1]} is required; found ${process.versions.node}`,
      `Install Node.js ${required[0]}.${required[1]} or newer and reopen the terminal`);
  }
  step('✓', `Node.js ${process.versions.node}`);
}

function installDependencies() {
  if (skipSystem) return;
  const result = runNpm(['ci', '--ignore-scripts', '--no-fund', '--no-audit']);
  if (result.status !== 0) fail('Cannot install locked bridge dependencies', `cd "${checkoutRoot}" && npm ci --ignore-scripts`);
  step('✓', 'Dependencies installed');
}

function ensureDsh(minimumVersion) {
  if (skipSystem) return;
  const current = readDshVersion();
  if (current && compareVersions(current, minimumVersion) >= 0) {
    step('✓', `dsh ${current}`);
    return;
  }
  const label = current ? `Updated dsh ${current} → ${minimumVersion}` : `Installed dsh ${minimumVersion}`;
  const result = runNpm(['install', '-g', `@deepseek-ai/dsh@${minimumVersion}`, '--no-fund', '--no-audit'], { timeoutMs: 600000 });
  if (result.status !== 0) fail('Cannot install dsh', `npm install -g @deepseek-ai/dsh@${minimumVersion}`);
  const installed = readDshVersion();
  if (!installed || compareVersions(installed, minimumVersion) < 0) {
    fail(`Installed dsh ${installed || 'version is unknown'} is older than ${minimumVersion}`,
      `npm install -g @deepseek-ai/dsh@${minimumVersion}, then re-run install`);
  }
  step('✓', label, 'existing configuration and credentials preserved');
}

function linkTarget(link) {
  const stat = lstatIfExists(link);
  if (!stat) return null;
  if (!stat.isSymbolicLink()) return link;
  const target = fs.readlinkSync(link);
  return path.isAbsolute(target) ? target : path.resolve(path.dirname(link), target);
}

function launcherPath(prefix, name) {
  return process.platform === 'win32' ? path.join(prefix, `${name}.cmd`) : path.join(prefix, 'bin', name);
}

function launchersExist(prefix) {
  return fs.existsSync(launcherPath(prefix, 'dsb')) && fs.existsSync(launcherPath(prefix, 'dsv'));
}

function pathHint(prefix) {
  const directory = process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
  return process.platform === 'win32'
    ? `Add "${directory}" to PATH, then open a new terminal`
    : `export PATH="${directory}:$PATH", then open a new shell`;
}

function removeShims(prefix, names, pattern, label) {
  const directories = process.platform === 'win32' ? [prefix] : [prefix, path.join(prefix, 'bin')];
  for (const directory of directories) {
    for (const name of names) {
      const file = path.join(directory, name);
      let stat;
      try { stat = fs.lstatSync(file); } catch { continue; }
      if (!stat.isFile()) continue;
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      if (!pattern.test(text)) continue;
      backupPath(file, `${label}-${name}`);
      fs.rmSync(file, { force: true });
      step('✓', `${label === 'legacy' ? 'Removed legacy launcher' : 'Backed up old package launcher'} ${name}`);
    }
  }
}

function removeLegacyShims(prefix) {
  removeShims(prefix, ['dsv', 'dsv.cmd', 'dsv.ps1'], /\.dsh[\\/]+bin[\\/]+dsv\.mjs/, 'legacy');
}

function removeRenamedShims(prefix) {
  removeShims(prefix, ['dsb', 'dsb.cmd', 'dsb.ps1', 'dsv', 'dsv.cmd', 'dsv.ps1'],
    /node_modules[\\/]+claude-deepseek-bridge[\\/]+bin[\\/]+ds[bv]\.mjs/, 'renamed');
}

function verifyCommands(prefix, version) {
  for (const name of ['dsb', 'dsv']) {
    const shim = launcherPath(prefix, name);
    if (!fs.existsSync(shim)) {
      fail(`Missing global launcher: ${name}`, `cd "${checkoutRoot}" && npm link`);
    }
    const result = runShim(shim, ['--version'], { timeoutMs: 60000 });
    const reported = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
    if (result.error || result.status !== 0 || reported !== version) {
      step('!', `${name} does not resolve to this checkout`, `reported ${reported || 'nothing'}`);
      step('!', `${name} PATH fix`, pathHint(prefix));
      continue;
    }
    step('✓', `${name}: ${shim}`);
    const onPath = findOnPath(name);
    if (!samePath(onPath, shim)) {
      step('!', `${name} on PATH points to another installation`, pathHint(prefix));
    }
  }
}

function ensureLink(version) {
  if (skipSystem) return;
  const prefix = npmPrefix();
  if (!prefix) return;
  const link = path.join(prefix, 'node_modules', 'dpsk-bridge');
  const existing = linkTarget(link);
  removeLegacyShims(prefix);
  if (samePath(existing, checkoutRoot) && launchersExist(prefix)) {
    step('✓', 'dsb / dsv already linked to this checkout');
    verifyCommands(prefix, version);
    return;
  }
  if (existing) {
    step('!', 'Replacing the global dpsk-bridge link', `was ${existing}`);
    runNpm(['unlink', '-g', 'dpsk-bridge', '--ignore-scripts', '--no-fund', '--no-audit'],
      { timeoutMs: 120000, allowFailure: true });
    if (fs.existsSync(link)) {
      try { fs.unlinkSync(link); } catch {}
    }
  }
  removeRenamedShims(prefix);
  const result = runNpm(['link', '--offline', '--ignore-scripts', '--package-lock=false', '--no-fund', '--no-audit'],
    { timeoutMs: 300000 });
  if (result.status !== 0) fail('npm link failed', `cd "${checkoutRoot}" && npm link`);
  if (!samePath(linkTarget(link), checkoutRoot)) {
    fail('npm link did not create the expected global link', `cd "${checkoutRoot}" && npm link`);
  }
  step('✓', 'Linked dsb / dsv to this checkout', 'keep this directory in place');
  verifyCommands(prefix, version);
}

function removeGlobalLink() {
  let prefix;
  try { prefix = npmPrefix(); }
  catch (error) {
    step('!', 'Cannot read the npm global prefix; the shared commands were left in place', error.message);
    return;
  }
  if (!prefix) {
    step('!', 'System steps skipped; the global command link was left unchanged');
    return;
  }
  const link = path.join(prefix, 'node_modules', 'dpsk-bridge');
  if (samePath(linkTarget(link), checkoutRoot)) {
    if (skipSystem) {
      try { fs.unlinkSync(link); } catch { fs.rmSync(link, { recursive: true, force: true }); }
    } else {
      const result = runNpm(['unlink', '-g', 'dpsk-bridge', '--ignore-scripts', '--no-fund', '--no-audit'],
        { timeoutMs: 120000, allowFailure: true });
      if (result.status !== 0) fail('npm unlink failed', 'npm unlink -g dpsk-bridge');
    }
    step('✓', 'Removed shared dsb / dsv commands');
  } else {
    step('✓', 'No global link to this checkout; left other installations alone');
  }
  removeLegacyShims(prefix);
}

// ---------------------------------------------------------------------------
// Git upgrade helpers
// ---------------------------------------------------------------------------

function git(args, { allowFailure = false, timeoutMs = 120000 } = {}) {
  const result = spawnSync('git', ['-c', `safe.directory=${checkoutRoot}`, ...args], {
    cwd: checkoutRoot, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) fail(`Cannot run git: ${result.error.message}`, 'Install Git and reopen the terminal');
  if (!allowFailure && result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
    fail(`git ${args[0]} failed (exit ${result.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`,
      `git -C "${checkoutRoot}" ${args.join(' ')}`);
  }
  return result;
}

function repositorySlug(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/^git\+/i, '');
  const scp = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(text);
  if (scp) return `${scp[1]}/${scp[2]}`;
  try {
    const url = new URL(text);
    if (!['https:', 'ssh:'].includes(url.protocol) || url.hostname.toLowerCase() !== 'github.com' ||
        url.port || url.search || url.hash) return null;
    if (url.protocol === 'ssh:') {
      if (url.username !== 'git' || url.password) return null;
    } else if (url.username || url.password) return null;
    const match = /^\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url.pathname);
    return match ? `${match[1]}/${match[2]}` : null;
  } catch { return null; }
}

function officialRepository(pkg) {
  const value = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const slug = repositorySlug(value);
  if (!slug) fail('package.json repository must identify the official GitHub repository',
    'Restore repository.url in package.json (git checkout -- package.json)');
  return slug;
}

function assertUpgradeReady(official) {
  const status = git(['status', '--porcelain=v1', '--untracked-files=all']).stdout.trim();
  if (status) fail('Checkout has local changes or untracked files; commit or move them before upgrading',
    `git -C "${checkoutRoot}" status --short`);
  const root = git(['rev-parse', '--show-toplevel']).stdout.trim();
  if (!samePath(root, checkoutRoot)) {
    fail(`Upgrade root must be the Git checkout root: ${checkoutRoot}; git reported ${root}`,
      `cd "${checkoutRoot}" && git rev-parse --show-toplevel`);
  }
  // Read the configured URL, not the insteadOf-rewritten one, as the wrappers do.
  const origins = git(['config', '--get-all', 'remote.origin.url']).stdout.trim().split(/\r?\n/).filter(Boolean);
  if (origins.length !== 1 || !repositorySlug(origins[0]) ||
      repositorySlug(origins[0]).toLowerCase() !== official.toLowerCase()) {
    fail(`origin must point to the official ${official} repository`,
      `git -C "${checkoutRoot}" remote set-url origin https://github.com/${official}.git`);
  }
}

async function latestReleaseTag(official) {
  if (upgradeTagOverride) return upgradeTagOverride;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('GitHub release check timed out')), 8000);
  try {
    const response = await fetch(`https://api.github.com/repos/${official}/releases/latest`, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dpsk-bridge-installer' },
    });
    if (response.status === 404) fail('No published GitHub Release was found',
      'Publish a stable release, or update the checkout manually with git');
    if (!response.ok) fail(`GitHub release lookup returned HTTP ${response.status}`,
      'Check network access, then retry; or run: dsv update --check');
    const text = await response.text();
    if (Buffer.byteLength(text) > 1024 * 1024) fail('GitHub release response exceeds 1 MiB',
      'Check network access, then retry');
    const release = JSON.parse(text);
    if (release.draft !== false || release.prerelease !== false) {
      fail('GitHub did not return a stable published release', 'Wait for a stable release, or update the checkout manually with git');
    }
    return release.tag_name;
  } catch (error) {
    if (error instanceof InstallerError) throw error;
    fail(`Cannot check the latest release: ${error.message}`, 'Check network access, then retry; or run: dsv update --check');
  } finally { clearTimeout(timer); }
}

function applyLocalUpgrade(tag, target) {
  const resolved = git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], { allowFailure: true });
  if (resolved.status !== 0) {
    fail(`Release tag ${tag} is not available locally`, `git -C "${checkoutRoot}" fetch origin tag ${tag}`);
  }
  const ancestor = git(['merge-base', '--is-ancestor', 'HEAD', `refs/tags/${tag}`], { allowFailure: true });
  if (ancestor.status !== 0) {
    fail('Current HEAD is not an ancestor of the release tag; divergent history requires manual review',
      `git -C "${checkoutRoot}" log --oneline --graph --all`);
  }
  let tagged;
  try { tagged = JSON.parse(git(['show', `refs/tags/${tag}:package.json`]).stdout); }
  catch (error) {
    if (error instanceof InstallerError) throw error;
    fail(`Cannot read package.json at ${tag}`, `git -C "${checkoutRoot}" show ${tag}:package.json`);
  }
  const taggedVersion = parseVersion(tagged.version);
  if (tagged.name !== 'dpsk-bridge' || !taggedVersion ||
      compareVersions(`${taggedVersion.major}.${taggedVersion.minor}.${taggedVersion.patch}`, target) !== 0) {
    fail('Release package name or version does not match the requested bridge release',
      `git -C "${checkoutRoot}" show ${tag}:package.json`);
  }
  const merge = git(['merge', '--ff-only', `refs/tags/${tag}`], { allowFailure: true });
  if (merge.status !== 0) {
    fail('Cannot fast-forward the checkout to the release',
      `git -C "${checkoutRoot}" merge --ff-only ${tag}`);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// Same scheduler home, exclusive reservation and bounded wait as dsv update
// (lib/updater.mjs): an upgrade must not change the checkout under a running job.
const updateQueueTimeoutMs = 60000;

function schedulerHome() {
  return path.resolve(process.env.DSH_HOME || path.join(home, '.dsh'), 'bridge');
}

async function reserveUpdate() {
  const timer = setTimeout(() => step('!', 'Waiting for active bridge jobs before updating'), 1000);
  try {
    return await acquireSlot({
      home: schedulerHome(), id: `installer-update-${crypto.randomUUID()}`,
      workspace: checkoutRoot, exclusive: true, maxConcurrent: 1, queueTimeoutMs: updateQueueTimeoutMs,
    });
  } catch (error) {
    if (error?.code === 'QUEUE_TIMEOUT') {
      fail('Scheduler queue wait timed out',
        'Wait for running dsb jobs to finish (dsv lists them), then retry the upgrade');
    }
    throw error;
  } finally { clearTimeout(timer); }
}

function printHelp() {
  let version = 'unknown';
  try { version = JSON.parse(fs.readFileSync(packageFile, 'utf8')).version || version; } catch {}
  process.stdout.write(`${bold(`dpsk-bridge installer ${version}`)}

Usage:
  node scripts/installer-core.mjs <command> [options]

Commands:
  install     Install or repair this checkout: dependencies, dsh, host skills, npm link
  upgrade     Fast-forward this checkout to the latest GitHub Release, then reinstall
  uninstall   Back up and remove one host's skills, or everything with --all
  sync        Re-sync skills for every recorded host

Options:
  --target <Claude|Codex|other>  Host to install or uninstall (repeatable, case-insensitive)
  --skills <DIR>                 Absolute skills directory, only with --target other
  --all                          Uninstall every host, the command link and the install record
  -h, --help                     Show this help

Next: node scripts/installer-core.mjs install --target Claude
`);
}

function summary(hosts) {
  process.stdout.write('\n');
  if (hosts.length) {
    process.stdout.write(`${bold('Next:')} dsb run --cwd <project> --brief <file>. ` +
      `Sessions: dsv. Usage: dsb stats.\n`);
    process.stdout.write(dim('Reopen the host session if the new skills do not appear.\n'));
  } else {
    process.stdout.write(`${bold('Next:')} add a host: ` +
      `node scripts/installer-core.mjs install --target Claude|Codex|other --skills <dir>\n`);
  }
}

async function installCommand({ targets, skillsDir }) {
  const pkg = readPackage({ requireDshVersion: true });
  const version = pkg.version;
  process.stdout.write(`${bold(`dpsk-bridge ${version}`)}\n${dim(`Checkout: ${checkoutRoot}`)}\n`);
  checkNode(pkg);
  const { hosts, notices } = chooseHosts({ targets, skillsDir });
  for (const notice of notices) step('!', notice);
  migrateLegacyManifests();
  installDependencies();
  ensureDsh(pkg.dshVersion);
  if (!hosts.length) {
    step('!', 'No host detected; installed the shared commands only');
  } else {
    syncHosts(hosts);
  }
  ensureLink(version);
  writeJson(installRecordFile, { version, root: checkoutRoot, installedAt: new Date().toISOString() });
  step('✓', 'Install record written', installRecordFile);
  summary(hosts);
  return 0;
}

async function upgradeCommand({ targets, skillsDir }) {
  let pkg = readPackage();
  const from = pkg.version;
  process.stdout.write(`${bold(`dpsk-bridge ${from}`)}\n${dim(`Checkout: ${checkoutRoot}`)}\n`);
  const official = officialRepository(pkg);
  const { hosts, notices } = chooseHosts({ targets, skillsDir });
  for (const notice of notices) step('!', notice);
  assertUpgradeReady(official);
  const tag = await latestReleaseTag(official);
  const targetVersion = stableTagVersion(tag);
  // The reservation is taken only when the checkout is about to change, and is
  // held through dependency setup and skill sync, exactly like dsv update.
  let reservation = null;
  try {
    if (compareVersions(targetVersion, from) <= 0) {
      step('✓', `Already on ${from}; no upgrade needed`);
    } else {
      reservation = await reserveUpdate();
      // Another updater may have finished while this one waited for the jobs.
      const current = readPackage().version;
      if (compareVersions(targetVersion, current) <= 0) {
        step('✓', `Already on ${current}; no upgrade needed`);
      } else {
        if (!upgradeTagOverride) {
          const fetch = git(['fetch', '--no-tags', '--no-recurse-submodules', 'origin', `refs/tags/${tag}:refs/tags/${tag}`],
            { allowFailure: true });
          if (fetch.status !== 0) fail(`Cannot fetch release ${tag}`, `git -C "${checkoutRoot}" fetch origin tag ${tag}`);
        }
        applyLocalUpgrade(tag, targetVersion);
        step('✓', `Upgraded ${current} → ${targetVersion}`, tag);
      }
    }
    pkg = readPackage({ requireDshVersion: true });
    migrateLegacyManifests();
    installDependencies();
    ensureDsh(pkg.dshVersion);
    if (!hosts.length) {
      step('!', 'No host detected; installed the shared commands only');
    } else {
      syncHosts(hosts);
    }
    ensureLink(pkg.version);
    writeJson(installRecordFile, { version: pkg.version, root: checkoutRoot, installedAt: new Date().toISOString() });
    step('✓', 'Install record written', installRecordFile);
    summary(hosts);
    return 0;
  } finally {
    if (reservation) await reservation.release();
  }
}

async function uninstallCommand({ targets, all, skillsDir }) {
  const pkg = readPackage();
  process.stdout.write(`${bold(`dpsk-bridge ${pkg.version}`)}\n${dim(`Checkout: ${checkoutRoot}`)}\n`);
  if (!all && !targets.length) {
    fail('Specify a host to uninstall or use --all', `node "${scriptFile}" uninstall --all`);
  }
  const records = readHostRecords();
  const requested = [...new Set(targets.map(presetName))];
  if (skillsDir && !requested.includes(fallbackPreset)) {
    fail(`--skills is only valid with --target ${fallbackPreset}`,
      `Drop --skills or add --target ${fallbackPreset}`);
  }
  if (skillsDir && !path.isAbsolute(skillsDir)) {
    fail(`--skills must be an absolute path; found ${skillsDir}`,
      `Pass the full path to the ${fallbackPreset} skills directory`);
  }
  let hosts = [];
  if (all) {
    hosts = records.map(record => ({ target: record.target, root: record.root, manifest: record.manifest, record: record.file }));
    // Also cover manifests whose host record was deleted by hand.
    for (const preset of presetNames.filter(name => presets[name].skills)) {
      const manifest = path.join(stateDir, presets[preset].manifest);
      if (!fs.existsSync(manifest) || hosts.some(host => samePath(host.manifest, manifest))) continue;
      const host = buildHost(preset, defaultRoot(preset));
      hosts.push({ ...host, record: hostRecordPath(host.manifest) });
    }
  } else {
    for (const preset of requested) {
      if (preset === fallbackPreset) {
        if (skillsDir) {
          const host = buildHost(fallbackPreset, skillsDir);
          hosts.push({ ...host, record: hostRecordPath(host.manifest) });
          continue;
        }
        const custom = records.filter(record => record.target === fallbackPreset);
        if (custom.length !== 1) {
          fail(`${fallbackPreset} requires --skills (or use --all for every host)`,
            `node "${scriptFile}" uninstall --all`);
        }
        hosts.push({ target: fallbackPreset, root: custom[0].root, manifest: custom[0].manifest, record: custom[0].file });
      } else {
        const matching = records.filter(record => record.target === preset);
        if (matching.length) {
          for (const record of matching) hosts.push({ target: preset, root: record.root, manifest: record.manifest, record: record.file });
        } else {
          const host = buildHost(preset, defaultRoot(preset));
          hosts.push({ ...host, record: hostRecordPath(host.manifest) });
        }
      }
    }
  }
  hosts = dedupeHosts(hosts);

  // Validate every path before deleting anything, so a bad record cannot leave a half-removed host.
  const plans = hosts.map(host => ({ ...host, skills: readManifest(host.manifest) }));
  for (const plan of plans) {
    for (const name of plan.skills) assertSafePath(plan.root, path.join(plan.root, name));
  }
  for (const plan of plans) {
    let removed = 0;
    for (const name of plan.skills) {
      const destination = path.join(plan.root, name);
      if (!fs.existsSync(destination)) continue;
      const backup = backupPath(destination, `${plan.target}-${name}`);
      fs.rmSync(destination, { recursive: true, force: true });
      step('✓', `${plan.target} skill ${name} removed`, `backup: ${backup}`);
      removed++;
    }
    if (fs.existsSync(plan.manifest)) fs.rmSync(plan.manifest, { force: true });
    if (fs.existsSync(plan.record)) fs.rmSync(plan.record, { force: true });
    step(removed ? '✓' : '!', removed ? `${plan.target} skills removed` : `${plan.target} skills were not installed`, plan.root);
  }

  const remaining = listManifests().filter(file => {
    try { return readManifest(file).length > 0; } catch { return true; }
  });
  if (remaining.length && !all) {
    step('!', 'Another host is still installed; keeping the shared dsb / dsv commands and the install record');
  } else {
    removeGlobalLink();
    if (fs.existsSync(installRecordFile)) {
      fs.rmSync(installRecordFile, { force: true });
      step('✓', 'Removed the install record', installRecordFile);
    }
  }
  step('✓', 'dsh, credentials, MCP patches, job history, and state files are preserved');
  process.stdout.write(dim(`Checkout kept at ${checkoutRoot}; delete it when you no longer need it.\n`));
  return 0;
}

async function syncCommand() {
  const pkg = readPackage();
  process.stdout.write(`${bold(`dpsk-bridge ${pkg.version}`)}\n${dim(`Checkout: ${checkoutRoot}`)}\n`);
  const records = readHostRecords();
  if (!records.length) {
    step('!', 'No installed hosts recorded', `Add one with: node "${scriptFile}" install --target Claude`);
    return 0;
  }
  for (const record of records) {
    if (!record.unknown) continue;
    step('!', `Synchronizing ${path.basename(record.file)}: unknown preset ${JSON.stringify(record.requested)} ` +
      `is handled as ${fallbackPreset} at ${record.root}.`);
  }
  syncHosts(dedupeHosts(records.map(record => buildHost(record.target, record.root))));
  step('✓', 'Installed host skills synchronized');
  return 0;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

function parseArguments(argv) {
  const plan = { command: null, targets: [], skillsDir: null, all: false, help: false };
  const args = [...argv];
  while (args.length) {
    const argument = args.shift();
    if (argument === '--help' || argument === '-h') plan.help = true;
    else if (argument === '--all') plan.all = true;
    else if (argument === '--target') {
      const value = args.shift();
      if (!value) fail('--target requires a host name', 'Use --target Claude|Codex|other');
      plan.targets.push(value);
    } else if (argument.startsWith('--target=')) {
      const value = argument.slice('--target='.length);
      if (!value) fail('--target requires a host name', 'Use --target Claude|Codex|other');
      plan.targets.push(value);
    } else if (argument === '--skills' || argument === '--skills-dir') {
      const value = args.shift();
      if (!value) fail('--skills requires a directory', 'Use --skills <absolute-directory>');
      plan.skillsDir = value;
    } else if (argument.startsWith('--skills=') || argument.startsWith('--skills-dir=')) {
      const value = argument.slice(argument.indexOf('=') + 1);
      if (!value) fail('--skills requires a directory', 'Use --skills <absolute-directory>');
      plan.skillsDir = value;
    } else if (argument.startsWith('-')) {
      fail(`Unknown option: ${argument}`, 'Run: node scripts/installer-core.mjs --help');
    } else if (!plan.command) {
      plan.command = argument;
    } else {
      fail(`Unexpected argument: ${argument}`, 'Run: node scripts/installer-core.mjs --help');
    }
  }
  return plan;
}

export async function runCli(argv) {
  try {
    const plan = parseArguments(argv);
    if (plan.help) { printHelp(); return 0; }
    if (!plan.command) fail('Specify a command', 'Run: node scripts/installer-core.mjs --help');
    if (!['install', 'upgrade', 'uninstall', 'sync'].includes(plan.command)) {
      fail(`Unknown command: ${plan.command}`, 'Use install, upgrade, uninstall or sync; run --help for details');
    }
    if (plan.all && plan.command !== 'uninstall') {
      fail('--all is only valid with uninstall', `Use: node scripts/installer-core.mjs uninstall --all`);
    }
    if (plan.command === 'sync' && (plan.targets.length || plan.skillsDir || plan.all)) {
      fail('sync does not take host options; it re-syncs every recorded host', 'Run: node scripts/installer-core.mjs sync');
    }
    if (plan.command === 'install') return await installCommand(plan);
    if (plan.command === 'upgrade') return await upgradeCommand(plan);
    if (plan.command === 'uninstall') return await uninstallCommand(plan);
    return await syncCommand();
  } catch (error) {
    reportError(error);
    return 1;
  }
}

const invokedDirectly = process.argv[1] && samePath(process.argv[1], scriptFile);
if (invokedDirectly) process.exitCode = await runCli(process.argv.slice(2));
