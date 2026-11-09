import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveOwner, ownedBy, ownerBadge, parseMsysTable } from '../lib/owner.mjs';

const STARTED = 1_700_000_000_000;

function proc(pid, ppid, name, command, startedAt = STARTED) {
  return { pid, ppid, name, command, startedAt };
}

function tableOf(...entries) {
  return new Map(entries.map((entry) => [entry.pid, entry]));
}

function winProc(pid, ppid, name, command, executablePath = '', startedAt = STARTED) {
  return { ...proc(pid, ppid, name, command, startedAt), executablePath };
}

function msysRow(pid, ppid, winpid) {
  return { pid, ppid, winpid };
}

const MSYS_DIR = 'C:\\Program Files\\Git\\usr\\bin';

const NODE_COMMAND =
  '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\U\\AppData\\Roaming\\npm\\node_modules\\dpsk-bridge\\bin\\dsb.mjs" answer abc';

const NODE_PATH = 'C:\\Program Files\\nodejs\\node.exe';

const SH_COMMAND =
  '"C:\\Program Files\\Git\\usr\\bin\\sh.exe" /c/Users/U/AppData/Roaming/npm/dsb answer abc';

const SH_PATH = 'C:\\Program Files\\Git\\usr\\bin\\sh.exe';

const BASH_COMMAND =
  '"C:\\Program Files\\Git\\bin\\..\\usr\\bin\\bash.exe" -- C:/Users/U/AppData/Local/Temp/cmd-1.sh';

const BASH_PATH = 'C:\\Program Files\\Git\\usr\\bin\\bash.exe';

const HOST_BASH_COMMAND =
  '"C:\\Program Files\\Git\\bin\\bash.exe" -- C:/Users/U/AppData/Local/Temp/cmd-1.sh';

const HOST_BASH_PATH = 'C:\\Program Files\\Git\\bin\\bash.exe';

const CLAUDE_COMMAND = '"C:\\WINDOWS\\claude.exe"';

const CLAUDE_PATH = 'C:\\WINDOWS\\claude.exe';

/** The captured Windows tree, with the node process hanging off `nodeParent`. */
function shimTable(nodeParent, extra = []) {
  return tableOf(
    winProc(51136, nodeParent, 'node.exe', NODE_COMMAND, NODE_PATH),
    ...extra,
    winProc(40144, 6156, 'bash.exe', BASH_COMMAND, BASH_PATH),
    winProc(6156, 53256, 'bash.exe', HOST_BASH_COMMAND, HOST_BASH_PATH),
    winProc(53256, 46204, 'claude.exe', CLAUDE_COMMAND, CLAUDE_PATH),
    winProc(
      46204,
      29264,
      'nu.exe',
      '"C:\\Program Files\\nu\\bin\\nu.exe"',
      'C:\\Program Files\\nu\\bin\\nu.exe',
    ),
  );
}

const MSYS_ROWS = [
  msysRow(4462, 1, 52820),
  msysRow(4463, 4462, 16776),
  msysRow(4604, 4601, 51136),
  msysRow(3903, 1, 1968),
  msysRow(4605, 1, 12068),
  msysRow(4601, 1, 40144),
];

test('a claude-code-shaped tree resolves to the host binary above the shells', () => {
  const table = tableOf(
    proc(100, 101, 'node', 'node /opt/dpsk-bridge/bin/dsb.mjs status abc'),
    proc(101, 102, 'bash', 'bash -c dsb status abc'),
    proc(102, 103, 'zsh', 'zsh'),
    proc(103, 104, 'claude', '/usr/local/bin/claude --resume'),
  );

  const owner = resolveOwner({ env: {}, pid: 100, table });

  assert.equal(owner.pid, 103);
  assert.equal(owner.label, 'claude 103');
  assert.equal(owner.startedAt, STARTED);
  assert.equal(owner.source, 'process');
  assert.match(owner.id, /^[0-9a-f]{16}$/);
});

test('a codex-shaped tree resolves to the codex process and labels its script', () => {
  const table = tableOf(
    proc(200, 201, 'node', 'node /opt/dpsk-bridge/bin/dsb.mjs status abc'),
    proc(201, 202, 'node', 'node /opt/codex/bin/codex.js --session 7'),
    proc(202, 203, 'bash', 'bash'),
    proc(203, 204, 'claude', 'claude'),
  );

  const owner = resolveOwner({ env: {}, pid: 200, table });

  assert.equal(owner.pid, 201);
  assert.equal(owner.label, 'codex (node) 201');
  assert.notEqual(owner.label, 'node 201');
  assert.equal(owner.source, 'process');
});

