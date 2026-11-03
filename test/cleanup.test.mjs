import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const windows = process.platform === 'win32';
const cleanupName = windows ? 'cleanup.ps1' : 'cleanup.sh';
const cleanupPath = path.join(repoRoot, cleanupName);

function profile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-cleanup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const home = path.join(root, 'home');
  const prefix = path.join(home, 'npm-prefix');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(prefix, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  return { root, home, prefix, bin };
}

// Keep PATH restricted to the temporary launcher directory plus the system
// tools the shell needs, so a real dsb / dsv on this machine is never found.
function environment(home, prefix, bin) {
  const pathValue = windows
    ? [bin, path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';')
    : [bin, '/usr/bin', '/bin'].join(':');
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    npm_config_prefix: prefix,
    NPM_CONFIG_PREFIX: prefix,
    NO_COLOR: '1',
    TERM: 'dumb',
    PATH: pathValue,
  };
}

function runCleanup(home, prefix, bin, args = []) {
  const env = environment(home, prefix, bin);
  if (windows) {
    // PATH is restricted above, so start Windows PowerShell by its full path.
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0',
      'powershell.exe');
    return spawnSync(powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', cleanupPath, ...args],
      { env, encoding: 'utf8', timeout: 120000, windowsHide: true });
  }
  return spawnSync('bash', [cleanupPath, ...args], { env, encoding: 'utf8', timeout: 120000 });
}

function writeSkill(directory, name) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: test skill\n---\n\nTest skill.\n`);
}

function writeShim(file, target) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/usr/bin/env node\n// ${target}\n`);
}

function writeWindowsShim(file, target) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `@ECHO off\r\nnode "%dp0%\\node_modules\\${target}" %*\r\n`);
}

function shimPath(prefix, name) {
  return windows ? path.join(prefix, `${name}.cmd`) : path.join(prefix, 'bin', name);
}

test('cleanup --help exits 0 and documents the removal rules', t => {
  const { home, prefix, bin } = profile(t);
  const result = runCleanup(home, prefix, bin, ['--help']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /cleanup\.(sh|ps1)/);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /backed up/);
  assert.match(result.stdout, /left alone/);
});

test('cleanup rejects unknown arguments', t => {
  const { home, prefix, bin } = profile(t);
  const result = runCleanup(home, prefix, bin, ['uninstall']);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /Unknown argument/);
});

