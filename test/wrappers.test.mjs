import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
const currentTag = `v${packageJson.version}`;

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
    return spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
      { cwd, env, encoding: 'utf8', timeout: 180000, windowsHide: true },
    );
  }
  return spawnSync('bash', [script, ...args], { cwd, env, encoding: 'utf8', timeout: 180000 });
}

function runInstaller(home, args, options) {
  return runScript(home, installerPath, args, options);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function samePath(left, right) {
  return fs.realpathSync.native(left).toLowerCase() === fs.realpathSync.native(right).toLowerCase();
}

function assertSkills(root, present) {
  for (const name of skills)
    assert.equal(fs.existsSync(path.join(root, name, 'SKILL.md')), present, path.join(root, name));
}

function legacyGenericKey(directory) {
  return crypto
    .createHash('sha256')
    .update(path.resolve(directory).toLowerCase(), 'utf8')
    .digest('hex')
    .slice(0, 16)
    .toUpperCase();
}

function output(result) {
  return result.stdout + result.stderr;
}

// Fixtures pin core.autocrlf so that line endings committed here match what
// the wrapper sees later with GIT_CONFIG_NOSYSTEM (GitHub's Windows runners set
// core.autocrlf=true in the system config).
function git(cwd, args) {
  const result = spawnSync(
    'git',
    [
      '-c',
      `safe.directory=${cwd}`,
      '-c',
      'core.autocrlf=false',
      '-c',
      'user.name=Wrapper test',
      '-c',
      'user.email=wrapper@example.invalid',
      '-c',
      'commit.gpgSign=false',
      '-c',
      'tag.gpgSign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8', windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function copyInstaller(repository) {
  fs.mkdirSync(repository, { recursive: true });
  fs.copyFileSync(installerPath, path.join(repository, installerName));
}

function copyBridge(repository) {
  copyInstaller(repository);
  fs.mkdirSync(path.join(repository, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(repository, 'lib'), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, 'scripts', 'installer-core.mjs'),
    path.join(repository, 'scripts', 'installer-core.mjs'),
  );
  fs.copyFileSync(
    path.join(repoRoot, 'scripts', 'host-presets.json'),
    path.join(repository, 'scripts', 'host-presets.json'),
  );
  fs.copyFileSync(
    path.join(repoRoot, 'lib', 'scheduler.mjs'),
    path.join(repository, 'lib', 'scheduler.mjs'),
  );
  fs.copyFileSync(
    path.join(repoRoot, 'lib', 'job-state.mjs'),
    path.join(repository, 'lib', 'job-state.mjs'),
  );
  fs.cpSync(path.join(repoRoot, 'skill'), path.join(repository, 'skill'), { recursive: true });
}

function bridgePackage(version) {
  return {
    name: 'dpsk-bridge',
    version,
    repository: { url: `git+${officialOrigin}` },
    engines: { node: '>=24.9' },
    dshVersion: packageJson.dshVersion,
  };
}

// A throwaway Git checkout of the current release, used as the found install.
function releaseCheckout(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-release-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const repository = path.join(base, 'checkout');
  copyBridge(repository);
  fs.writeFileSync(
    path.join(repository, 'package.json'),
    JSON.stringify(bridgePackage(packageJson.version), null, 2) + '\n',
  );
  git(repository, ['init']);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', packageJson.version]);
  git(repository, ['tag', currentTag]);
  git(repository, ['remote', 'add', 'origin', officialOrigin]);
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  return { base, repository, home };
}

// Keep a fresh clone local: rewrite the official URL to the fixture and make a
// failed rewrite fail fast instead of reaching GitHub.
function cloneEnvironment(base, repository, extra = {}) {
  const gitConfig = path.join(base, 'gitconfig');
  fs.writeFileSync(
    gitConfig,
    `[url "${pathToFileURL(path.join(repository, '.git')).href}"]\n\tinsteadOf = ${officialOrigin}\n` +
      '[http]\n\tproxy = http://127.0.0.1:1\n',
  );
  return {
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
}

// A throwaway 0.4.x checkout: no Node core yet, official origin, and a local
// tag that the wrapper can fetch.
function legacyCheckout(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-legacy-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const repository = path.join(base, 'checkout');
  copyInstaller(repository);
  fs.writeFileSync(
    path.join(repository, 'package.json'),
    JSON.stringify(
      {
        name: 'dpsk-bridge',
        version: '0.4.0',
        repository: { url: `git+${officialOrigin}` },
        engines: { node: '>=24.9' },
      },
      null,
      2,
    ) + '\n',
  );
  git(repository, ['init']);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', '0.4.0']);
  const oldHead = git(repository, ['rev-parse', 'HEAD']);

  copyBridge(repository);
  fs.writeFileSync(
    path.join(repository, 'package.json'),
    JSON.stringify(bridgePackage('0.5.0'), null, 2) + '\n',
  );
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', '0.5.0']);
  git(repository, ['tag', 'v0.5.0']);
  git(repository, ['checkout', '-b', 'installed', oldHead]);
  git(repository, ['remote', 'add', 'origin', officialOrigin]);

  const gitConfig = path.join(base, 'gitconfig');
  fs.writeFileSync(
    gitConfig,
    `[url "${pathToFileURL(path.join(repository, '.git')).href}"]\n\tinsteadOf = ${officialOrigin}\n` +
      '[http]\n\tproxy = http://127.0.0.1:1\n',
  );
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  return { base, repository, home, gitConfig };
}

function usageBlock(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  const start = normalized.indexOf(
    'Usage:\n  installer [install [claude|codex|other <SKILLS_DIR>]]',
  );
  const end = normalized.indexOf('Harnesses:', start);
  assert.ok(start >= 0 && end > start, 'both installers must document Usage and Harnesses');
  return normalized.slice(start, end).trim();
}

test('installer and cleanup scripts are ASCII-only where required and use LF endings', () => {
  for (const file of [psInstaller, path.join(repoRoot, 'cleanup.ps1')]) {
    const bytes = fs.readFileSync(file);
    const nonAscii = bytes.findIndex((byte) => byte > 0x7f);
    assert.equal(nonAscii, -1, `${path.basename(file)} has a non-ASCII byte at offset ${nonAscii}`);
  }
  for (const file of [shInstaller, path.join(repoRoot, 'cleanup.sh')]) {
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.indexOf(0x0d), -1, `${path.basename(file)} must use LF line endings`);
    assert.equal(
      bytes.subarray(0, 2).toString('utf8'),
      '#!',
      `${path.basename(file)} must start with a shebang`,
    );
  }
});

test('installer.sh and cleanup.sh pass bash -n', (t) => {
  if (windows) {
    t.skip('Windows has no supported bash in this test suite');
    return;
  }
  for (const file of [shInstaller, path.join(repoRoot, 'cleanup.sh')]) {
    const result = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    if (result.error) {
      t.skip(`bash is not available: ${result.error.message}`);
      return;
    }
    assert.equal(result.status, 0, result.stderr);
  }
});

test('both installers show the same usage lines and no removed options', (t) => {
  assert.equal(
    usageBlock(fs.readFileSync(psInstaller, 'utf8')),
    usageBlock(fs.readFileSync(shInstaller, 'utf8')),
  );
  for (const file of [psInstaller, shInstaller]) {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of [
      'installer [install [claude|codex|other <SKILLS_DIR>]]',
      'installer uninstall [claude|codex|other <SKILLS_DIR>]',
      'installer -h | --help',
      'No argument, or "install": install or upgrade every detected harness.',
      'With a target, only that harness. "other" needs an absolute SKILLS_DIR.',
    ]) {
      assert.ok(
        usageBlock(text).includes(line),
        `${path.basename(file)} help must include: ${line}`,
      );
    }
    assert.ok(
      !text.includes('DPSK_ACTION') && !text.includes('DPSK_TARGET'),
      `${path.basename(file)} must not use old environment variables`,
    );
  }

  const { home } = profile(t);
  const result = runInstaller(home, ['--help']);
  assert.equal(result.status, 0, output(result));
  assert.ok(result.stdout.includes('installer uninstall [claude|codex|other <SKILLS_DIR>]'));
});

test('positional parsing rejects unknown commands, targets and non-absolute skills directories', (t) => {
  const { home } = profile(t);
  const cases = [
    [['--target', 'Claude'], /Unknown command/],
    [['install', 'generic'], /Unknown target/],
    [['install', 'other'], /absolute skills directory/],
    [['install', 'other', 'relative/dir'], /must be absolute/],
    [['uninstall', 'claude', 'extra'], /Unexpected argument/],
    [['--help', 'extra'], /Help takes no arguments/],
  ];
  for (const [args, pattern] of cases) {
    const result = runInstaller(home, args);
    assert.notEqual(result.status, 0, `${args.join(' ')} must fail`);
    assert.match(output(result), pattern, args.join(' '));
  }
});

test('default install upgrades or resyncs a found Git install', (t) => {
  const { repository, home } = releaseCheckout(t);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const result = runScript(home, path.join(repository, installerName), [], {
    cwd: repository,
    extraEnv: { DPSK_INSTALLER_UPGRADE_TAG: currentTag },
  });
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /Found an existing install; upgrading or resyncing/);
  assert.match(result.stdout, /Already on/);
  assertSkills(path.join(home, '.claude', 'skills'), true);
  const record = readJson(path.join(home, '.dpsk-bridge', 'install.json'));
  assert.ok(samePath(record.root, repository), `record root ${record.root} must be ${repository}`);
});

test('default install clones the latest release when no install is found', (t) => {
  const { base, repository, home } = releaseCheckout(t);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const download = path.join(base, 'download');
  fs.mkdirSync(download, { recursive: true });
  const script = path.join(download, installerName);
  fs.copyFileSync(installerPath, script);
  const result = runScript(home, script, [], {
    cwd: download,
    extraEnv: cloneEnvironment(base, repository, { DPSK_INSTALLER_UPGRADE_TAG: currentTag }),
  });
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /No install found; cloning the latest release/);
  assert.match(result.stdout, /Cloning dpsk-bridge/);
  const checkout = path.join(home, '.dpsk-bridge', 'app');
  assert.ok(
    fs.existsSync(path.join(checkout, 'scripts', 'installer-core.mjs')),
    'the latest release must be cloned into ~/.dpsk-bridge/app',
  );
  assertSkills(path.join(home, '.claude', 'skills'), true);
  assert.ok(samePath(readJson(path.join(home, '.dpsk-bridge', 'install.json')).root, checkout));
});

test('install other <dir> installs into the custom directory', (t) => {
  const { repository, home } = releaseCheckout(t);
  const destination = path.join(home, 'custom host', 'skills');
  const result = runScript(
    home,
    path.join(repository, installerName),
    ['install', 'other', destination],
    {
      cwd: repository,
      extraEnv: { DPSK_INSTALLER_UPGRADE_TAG: currentTag },
    },
  );
  assert.equal(result.status, 0, output(result));
  assertSkills(destination, true);
  const key = legacyGenericKey(destination);
  const state = path.join(home, '.dpsk-bridge');
  assert.ok(fs.existsSync(path.join(state, `installed-skills-generic-${key}.txt`)));
  assert.equal(
    readJson(path.join(state, `installed-skills-generic-${key}.host.json`)).target,
    'other',
  );
});

test('uninstall removes one target, then everything, and keeps the checkout', (t) => {
  const { repository, home } = releaseCheckout(t);
  const script = path.join(repository, installerName);
  const options = { cwd: repository, extraEnv: { DPSK_INSTALLER_UPGRADE_TAG: currentTag } };
  const state = path.join(home, '.dpsk-bridge');

  let result = runScript(home, script, ['install', 'CLAUDE'], options);
  assert.equal(result.status, 0, output(result));
  result = runScript(home, script, ['install', 'codex'], options);
  assert.equal(result.status, 0, output(result));
  fs.writeFileSync(path.join(state, 'settings.json'), '{}\n');

  result = runScript(home, script, ['uninstall', 'claude'], options);
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /Found an existing install; uninstalling/);
  assertSkills(path.join(home, '.claude', 'skills'), false);
  assertSkills(path.join(home, '.agents', 'skills'), true);
  assert.ok(
    fs.existsSync(path.join(state, 'install.json')),
    'another host keeps the install record',
  );

  result = runScript(home, script, ['uninstall'], options);
  assert.equal(result.status, 0, output(result));
  assertSkills(path.join(home, '.agents', 'skills'), false);
  assert.ok(!fs.existsSync(path.join(state, 'install.json')));
  assert.ok(fs.existsSync(path.join(state, 'settings.json')));
  assert.match(result.stdout, /Checkout kept at/);
});