test('two codex sessions under one terminal resolve to different ids', () => {
  const first = resolveOwner({
    env: {},
    pid: 300,
    table: tableOf(
      proc(300, 301, 'node', 'node /opt/dpsk-bridge/bin/dsb.mjs'),
      proc(301, 302, 'node', 'node /opt/codex/bin/codex.js --session first'),
      proc(302, 303, 'bash', 'bash'),
    ),
  });
  const second = resolveOwner({
    env: {},
    pid: 310,
    table: tableOf(
      proc(310, 311, 'node', 'node /opt/dpsk-bridge/bin/dsb.mjs'),
      proc(311, 302, 'node', 'node /opt/codex/bin/codex.js --session second'),
      proc(302, 303, 'bash', 'bash'),
    ),
  });

  assert.equal(first.pid, 301);
  assert.equal(second.pid, 311);
  assert.notEqual(first.id, second.id);
});

test('an npm or npx wrapper between dsb and the host is skipped', () => {
  for (const launcher of ['npm-cli.js', 'npx-cli.js']) {
    const table = tableOf(
      proc(400, 401, 'node', 'node /opt/dpsk-bridge/bin/dsb.mjs run'),
      proc(401, 402, 'bash', 'bash'),
      proc(402, 403, 'node', `node /usr/lib/node_modules/npm/bin/${launcher} dsb run`),
      proc(403, 404, 'claude', 'claude'),
    );

    const owner = resolveOwner({ env: {}, pid: 400, table });

    assert.equal(owner.pid, 403, launcher);
    assert.equal(owner.source, 'process', launcher);
  }
});

test('a runtime with an empty command line is treated as pass-through', () => {
  for (const command of ['', '   ']) {
    const table = tableOf(
      proc(500, 501, 'node', 'node /opt/dpsk-bridge/bin/dsb.mjs'),
      proc(501, 502, 'node', command),
      proc(502, 503, 'claude', 'claude'),
    );

    const owner = resolveOwner({ env: {}, pid: 500, table });

    assert.equal(owner.pid, 502, JSON.stringify(command));
    assert.equal(owner.source, 'process', JSON.stringify(command));
  }
});

test('a tree of nothing but shells falls back to the outermost shell', () => {
  const table = tableOf(
    proc(600, 601, 'node', 'node /opt/dpsk-bridge/bin/dsb.mjs'),
    proc(601, 602, 'pwsh', 'pwsh -NoProfile'),
    proc(602, 603, 'bash', 'bash'),
  );

  const owner = resolveOwner({ env: {}, pid: 600, table });

  assert.equal(owner.pid, 602);
  assert.equal(owner.label, 'bash 602');
  assert.equal(owner.source, 'shell');
  assert.match(owner.id, /^[0-9a-f]{16}$/);
});

test('the MSYS bridge resolves an npm shim tree broken by the Git Bash exec', () => {
  const calls = [];
  const source = (dir) => {
    calls.push(dir);
    return MSYS_ROWS;
  };
  const broken = resolveOwner({
    env: {},
    pid: 51136,
    table: shimTable(2740, [winProc(2740, 11552, 'sh.exe', SH_COMMAND, SH_PATH)]),
    msysSource: source,
  });
  const intact = resolveOwner({
    env: {},
    pid: 51136,
    table: shimTable(40144),
    msysSource: () => assert.fail('the bridge must not be read for an intact chain'),
  });

  assert.deepEqual(calls, [MSYS_DIR]);
  assert.equal(broken.pid, 53256);
  assert.equal(broken.label, 'claude 53256');
  assert.equal(broken.source, 'process');
  assert.equal(broken.id, intact.id);
});

test('an intact Windows chain never reads the MSYS table', () => {
  const owner = resolveOwner({
    env: {},
    pid: 51136,
    table: shimTable(40144),
    msysSource: () => assert.fail('the bridge must not be read'),
  });

  assert.equal(owner.pid, 53256);
  assert.equal(owner.source, 'process');
});

test('a background Git Bash shim tree bridges to the same host', () => {
  const table = tableOf(
    winProc(62000, 9001, 'node.exe', NODE_COMMAND, NODE_PATH),
    winProc(9001, 7777, 'sh.exe', SH_COMMAND, SH_PATH),
    winProc(88000, 99000, 'bash.exe', HOST_BASH_COMMAND, HOST_BASH_PATH),
    winProc(99000, 1234, 'claude.exe', CLAUDE_COMMAND, CLAUDE_PATH),
  );
  const owner = resolveOwner({
    env: {},
    pid: 62000,
    table,
    msysSource: () => [msysRow(5000, 5001, 62000), msysRow(5001, 1, 88000)],
  });

  assert.equal(owner.pid, 99000);
  assert.equal(owner.label, 'claude 99000');
  assert.equal(owner.source, 'process');
});

test('a missing runtime directory leaves the outermost shell as owner', () => {
  const owner = resolveOwner({
    env: {},
    pid: 51136,
    table: shimTable(2740, [winProc(2740, 11552, 'sh.exe', 'sh answer abc')]),
    msysSource: () => assert.fail('no runtime directory means no bridge read'),
  });

  assert.equal(owner.pid, 2740);
  assert.equal(owner.label, 'sh 2740');
  assert.equal(owner.source, 'shell');
});

