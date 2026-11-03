import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const syncScript = fileURLToPath(new URL('../scripts/sync-skills.mjs', import.meta.url));
const skills = ['deepseek-delegate', 'deepseek-mcp'];

function profile(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-sync-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const state = path.join(home, '.dpsk-bridge');
  fs.mkdirSync(state, { recursive: true });
  return { home, state };
}
// sync-skills.mjs is only a thin call into installer-core.mjs, so redirect the
// user profile (records and destination roots) on every platform.
function sync(home) {
  return spawnSync(process.execPath, [syncScript], {
    encoding: 'utf8', timeout: 120000,
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      DPSK_INSTALLER_SKIP_SYSTEM: '1', NO_COLOR: '1', TERM: 'dumb',
    },
  });
}
function assertSkills(root) {
  for (const name of skills) assert.ok(fs.existsSync(path.join(root, name, 'SKILL.md')), path.join(root, name));
}

test('sync-skills executes against temporary records and handles a known and an unknown preset', t => {
  const { home, state } = profile(t);
  const claudeRoot = path.join(home, '.claude', 'skills');
  const customRoot = path.join(home, 'custom-host', 'skills');
  fs.writeFileSync(path.join(state, 'installed-skills.host.json'), JSON.stringify({ target: 'Claude', root: claudeRoot }));
  fs.writeFileSync(path.join(state, 'installed-skills-custom.host.json'), JSON.stringify({ target: 'Cursor', root: customRoot }));

  const result = sync(home);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /unknown preset "Cursor" is handled as Generic/);
  assertSkills(claudeRoot);
  assertSkills(customRoot);
  assert.ok(fs.existsSync(path.join(state, 'installed-skills.txt')));
  const genericManifests = fs.readdirSync(state).filter(name => /^installed-skills-generic-[A-Fa-f0-9]{16}\.txt$/.test(name));
  assert.equal(genericManifests.length, 1);
  assert.ok(fs.existsSync(path.join(state, genericManifests[0].replace(/\.txt$/, '.host.json'))));
});

test('sync-skills rejects a host record whose skills directory is not absolute', t => {
  const { home, state } = profile(t);
  fs.writeFileSync(path.join(state, 'installed-skills.host.json'), JSON.stringify({ target: 'Claude', root: 'relative/skills' }));
  const result = sync(home);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid host record: installed-skills\.host\.json/);
});