test('installer refuses a found non-Git install and points at the cleanup script', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-unpacked-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const unpacked = path.join(base, 'unpacked');
  copyBridge(unpacked);
  fs.writeFileSync(
    path.join(unpacked, 'package.json'),
    JSON.stringify(bridgePackage(packageJson.version), null, 2) + '\n',
  );
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  for (const args of [[], ['uninstall']]) {
    const result = runScript(home, path.join(unpacked, installerName), args, { cwd: unpacked });
    assert.equal(result.status, 1, output(result));
    assert.match(output(result), /not a Git checkout/);
    assert.match(output(result), /cleanup script/);
  }
});

test('default install recognizes a pre-0.6 Generic record and manifest', (t) => {
  const { repository, home } = releaseCheckout(t);
  const destination = path.join(home, 'legacy host', 'skills');
  const key = legacyGenericKey(destination);
  const state = path.join(home, '.dpsk-bridge');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(
    path.join(state, `installed-skills-generic-${key}.txt`),
    `${skills.join(os.EOL)}${os.EOL}`,
  );
  fs.writeFileSync(
    path.join(state, `installed-skills-generic-${key}.host.json`),
    JSON.stringify({ target: 'Generic', root: destination }),
  );
  const script = path.join(repository, installerName);
  const options = { cwd: repository, extraEnv: { DPSK_INSTALLER_UPGRADE_TAG: currentTag } };

  let result = runScript(home, script, [], options);
  assert.equal(result.status, 0, output(result));
  assert.doesNotMatch(result.stdout, /unknown preset/);
  assert.match(result.stdout, /other skills/);
  assertSkills(destination, true);
  assert.equal(
    readJson(path.join(state, `installed-skills-generic-${key}.host.json`)).target,
    'other',
  );
  const manifests = fs
    .readdirSync(state)
    .filter((name) => /^installed-skills-generic-[A-F0-9]{16}\.txt$/.test(name));
  assert.deepEqual(
    manifests,
    [`installed-skills-generic-${key}.txt`],
    'the pre-0.6 manifest name must be reused',
  );

  result = runScript(home, script, [], options);
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /other skills up to date/);

  result = runScript(home, script, ['uninstall', 'other', destination], options);
  assert.equal(result.status, 0, output(result));
  assertSkills(destination, false);
  assert.ok(!fs.existsSync(path.join(state, `installed-skills-generic-${key}.txt`)));
});

