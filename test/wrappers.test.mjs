import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const windows = process.platform === 'win32';
const installerName = windows ? 'installer.ps1' : 'installer.sh';
const installerPath = path.join(repoRoot, installerName);
const shInstaller = path.join(repoRoot, 'installer.sh');
const psInstaller = path.join(repoRoot, 'installer.ps1');
const skills = ['deepseek-delegate', 'deepseek-mcp'];
const officialOrigin = 'https://github.com/XiaoNetwork-Astral/dpsk-bridge.git';

function profile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-wrappers-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  return { root, home, prefix: path.join(home, 'npm-prefix') };
}

// Redirect the user profile (install roots, state and the Node core) and the
// npm global prefix, and skip every system-wide step so no test touches this
// machine or the network.
function environment(home, extra = {}) {
  const prefix = path.join(home, 'npm-prefix');
  fs.mkdirSync(prefix, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    npm_config_prefix: prefix,
    NPM_CONFIG_PREFIX: prefix,
    DSH_HOME: path.join(home, '.dsh'),
    DPSK_INSTALLER_SKIP_SYSTEM: '1',
    NO_COLOR: '1',
    TERM: 'dumb',
    ...extra,
  };
}

function runScript(home, script, args, { cwd = repoRoot, extraEnv = {} } = {}) {
  const env = environment(home, extraEnv);
  if (windows) {
    return spawnSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
      { cwd, env, encoding: 'utf8', timeout: 180000, windowsHide: true });
  }
  return spawnSync('bash', [script, ...args], { cwd, env, encoding: 'utf8', timeout: 180000 });
}

function runInstaller(home, args, options) { return runScript(home, installerPath, args, options); }

function actionArgs(action, extra = []) {
  return windows ? ['-Action', action, ...extra] : [action, ...extra];
}

function targetArgs(...names) {
  const args = [];
  for (const name of names) {
    if (windows) args.push('-Target', name);
    else args.push('--target', name);
  }
  return args;
}

function allArgs() { return windows ? ['-All'] : ['--all']; }