test('cleanup removes confirmed skills and launchers, keeps everything else', t => {
  const { home, prefix, bin } = profile(t);
  const state = path.join(home, '.dpsk-bridge');
  const claudeSkills = path.join(home, '.claude', 'skills');
  const codexSkills = path.join(home, '.agents', 'skills');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'settings.json'), '{}\n');
  fs.writeFileSync(path.join(state, 'installed-skills.txt'), 'deepseek-delegate\n');
  fs.writeFileSync(path.join(state, 'installed-skills-codex.txt'), 'deepseek-mcp\n');
  fs.writeFileSync(path.join(state, 'install.json'), '{}\n');
  fs.writeFileSync(path.join(state, 'installed-skills.host.json'), '{}\n');
  fs.writeFileSync(path.join(state, 'installed-skills-codex.host.json'), '{}\n');
  fs.writeFileSync(path.join(state, 'installed-skills-generic-ABCDEF0123456789.txt'), 'some-skill\n');

  // Owned through the Claude manifest, owned through the allowlist, and two
  // folders that must be kept: an unrelated skill and an unconfirmed dsh-mcp.
  writeSkill(path.join(claudeSkills, 'deepseek-delegate'), 'deepseek-delegate');
  writeSkill(path.join(claudeSkills, 'dsh-mcp'), 'dsh-mcp');
  writeSkill(path.join(claudeSkills, 'notes-to-self'), 'notes-to-self');
  writeSkill(path.join(codexSkills, 'deepseek-mcp'), 'deepseek-mcp');
  writeSkill(path.join(codexSkills, 'dsh-mcp'), 'some-other-skill');
  writeSkill(path.join(home, 'other-harness', 'skills', 'deepseek-delegate'), 'deepseek-delegate');

  // The launcher on PATH points at dpsk-bridge, the prefix launcher does too,
  // and dsh must be left alone.
  if (windows) {
    writeWindowsShim(path.join(bin, 'dsb.cmd'), 'dpsk-bridge\\bin\\dsb.mjs');
    writeWindowsShim(shimPath(prefix, 'dsv'), 'dpsk-bridge\\bin\\dsv.mjs');
    fs.writeFileSync(path.join(bin, 'dsh.cmd'), '@ECHO off\r\nnode "%dp0%\\..\\.dsh\\bin\\dsv.mjs" %*\r\n');
  } else {
    writeShim(path.join(bin, 'dsb'), 'dpsk-bridge/bin/dsb.mjs');
    writeShim(shimPath(prefix, 'dsv'), 'dpsk-bridge/bin/dsv.mjs');
    fs.writeFileSync(path.join(bin, 'dsh'), '#!/usr/bin/env node\n// .dsh/bin/dsv.mjs\n');
  }

  const realHome = fs.realpathSync.native(os.homedir());
  assert.notEqual(fs.realpathSync.native(home), realHome, 'the test must use a temporary home');
  const result = runCleanup(home, prefix, bin);
  assert.equal(result.status, 0, result.stdout + result.stderr);

  for (const removed of [
    path.join(claudeSkills, 'deepseek-delegate'),
    path.join(claudeSkills, 'dsh-mcp'),
    path.join(codexSkills, 'deepseek-mcp'),
  ]) {
    assert.equal(fs.existsSync(removed), false, `${removed} must be removed`);
  }
  for (const kept of [
    path.join(claudeSkills, 'notes-to-self'),
    path.join(codexSkills, 'dsh-mcp'),
    path.join(home, 'other-harness', 'skills', 'deepseek-delegate'),
    path.join(bin, windows ? 'dsh.cmd' : 'dsh'),
    path.join(state, 'settings.json'),
    path.join(state, 'installed-skills-generic-ABCDEF0123456789.txt'),
  ]) {
    assert.equal(fs.existsSync(kept), true, `${kept} must be kept`);
  }
  for (const record of ['install.json', 'installed-skills.txt', 'installed-skills.host.json',
    'installed-skills-codex.txt', 'installed-skills-codex.host.json']) {
    assert.equal(fs.existsSync(path.join(state, record)), false, `${record} must be removed so the next install starts fresh`);
  }
  assert.equal(fs.existsSync(shimPath(bin, 'dsb')), false, 'the PATH launcher must be removed');
  assert.equal(fs.existsSync(shimPath(prefix, 'dsv')), false, 'the npm-prefix launcher must be removed');

  const backups = fs.readdirSync(path.join(state, 'backups')).filter(name => name.endsWith('.bak'));
  assert.equal(backups.length, 3, 'each removed skill folder must be backed up');
  assert.ok(backups.some(name => name.includes('deepseek-delegate')), 'the backup name must identify the skill');
  const delegateBackup = path.join(state, 'backups', backups.find(name => name.includes('deepseek-delegate')));
  assert.ok(fs.existsSync(path.join(delegateBackup, 'SKILL.md')), 'the backup must contain the skill files');

  assert.match(result.stdout, /Removed Claude skill deepseek-delegate/);
  assert.match(result.stdout, /Kept Claude skill notes-to-self/);
  assert.match(result.stdout, /SKILL\.md name does not match/);
  assert.match(result.stdout, /Left the rest of/);
  const next = result.stdout.trimEnd().split(/\r?\n/).slice(-1)[0];
  assert.match(next, /installer\.(sh|ps1)/, 'the last line must be the install command');
});

test('cleanup leaves an install with nothing to remove unchanged', t => {
  const { home, prefix, bin } = profile(t);
  const result = runCleanup(home, prefix, bin);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /No Claude skills directory/);
  assert.match(result.stdout, /No Codex skills directory/);
  assert.match(result.stdout, /No dsb or dsv launcher found/);
  assert.match(result.stdout, /Nothing was removed/);
  assert.equal(fs.existsSync(path.join(home, '.dpsk-bridge')), false, 'cleanup must not create the state directory when there is nothing to do');
});