test('install upgrades a pre-core checkout in place before running the core', (t) => {
  const { repository, home, gitConfig } = legacyCheckout(t);
  const result = runScript(home, path.join(repository, installerName), ['install', 'claude'], {
    cwd: repository,
    extraEnv: {
      DPSK_INSTALLER_UPGRADE_TAG: 'v0.5.0',
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /Updated checkout to v0\.5\.0/);
  assert.equal(readJson(path.join(repository, 'package.json')).version, '0.5.0');
  assert.equal(fs.existsSync(path.join(repository, 'scripts', 'installer-core.mjs')), true);
  assertSkills(path.join(home, '.claude', 'skills'), true);
  assert.ok(samePath(readJson(path.join(home, '.dpsk-bridge', 'install.json')).root, repository));
});

test('installer.sh works when piped through bash -s with positional arguments', (t) => {
  if (windows) {
    t.skip('piped bash is only tested on Linux and macOS');
    return;
  }
  const { repository, home } = releaseCheckout(t);
  const state = path.join(home, '.dpsk-bridge');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(
    path.join(state, 'install.json'),
    JSON.stringify({
      version: packageJson.version,
      root: repository,
      installedAt: new Date().toISOString(),
    }),
  );
  const result = spawnSync('bash', ['-s', '--', 'install', 'claude'], {
    cwd: home,
    env: environment(home, { DPSK_INSTALLER_UPGRADE_TAG: currentTag }),
    encoding: 'utf8',
    timeout: 180000,
    input: fs.readFileSync(shInstaller, 'utf8'),
  });
  assert.equal(result.status, 0, output(result));
  assertSkills(path.join(home, '.claude', 'skills'), true);
  assert.match(result.stdout, /Using dpsk-bridge checkout/);
});