// Fixtures pin core.autocrlf so that line endings committed here match what
// the wrapper sees later with GIT_CONFIG_NOSYSTEM (GitHub's Windows runners set
// core.autocrlf=true in the system config).
function git(cwd, args) {
  const result = spawnSync('git', ['-c', `safe.directory=${cwd}`, '-c', 'core.autocrlf=false', '-c', 'user.name=Wrapper test',
    '-c', 'user.email=wrapper@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', ...args],
  { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function samePath(left, right) {
  return fs.realpathSync.native(left).toLowerCase() === fs.realpathSync.native(right).toLowerCase();
}

function assertSkills(root, present) {
  for (const name of skills) assert.equal(fs.existsSync(path.join(root, name, 'SKILL.md')), present, path.join(root, name));
}

// A throwaway 0.4.x checkout: no Node core yet, official origin, and a local
// tag that the wrapper can fetch. A url.insteadOf mapping keeps the wrapper's
// `git fetch origin` off the network.
function legacyCheckout(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-legacy-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const repository = path.join(base, 'checkout');
  fs.mkdirSync(path.join(repository, 'scripts'), { recursive: true });
  fs.copyFileSync(installerPath, path.join(repository, installerName));
  fs.writeFileSync(path.join(repository, 'package.json'), JSON.stringify({
    name: 'dpsk-bridge', version: '0.4.0', repository: { url: `git+${officialOrigin}` }, engines: { node: '>=24.9' },
  }, null, 2) + '\n');
  git(repository, ['init']);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', '0.4.0']);
  const oldHead = git(repository, ['rev-parse', 'HEAD']);

  fs.mkdirSync(path.join(repository, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'scripts', 'installer-core.mjs'), path.join(repository, 'scripts', 'installer-core.mjs'));
  fs.copyFileSync(path.join(repoRoot, 'scripts', 'host-presets.json'), path.join(repository, 'scripts', 'host-presets.json'));
  fs.copyFileSync(path.join(repoRoot, 'lib', 'scheduler.mjs'), path.join(repository, 'lib', 'scheduler.mjs'));
  fs.copyFileSync(path.join(repoRoot, 'lib', 'job-state.mjs'), path.join(repository, 'lib', 'job-state.mjs'));
  fs.cpSync(path.join(repoRoot, 'skill'), path.join(repository, 'skill'), { recursive: true });
  fs.writeFileSync(path.join(repository, 'package.json'), JSON.stringify({
    name: 'dpsk-bridge', version: '0.5.0', repository: { url: `git+${officialOrigin}` },
    engines: { node: '>=24.9' }, dshVersion: packageJson.dshVersion,
  }, null, 2) + '\n');
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', '0.5.0']);
  git(repository, ['tag', 'v0.5.0']);
  git(repository, ['checkout', '-b', 'installed', oldHead]);
  git(repository, ['remote', 'add', 'origin', officialOrigin]);

  const gitConfig = path.join(base, 'gitconfig');
  // Keep the wrapper's `git fetch origin` local; the proxy makes a failed
  // rewrite fail fast instead of reaching GitHub.
  fs.writeFileSync(gitConfig,
    `[url "${pathToFileURL(path.join(repository, '.git')).href}"]\n\tinsteadOf = ${officialOrigin}\n` +
    '[http]\n\tproxy = http://127.0.0.1:1\n');
  return { base, repository, home: path.join(base, 'home'), gitConfig };
}

test('installer.ps1 is ASCII-only and installer.sh uses LF endings', () => {
  const psBytes = fs.readFileSync(psInstaller);
  const nonAscii = psBytes.findIndex(byte => byte > 0x7f);
  assert.equal(nonAscii, -1, `installer.ps1 has a non-ASCII byte at offset ${nonAscii}`);
  const shBytes = fs.readFileSync(shInstaller);
  assert.equal(shBytes.indexOf(0x0d), -1, 'installer.sh must use LF line endings');
  assert.equal(shBytes.subarray(0, 2).toString('utf8'), '#!', 'installer.sh must start with a shebang');
});

test('installer.sh passes bash -n', t => {
  if (windows) { t.skip('Windows has no supported bash in this test suite'); return; }
  const result = spawnSync('bash', ['-n', shInstaller], { encoding: 'utf8' });
  if (result.error) { t.skip(`bash is not available: ${result.error.message}`); return; }
  assert.equal(result.status, 0, result.stderr);
});

test('help documents the actions, options and environment variables', t => {
  const { home } = profile(t);
  const result = runInstaller(home, windows ? ['-Help'] : ['--help']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const text of ['install', 'upgrade', 'uninstall', 'DPSK_ACTION', 'DPSK_TARGET',
    'DPSK_SKILLS_DIR', 'DPSK_UNINSTALL_ALL', 'DPSK_INSTALL_DIR', 'releases/latest/download']) {
    assert.ok(result.stdout.includes(text), `help must mention ${text}`);
  }
});

test('install uses the current checkout and writes the install record', t => {
  const { home } = profile(t);
  const result = runInstaller(home, actionArgs('install', targetArgs('Claude')));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertSkills(path.join(home, '.claude', 'skills'), true);
  const record = readJson(path.join(home, '.dpsk-bridge', 'install.json'));
  assert.equal(record.version, packageJson.version);
  assert.ok(samePath(record.root, repoRoot), `record root ${record.root} must be ${repoRoot}`);
  assert.match(result.stdout, /Install record written/);
  assert.ok(result.stdout.toLowerCase().includes(repoRoot.toLowerCase()),
    'the wrapper reports the checkout it used');
});

test('install accepts the environment-variable form and ignores the unused install directory', t => {
  const { home } = profile(t);
  const ignored = path.join(home, 'unused-install-dir');
  const result = runInstaller(home, [], {
    extraEnv: { DPSK_ACTION: 'install', DPSK_TARGET: 'Claude', DPSK_INSTALL_DIR: ignored },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertSkills(path.join(home, '.claude', 'skills'), true);
  assert.equal(readJson(path.join(home, '.dpsk-bridge', 'install.json')).version, packageJson.version);
  assert.equal(fs.existsSync(ignored), false, 'an existing checkout wins over DPSK_INSTALL_DIR');
});

test('installer.sh works when piped through bash -s with arguments', t => {
  if (windows) { t.skip('piped bash is only tested on Linux and macOS'); return; }
  const { home } = profile(t);
  const state = path.join(home, '.dpsk-bridge');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'install.json'), JSON.stringify({
    version: packageJson.version, root: repoRoot, installedAt: new Date().toISOString(),
  }));
  const result = spawnSync('bash', ['-s', '--', 'install', '--target', 'Claude'], {
    cwd: home, env: environment(home), encoding: 'utf8', timeout: 180000,
    input: fs.readFileSync(shInstaller, 'utf8'),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertSkills(path.join(home, '.claude', 'skills'), true);
  assert.match(result.stdout, /Using dpsk-bridge checkout/);
});

test('uninstall --all removes both hosts but preserves state', t => {
  const { home } = profile(t);
  const installed = runInstaller(home, [], {
    extraEnv: { DPSK_ACTION: 'install', DPSK_TARGET: 'Claude,Codex' },
  });
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const state = path.join(home, '.dpsk-bridge');
  fs.mkdirSync(path.join(state, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(state, 'backups', 'keep-me.txt'), 'keep');
  fs.writeFileSync(path.join(state, 'settings.json'), '{}\n');

  const result = runInstaller(home, actionArgs('uninstall', allArgs()));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertSkills(path.join(home, '.claude', 'skills'), false);
  assertSkills(path.join(home, '.agents', 'skills'), false);
  assert.equal(fs.existsSync(path.join(state, 'install.json')), false);
  assert.equal(fs.existsSync(path.join(state, 'backups', 'keep-me.txt')), true);
  assert.equal(fs.existsSync(path.join(state, 'settings.json')), true);
  assert.match(result.stdout, /Checkout kept at/);
});

test('install upgrades a pre-core checkout in place before running the core', t => {
  const { repository, home, gitConfig } = legacyCheckout(t);
  const result = runScript(home, path.join(repository, installerName),
    actionArgs('install', targetArgs('Claude')), {
      cwd: repository,
      extraEnv: { DPSK_INSTALLER_UPGRADE_TAG: 'v0.5.0', GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0' },
    });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Updated checkout to v0\.5\.0/);
  assert.equal(readJson(path.join(repository, 'package.json')).version, '0.5.0');
  assert.equal(fs.existsSync(path.join(repository, 'scripts', 'installer-core.mjs')), true);
  assertSkills(path.join(home, '.claude', 'skills'), true);
  assert.ok(samePath(readJson(path.join(home, '.dpsk-bridge', 'install.json')).root, repository));
});
