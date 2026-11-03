import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { acquireSlot } from '../lib/scheduler.mjs';

// Fixtures
const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const installer = path.join(repoRoot, 'scripts', 'installer-core.mjs');
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const skills = ['deepseek-delegate', 'deepseek-mcp'];
const officialOrigin = 'https://github.com/XiaoNetwork-Astral/dpsk-bridge.git';

function profile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  return { root, home, prefix: path.join(home, 'npm-prefix') };
}

// Redirect the user profile (install roots and state) and the npm global
// prefix, and skip every system-wide step so no test touches this machine or
// the network.
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

function runAt(core, home, args, { cwd = repoRoot, extraEnv = {} } = {}) {
  return spawnSync(process.execPath, [core, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 180000,
    env: environment(home, extraEnv),
  });
}

function run(home, args, options) {
  return runAt(installer, home, args, options);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
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

function git(cwd, args) {
  const result = spawnSync(
    'git',
    [
      '-c',
      `safe.directory=${cwd}`,
      '-c',
      'user.name=Installer test',
      '-c',
      'user.email=installer@example.invalid',
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

// A throwaway checkout shaped like dpsk-bridge 0.4.x: the core, presets and
// skills are copied so `upgrade` can fast-forward this repository, not ours.
function upgradeCheckout(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-upgrade-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const repository = path.join(base, 'repo');
  fs.mkdirSync(path.join(repository, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(repository, 'lib'), { recursive: true });

  fs.copyFileSync(installer, path.join(repository, 'scripts', 'installer-core.mjs'));
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

  const pkg = {
    name: 'dpsk-bridge',
    version: '0.4.0',
    repository: { url: `git+${officialOrigin}` },
    engines: { node: '>=24.9' },
  };
  fs.writeFileSync(path.join(repository, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

  return { base, repository, home: path.join(base, 'home') };
}

function commitVersion(repository, version, extra = {}) {
  const file = path.join(repository, 'package.json');
  const pkg = { ...readJson(file), version, ...extra };
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', version]);
}

// Installer commands
test('--help exits 0 and lists the commands and options', (t) => {
  const { home } = profile(t);
  const result = run(home, ['--help']);
  assert.equal(result.status, 0, result.stdout + result.stderr);

  for (const text of [
    'install',
    'upgrade',
    'uninstall',
    'sync',
    '--target',
    '--skills',
    '--all',
    '--help',
    'other',
  ]) {
    assert.ok(result.stdout.includes(text), `help must mention ${text}`);
  }
});

test('install auto-detects Claude, syncs skills, and writes the install record', (t) => {
  const { home } = profile(t);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const result = run(home, ['install']);
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const skillsRoot = path.join(home, '.claude', 'skills');
  assertSkills(skillsRoot, true);
  assert.ok(
    !fs.existsSync(path.join(home, '.agents', 'skills')),
    'Codex must not be installed without detection',
  );

  const state = path.join(home, '.dpsk-bridge');
  assert.match(
    fs.readFileSync(path.join(state, 'installed-skills.txt'), 'utf8'),
    /deepseek-delegate/,
  );
  const host = readJson(path.join(state, 'installed-skills.host.json'));
  assert.equal(host.target, 'Claude');
  assert.equal(fs.realpathSync.native(host.root), fs.realpathSync.native(skillsRoot));
  const record = readJson(path.join(state, 'install.json'));
  assert.equal(record.version, packageJson.version);
  assert.equal(fs.realpathSync.native(record.root), fs.realpathSync.native(repoRoot));
  assert.equal(typeof record.installedAt, 'string');
  assert.match(result.stdout, /Install record written/);

  const second = run(home, ['install']);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /Claude skills up to date/);
  const backups = fs.existsSync(path.join(state, 'backups'))
    ? fs.readdirSync(path.join(state, 'backups'))
    : [];
  assert.deepEqual(backups, [], 'a healthy re-install must not create backups');
});

test('install honors explicit case-insensitive targets and reuses the legacy Generic key', (t) => {
  const { home } = profile(t);
  const destination = path.join(home, 'custom host', 'skills');
  const key = legacyGenericKey(destination);
  const state = path.join(home, '.dpsk-bridge');
  fs.mkdirSync(state, { recursive: true });

  // A 0.4.x Generic install: manifest and host record written by scripts/install.ps1.
  fs.writeFileSync(
    path.join(state, `installed-skills-generic-${key}.txt`),
    `${skills.join(os.EOL)}${os.EOL}`,
  );
  fs.writeFileSync(
    path.join(state, `installed-skills-generic-${key}.host.json`),
    JSON.stringify({ target: 'Generic', root: destination }),
  );

  const result = run(home, [
    'install',
    '--target',
    'codex',
    '--target',
    'OTHER',
    '--skills',
    destination,
  ]);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertSkills(path.join(home, '.agents', 'skills'), true);
  assertSkills(destination, true);
  const genericManifests = fs
    .readdirSync(state)
    .filter((name) => /^installed-skills-generic-[A-F0-9]{16}\.txt$/.test(name));
  assert.deepEqual(genericManifests, [`installed-skills-generic-${key}.txt`]);
  const host = readJson(path.join(state, `installed-skills-generic-${key}.host.json`));
  assert.equal(host.target, 'other');
  assert.equal(fs.realpathSync.native(host.root), fs.realpathSync.native(destination));

  // A later run without --target must reuse both recorded hosts and stay idempotent.
  const second = run(home, ['install']);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /Codex skills up to date/);
  assert.match(second.stdout, /other skills up to date/);
});

test('default install syncs detected harnesses plus recorded other hosts', (t) => {
  const { home } = profile(t);
  const destination = path.join(home, 'custom', 'skills');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });

  const first = run(home, ['install', '--target', 'other', '--skills', destination]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const second = run(home, ['install']);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assertSkills(path.join(home, '.claude', 'skills'), true);
  assertSkills(destination, true);
  assert.match(second.stdout, /Claude skills (updated|up to date)/);
  assert.match(second.stdout, /other skills up to date/);
});

test('uninstall removes one host, keeps the other, and --all clears the rest', (t) => {
  const { home, prefix } = profile(t);
  const installed = run(home, ['install', '--target', 'Claude', '--target', 'Codex']);
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const state = path.join(home, '.dpsk-bridge');
  fs.mkdirSync(path.join(state, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(state, 'backups', 'keep-me.txt'), 'keep');
  for (const name of ['settings.json', 'release-cache.json', 'update-state.json']) {
    fs.writeFileSync(path.join(state, name), '{}\n');
  }

  const one = run(home, ['uninstall', '--target', 'Claude']);
  assert.equal(one.status, 0, one.stdout + one.stderr);
  assertSkills(path.join(home, '.claude', 'skills'), false);
  assertSkills(path.join(home, '.agents', 'skills'), true);
  assert.ok(!fs.existsSync(path.join(state, 'installed-skills.txt')));
  assert.ok(!fs.existsSync(path.join(state, 'installed-skills.host.json')));
  assert.ok(fs.existsSync(path.join(state, 'installed-skills-codex.txt')));
  assert.ok(
    fs.existsSync(path.join(state, 'install.json')),
    'another host keeps the install record',
  );
  assert.ok(fs.existsSync(path.join(state, 'backups', 'keep-me.txt')));
  assert.ok(
    !fs.existsSync(path.join(prefix, 'node_modules')),
    'uninstall must not modify the redirected global prefix',
  );
  assert.match(one.stdout, /Another host is still installed/);
  assert.ok(one.stdout.includes(repoRoot), 'uninstall prints the checkout path');

  const all = run(home, ['uninstall', '--all']);
  assert.equal(all.status, 0, all.stdout + all.stderr);
  assertSkills(path.join(home, '.agents', 'skills'), false);
  assert.deepEqual(
    fs.readdirSync(state).filter((name) => /^installed-skills.*\.txt$/.test(name)),
    [],
  );
  assert.ok(!fs.existsSync(path.join(state, 'install.json')));
  for (const name of ['backups', 'settings.json', 'release-cache.json', 'update-state.json']) {
    assert.ok(fs.existsSync(path.join(state, name)), `${name} must be preserved`);
  }
  assert.ok(fs.existsSync(path.join(state, 'backups', 'keep-me.txt')));
});

test('sync re-syncs every recorded host and repairs drifted skill files', (t) => {
  const { home } = profile(t);
  const installed = run(home, ['install', '--target', 'Claude', '--target', 'Codex']);
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const drifted = path.join(home, '.claude', 'skills', 'deepseek-delegate', 'SKILL.md');
  fs.writeFileSync(drifted, 'locally edited instructions');

  const result = run(home, ['sync']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Claude skills updated/);
  assert.match(result.stdout, /Codex skills up to date/);
  assert.match(result.stdout, /Installed host skills synchronized/);
  assert.match(fs.readFileSync(drifted, 'utf8'), /name: deepseek-delegate/);
});

// Upgrade
test('upgrade fast-forwards a 0.4.x-style install and reuses its recorded hosts', (t) => {
  const { repository, home } = upgradeCheckout(t);
  fs.mkdirSync(home, { recursive: true });
  const state = path.join(home, '.dpsk-bridge');
  const skillsRoot = path.join(home, '.claude', 'skills');
  fs.mkdirSync(state, { recursive: true });

  fs.writeFileSync(path.join(state, 'installed-skills.txt'), `${skills.join(os.EOL)}${os.EOL}`);
  fs.writeFileSync(
    path.join(state, 'installed-skills.host.json'),
    JSON.stringify({ target: 'Claude', root: skillsRoot }),
  );
  for (const name of ['settings.json', 'release-cache.json', 'update-state.json']) {
    fs.writeFileSync(path.join(state, name), '{}\n');
  }
  fs.mkdirSync(path.join(state, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(state, 'backups', 'keep-me.txt'), 'keep');

  // Simulate stale 0.4.x skill content that the upgrade must replace and prune.
  fs.mkdirSync(path.join(skillsRoot, 'deepseek-delegate', 'references'), { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, 'deepseek-delegate', 'SKILL.md'), 'old instructions');
  fs.writeFileSync(
    path.join(skillsRoot, 'deepseek-delegate', 'references', 'obsolete.md'),
    'stale instructions',
  );

  git(repository, ['init']);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', '0.4.0']);
  const oldHead = git(repository, ['rev-parse', 'HEAD']);
  commitVersion(repository, '0.5.0', { dshVersion: packageJson.dshVersion });
  git(repository, ['tag', 'v0.5.0']);
  git(repository, ['checkout', '-b', 'installed', oldHead]);
  git(repository, ['remote', 'add', 'origin', officialOrigin]);

  const core = path.join(repository, 'scripts', 'installer-core.mjs');
  const result = runAt(core, home, ['upgrade'], {
    cwd: repository,
    extraEnv: { DPSK_INSTALLER_UPGRADE_TAG: 'v0.5.0' },
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Upgraded 0\.4\.0 → 0\.5\.0/);
  assert.equal(readJson(path.join(repository, 'package.json')).version, '0.5.0');
  assert.match(
    fs.readFileSync(path.join(skillsRoot, 'deepseek-delegate', 'SKILL.md'), 'utf8'),
    /name: deepseek-delegate/,
  );
  assert.ok(
    !fs.existsSync(path.join(skillsRoot, 'deepseek-delegate', 'references', 'obsolete.md')),
  );
  assert.ok(fs.readdirSync(path.join(state, 'backups')).some((name) => name.endsWith('.bak')));
  for (const name of ['settings.json', 'release-cache.json', 'update-state.json', 'backups']) {
    assert.ok(fs.existsSync(path.join(state, name)), `${name} must be preserved`);
  }
  const record = readJson(path.join(state, 'install.json'));
  assert.equal(record.version, '0.5.0');
  assert.equal(fs.realpathSync.native(record.root), fs.realpathSync.native(repository));
});

test('upgrade waits for running bridge jobs before changing the checkout', async (t) => {
  const { repository, home } = upgradeCheckout(t);
  fs.mkdirSync(home, { recursive: true });
  git(repository, ['init']);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', '0.4.0']);
  const oldHead = git(repository, ['rev-parse', 'HEAD']);
  commitVersion(repository, '0.5.0', { dshVersion: packageJson.dshVersion });
  git(repository, ['tag', 'v0.5.0']);
  git(repository, ['checkout', '-b', 'installed', oldHead]);
  git(repository, ['remote', 'add', 'origin', officialOrigin]);

  const core = path.join(repository, 'scripts', 'installer-core.mjs');
  const slot = await acquireSlot({
    home: path.join(home, '.dsh', 'bridge'),
    id: 'running-job',
    workspace: repository,
  });

  const child = spawn(process.execPath, [core, 'upgrade'], {
    cwd: repository,
    windowsHide: true,
    env: environment(home, { DPSK_INSTALLER_UPGRADE_TAG: 'v0.5.0' }),
  });

  let stdout = '',
    stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const closed = new Promise((resolve) => child.once('close', resolve));
  const waiting = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`upgrade did not report the wait:\n${stdout}${stderr}`)),
      15000,
    );
    child.stdout.on('data', () => {
      if (!stdout.includes('Waiting for active bridge jobs before updating')) return;
      clearTimeout(timer);
      resolve();
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      reject(new Error(`upgrade exited ${code} without reporting the wait:\n${stdout}${stderr}`));
    });
  });

  let code;
  try {
    await waiting;

    assert.equal(
      readJson(path.join(repository, 'package.json')).version,
      '0.4.0',
      'the checkout must not change while an active job holds the reservation',
    );
  } finally {
    await slot.release();
    code = await closed;
  }
  assert.equal(code, 0, stdout + stderr);
  assert.match(stdout, /Upgraded 0\.4\.0 → 0\.5\.0/);
  assert.equal(readJson(path.join(repository, 'package.json')).version, '0.5.0');
});

test('upgrade refuses a dirty checkout and diverged history', async (t) => {
  await t.test('dirty', (t) => {
    const { repository, home } = upgradeCheckout(t);
    git(repository, ['init']);
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', '0.4.0']);
    fs.writeFileSync(path.join(repository, 'untracked.txt'), 'local data');

    const core = path.join(repository, 'scripts', 'installer-core.mjs');
    const result = runAt(core, home, ['upgrade'], {
      cwd: repository,
      extraEnv: { DPSK_INSTALLER_UPGRADE_TAG: 'v0.5.0' },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /local changes|untracked/);
    assert.equal(readJson(path.join(repository, 'package.json')).version, '0.4.0');
  });

  await t.test('diverged', (t) => {
    const { repository, home } = upgradeCheckout(t);
    git(repository, ['init']);
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', '0.4.0']);
    const base = git(repository, ['rev-parse', 'HEAD']);
    commitVersion(repository, '0.5.0', { dshVersion: packageJson.dshVersion });
    git(repository, ['tag', 'v0.5.0']);
    git(repository, ['checkout', '-b', 'installed', base]);
    commitVersion(repository, '0.4.1', { note: 'local divergence' });
    git(repository, ['remote', 'add', 'origin', officialOrigin]);

    const core = path.join(repository, 'scripts', 'installer-core.mjs');
    const result = runAt(core, home, ['upgrade'], {
      cwd: repository,
      extraEnv: { DPSK_INSTALLER_UPGRADE_TAG: 'v0.5.0' },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /not an ancestor|divergent/);
    assert.equal(readJson(path.join(repository, 'package.json')).version, '0.4.1');
  });
});