test('a null MSYS table leaves the outermost shell as owner', () => {
  const owner = resolveOwner({
    env: {},
    pid: 51136,
    table: shimTable(2740, [winProc(2740, 11552, 'sh.exe', SH_COMMAND, SH_PATH)]),
    msysSource: () => null,
  });

  assert.equal(owner.pid, 2740);
  assert.equal(owner.label, 'sh 2740');
  assert.equal(owner.source, 'shell');
});

test('a bridged parent missing from the Windows table falls back to the shell', () => {
  const table = tableOf(
    winProc(51136, 2740, 'node.exe', NODE_COMMAND, NODE_PATH),
    winProc(2740, 11552, 'sh.exe', SH_COMMAND, SH_PATH),
  );
  const owner = resolveOwner({
    env: {},
    pid: 51136,
    table,
    msysSource: () => MSYS_ROWS,
  });

  assert.equal(owner.pid, 2740);
  assert.equal(owner.label, 'sh 2740');
  assert.equal(owner.source, 'shell');
});

test('MSYS ps rows parse with and without a leading status flag', () => {
  const raw = [
    '      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND',
    '     4462       1    4462      52820  ?         197608 23:25:10 /usr/bin/bash',
    '  S  4604    4601    4601      51136  ?         197608 23:27:44 /c/Program Files/nodejs/node',
    '  O  4601       1    4601      40144  ?         197608 23:27:44 /usr/bin/bash',
  ].join('\n');

  assert.deepEqual(parseMsysTable(raw), [
    msysRow(4462, 1, 52820),
    msysRow(4604, 4601, 51136),
    msysRow(4601, 1, 40144),
  ]);
});

test('an unreadable process table yields an unknown owner with no id', () => {
  const owner = resolveOwner({ env: {}, pid: 600, table: new Map() });

  assert.deepEqual(owner, {
    id: null,
    label: 'unknown',
    pid: null,
    startedAt: null,
    source: 'unknown',
  });
});

test('DPSK_OWNER wins over the process walk and is stable across callers', () => {
  const table = tableOf(
    proc(700, 701, 'node', 'node /opt/dpsk-bridge/bin/dsb.mjs'),
    proc(701, 702, 'claude', 'claude'),
  );

  const owner = resolveOwner({ env: { DPSK_OWNER: '  session-abc  ' }, pid: 700, table });
  const elsewhere = resolveOwner({
    env: { DPSK_OWNER: 'session-abc' },
    pid: 990,
    table: new Map(),
  });

  assert.equal(owner.label, 'session-abc');
  assert.equal(owner.source, 'env');
  assert.equal(owner.pid, null);
  assert.equal(owner.startedAt, null);
  assert.match(owner.id, /^[0-9a-f]{16}$/);
  assert.equal(elsewhere.id, owner.id);
});

test('the owner id is stable for one host and changes with its pid or start time', () => {
  const resolve = (hostPid, startedAt) =>
    resolveOwner({
      env: {},
      pid: 800,
      table: tableOf(
        proc(800, hostPid, 'node', 'node /opt/dpsk-bridge/bin/dsb.mjs'),
        proc(hostPid, 900, 'node', 'node /opt/codex/codex.js', startedAt),
      ),
    });

  const base = resolve(801, STARTED);

  assert.equal(resolve(801, STARTED).id, base.id);
  assert.notEqual(resolve(802, STARTED).id, base.id);
  assert.notEqual(resolve(801, STARTED + 1).id, base.id);
});

test('owner badges are two stable hexadecimal characters', () => {
  const owner = resolveOwner({
    env: {},
    pid: 800,
    table: tableOf(
      proc(800, 801, 'node', 'node /opt/dpsk-bridge/bin/dsb.mjs'),
      proc(801, 900, 'claude', 'claude'),
    ),
  });
  const badge = ownerBadge(owner.id);

  assert.match(badge, /^[0-9a-f]{2}$/);
  assert.equal(badge.length, 2);
  assert.equal(ownerBadge(owner.id), badge);
  assert.equal(ownerBadge(null), '--');
});

test('ownedBy is false for a job with no recorded owner', () => {
  const owner = resolveOwner({ env: { DPSK_OWNER: 'session-a' }, pid: 1, table: new Map() });

  assert.equal(ownedBy({}, owner), false);
  assert.equal(ownedBy({ owner: {} }, owner), false);
  assert.equal(ownedBy({ owner: { id: null } }, owner), false);
  assert.equal(ownedBy({ owner: { id: owner.id } }, owner), true);
  assert.equal(ownedBy({ owner: { id: '0'.repeat(16) } }, owner), false);
});
