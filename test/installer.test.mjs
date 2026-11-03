import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const installer = fileURLToPath(new URL('../scripts/install.ps1', import.meta.url));
const skills = ['deepseek-delegate', 'deepseek-mcp'];

function profile(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-install-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return home;
}
// Redirect both the user profile (install roots and state) and the npm global prefix so a test uninstall can never touch this machine.
function run(home, ...args) {
  const prefix = path.join(home, 'npm-prefix');
  fs.mkdirSync(prefix, { recursive: true });
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer, ...args], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, USERPROFILE: home, npm_config_prefix: prefix, NPM_CONFIG_PREFIX: prefix },
  });
}
function assertSkills(root, present) {
  for (const name of skills) assert.equal(fs.existsSync(path.join(root, name, 'SKILL.md')), present, path.join(root, name));
}

test('generic host synchronization backs up files, prunes removed skill files, and records only the selected host', { skip: process.platform !== 'win32' }, t => {
  const home = profile(t);
  const destination = path.join(home, 'custom-host', 'skills');
  fs.mkdirSync(path.join(destination, 'deepseek-delegate'), { recursive: true });
  fs.writeFileSync(path.join(destination, 'deepseek-delegate', 'SKILL.md'), 'previous custom content');
  fs.mkdirSync(path.join(destination, 'deepseek-delegate', 'references'), { recursive: true });
  fs.writeFileSync(path.join(destination, 'deepseek-delegate', 'references', 'obsolete.md'), 'stale instructions');
  fs.mkdirSync(path.join(destination, 'unmanaged-skill'), { recursive: true });
  fs.writeFileSync(path.join(destination, 'unmanaged-skill', 'SKILL.md'), 'unmanaged content');
  const first = run(home, '-Target', 'Generic', '-SkillsDir', destination, '-SyncOnly');
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(fs.readFileSync(path.join(destination, 'deepseek-delegate', 'SKILL.md'), 'utf8'), /name: deepseek-delegate/);
  assert.ok(fs.existsSync(path.join(destination, 'deepseek-mcp', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(destination, 'deepseek-delegate', 'references', 'troubleshooting.md')));
  assert.ok(!fs.existsSync(path.join(destination, 'deepseek-delegate', 'references', 'obsolete.md')));
  assert.equal(fs.readFileSync(path.join(destination, 'unmanaged-skill', 'SKILL.md'), 'utf8'), 'unmanaged content');
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'skills'))); assert.ok(!fs.existsSync(path.join(home, '.agents', 'skills')));
  const state = path.join(home, '.dpsk-bridge');
  const host = fs.readdirSync(state).find(name => name.endsWith('.host.json'));
  assert.equal(fs.realpathSync.native(JSON.parse(fs.readFileSync(path.join(state, host), 'utf8')).root), fs.realpathSync.native(destination));
  const backups = fs.readdirSync(path.join(state, 'backups'));
  assert.ok(backups.some(file => fs.readFileSync(path.join(state, 'backups', file), 'utf8') === 'previous custom content'));
  assert.ok(backups.some(file => fs.readFileSync(path.join(state, 'backups', file), 'utf8') === 'stale instructions'));
  const second = run(home, '-Target', 'Generic', '-SkillsDir', destination, '-SyncOnly');
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(fs.readdirSync(path.join(state, 'backups')).length, backups.length);
});

test('Claude and Codex presets install into their default directories and uninstall only their own host', { skip: process.platform !== 'win32' }, t => {
  const home = profile(t);
  const state = path.join(home, '.dpsk-bridge');
  const claude = path.join(home, '.claude', 'skills');
  const codex = path.join(home, '.agents', 'skills');

  for (const [target, root] of [['Claude', claude], ['Codex', codex]]) {
    const result = run(home, '-Target', target, '-SyncOnly');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assertSkills(root, true);
  }
  assert.ok(fs.existsSync(path.join(state, 'installed-skills.txt')));
  assert.ok(fs.existsSync(path.join(state, 'installed-skills-codex.txt')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'installed-skills.host.json'), 'utf8')).target, 'Claude');
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'installed-skills-codex.host.json'), 'utf8')).target, 'Codex');

  const claudeUninstall = run(home, '-Target', 'Claude', '-Uninstall');
  assert.equal(claudeUninstall.status, 0, claudeUninstall.stdout + claudeUninstall.stderr);
  assertSkills(claude, false);
  assertSkills(codex, true);
  assert.ok(!fs.existsSync(path.join(state, 'installed-skills.txt')));
  assert.ok(!fs.existsSync(path.join(state, 'installed-skills.host.json')));
  assert.ok(fs.existsSync(path.join(state, 'installed-skills-codex.txt')));
  assert.ok(fs.existsSync(path.join(state, 'installed-skills-codex.host.json')));
  assert.ok(!fs.existsSync(path.join(home, 'npm-prefix', 'node_modules')), 'uninstall must not modify the redirected global npm prefix');

  const codexUninstall = run(home, '-Target', 'Codex', '-Uninstall');
  assert.equal(codexUninstall.status, 0, codexUninstall.stdout + codexUninstall.stderr);
  assertSkills(codex, false);
  assert.deepEqual(fs.readdirSync(state).filter(name => /^installed-skills.*\.txt$/.test(name)), []);
});
