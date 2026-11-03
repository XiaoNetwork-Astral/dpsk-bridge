import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { createSessionStore, summarizeSession } from '../lib/viewer/store.mjs';
import { createEventReader, listSessionFiles } from '../lib/sessions.mjs';
import { styler } from '../lib/viewer/text.mjs';

const now = new Date(2026, 0, 15, 12).getTime();
let seq = 0;
const event = (type, data) => ({ type, seq: ++seq, time: now + seq, data });
const text = (value) => [{ type: 'text', text: value }];

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsv-store-'));
  t.after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  });
  return root;
}

async function until(check, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for the store to refresh');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function writeSession(
  root,
  id,
  { title, answer = `ANSWER_${id}`, extra = [], mtime = now, compressed = false } = {},
) {
  const directory = path.join(root, 'project', id);
  fs.mkdirSync(directory, { recursive: true });

  const rows = [
    { type: 'session', version: 4, id, cwd: `/work/${id}`, createdAt: now - 1000 },
    event('session/title', { title }),
    event('turn/start', { turn: 1 }),
    event('user/message', {
      source: { kind: 'user' },
      content: text(`TASK_${id}\n\n【桥接报告约定】INTERNAL`),
    }),
    ...extra,
    event('assistant/message', { turn: 1, step: 2, message: { content: text(answer) } }),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ];

  const file = path.join(directory, compressed ? 'session.v4.jsonl.zstd' : 'session.v4.jsonl');
  const body = Buffer.from(rows.map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(file, compressed ? zlib.zstdCompressSync(body) : body);
  fs.utimesSync(file, new Date(mtime), new Date(mtime));
  return file;
}

test('session summaries cache by file+mtime+size and do not reread unchanged files', async (t) => {
  const root = temporary(t);
  writeSession(root, 'alpha', { title: '优化会话查看器' });
  writeSession(root, 'beta', { title: '第二个会话' });

  const store = createSessionStore({ root, now: () => now });
  try {
    await store.init();
    const meta = store.files.find((item) => item.id === 'alpha');
    assert.ok(meta);

    const first = await store.load(meta);
    const session = store.sessions(now).find((item) => item.id === 'alpha');
    assert.equal(session.title, '优化会话查看器');
    assert.match(session.prompt, /TASK_alpha/);
    assert.doesNotMatch(session.prompt, /桥接报告约定/);

    const before = store.stats(meta.file);
    await store.load(meta);
    const after = store.stats(meta.file);
    assert.equal(after.reads, before.reads);
    assert.equal(after.version, before.version);

    const render1 = store.getRender(session, { view: 'reading', columns: 80, st: styler(false) });
    const render2 = store.getRender(session, { view: 'reading', columns: 80, st: styler(false) });
    assert.equal(render1.lines, render2.lines);
    assert.equal(store.stats(meta.file).reads, before.reads);
    assert.ok(first.events.length > 0);
  } finally {
    store.dispose();
  }
});

test('a changed file is reread incrementally and invalidates its render version', async (t) => {
  const root = temporary(t);
  const file = writeSession(root, 'live', { title: '实时会话', answer: 'FIRST' });

  const store = createSessionStore({ root, now: () => now });
  try {
    await store.init();
    const meta = store.files.find((item) => item.id === 'live');
    await store.load(meta);
    const before = store.stats(file);
    fs.appendFileSync(
      file,
      JSON.stringify(
        event('assistant/message', { turn: 1, step: 3, message: { content: text('SECOND') } }),
      ) + '\n',
    );

    const current = listSessionFiles(root).find((item) => item.id === 'live');
    await store.load(current);
    const after = store.stats(file);
    assert.ok(after.reads > before.reads);
    assert.ok(after.version > before.version);
    assert.ok(after.events > before.events);
  } finally {
    store.dispose();
  }
});

test('small tree tick discovers a new session synchronously and keeps the selected transcript', async (t) => {
  const root = temporary(t);
  writeSession(root, 'old', { title: '旧会话' });

  const store = createSessionStore({ root, now: () => now });
  try {
    await store.init();
    assert.ok(store.sessions(now).some((session) => session.id === 'old'));

    const file = writeSession(root, 'new', {
      title: '新到达的会话',
      answer: 'NEW_RESULT',
      mtime: now + 20_000,
    });

    const changed = store.tickSync(now + 5000);
    assert.equal(changed, true);
    const sessions = store.sessions(now + 5000);
    const fresh = sessions.find((session) => session.id === 'new');
    assert.ok(fresh);
    assert.equal(fresh.title, '新到达的会话');
    assert.ok(store.stats(file).loaded);

    const render = store.getRender(fresh, { view: 'reading', columns: 80, st: styler(false) });
    assert.match(render.lines.join('\n'), /NEW_RESULT/);
  } finally {
    store.dispose();
  }
});

test('empty sessions stay hidden from the TUI list', async (t) => {
  const root = temporary(t);
  writeSession(root, 'match-one', { title: '匹配一' });

  const emptyDirectory = path.join(root, 'project', 'empty');
  fs.mkdirSync(emptyDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(emptyDirectory, 'session.v4.jsonl'),
    JSON.stringify({
      type: 'session',
      version: 4,
      id: 'empty',
      cwd: '/work/empty',
      createdAt: now,
    }) + '\n',
  );

  const store = createSessionStore({ root, now: () => now });
  try {
    await store.init();
    assert.ok(store.sessions(now).some((session) => session.id === 'match-one'));
    assert.ok(!store.sessions(now).some((session) => session.id === 'empty'));
  } finally {
    store.dispose();
  }
});

test('summarizeSession strips the bridge trailer and counts tool errors consistently', () => {
  const meta = {
    file: '/tmp/s.jsonl',
    id: 's',
    version: 4,
    mtime: now,
    size: 1,
    compressed: false,
  };

  const rows = [
    event('session/title', { title: '标题\n【桥接报告约定】内部' }),
    event('turn/start', { turn: 1 }),
    event('user/message', {
      source: { kind: 'user' },
      content: text('正文\n\n【桥接报告约定】内部'),
    }),
    event('tool/call', { turn: 1, step: 1, callId: 'c', name: 'shell', arguments: '{}' }),
    event('tool/result', {
      turn: 1,
      step: 1,
      message: { role: 'tool', toolCallId: 'c', isError: true, content: text('failed') },
    }),
    event('assistant/message', { turn: 1, step: 2, message: { content: text('ok') } }),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ];

  const summary = summarizeSession(meta, rows);
  assert.equal(summary.title, '标题');
  assert.match(summary.prompt, /正文/);
  assert.equal(summary.tools, 1);
  assert.equal(summary.errors, 1);
  assert.equal(summary.state, 'done');
  assert.equal(summary.logComplete, true);

  const failed = summarizeSession(meta, [
    event('turn/start', { turn: 1 }),
    event('turn/end', { turn: 1, reason: { kind: 'error' } }),
  ]);
  assert.equal(failed.state, 'error');

  const aborted = summarizeSession(meta, [
    event('turn/start', { turn: 1 }),
    event('turn/end', { turn: 1, reason: { kind: 'aborted' } }),
  ]);
  assert.equal(aborted.state, 'aborted');
});

test('a transient read failure is retried on a later refresh while a limit failure stays terminal', async (t) => {
  const root = temporary(t);
  const file = writeSession(root, 'retry', { title: '重试会话' });
  let clock = now,
    attempts = 0;

  const retryAt = now + 10_000;
  const createReader = (pathName) => {
    const real = createEventReader(pathName);
    return {
      read() {
        attempts++;
        if (clock < retryAt) throw Object.assign(new Error('EPERM: locked'), { code: 'EPERM' });
        return real.read();
      },
    };
  };

  const store = createSessionStore({ root, now: () => clock, createReader });
  try {
    await store.init();
    store.dispose();

    const state = () => store.sessions(clock).find((session) => session.id === 'retry').state;
    assert.equal(state(), 'unreadable');
    const before = store.stats(file).reads;

    clock = retryAt + 1;
    assert.equal(store.tickSync(clock), true);
    assert.ok(store.stats(file).reads > before);
    assert.equal(store.stats(file).error, null);
    assert.equal(state(), 'done');
    assert.ok(attempts > 0);
  } finally {
    store.dispose();
  }

  let limitReads = 0;
  const permanent = createSessionStore({
    root,
    now: () => clock,
    createReader: () => ({
      read() {
        limitReads++;
        throw new Error('Session exceeds retained reader limits');
      },
    }),
  });

  try {
    await permanent.init();
    permanent.dispose();

    const reads = limitReads;
    clock += 6000;
    permanent.tickSync(clock);
    assert.equal(limitReads, reads, 'a limit error is not retried until the file changes');
    assert.equal(
      permanent.sessions(clock).find((session) => session.id === 'retry').state,
      'unreadable',
    );
  } finally {
    permanent.dispose();
  }
});

test('store loads a compressed log through the async reader and rescans a large tree asynchronously', async (t) => {
  const root = temporary(t);
  const large = writeSession(root, 'large', {
    title: '大日志',
    answer: crypto.randomBytes(500_000).toString('base64'),
    mtime: now + 1000,
    compressed: true,
  });
  assert.ok(fs.statSync(large).size > 256 * 1024);
  for (let index = 0; index < 61; index++)
    writeSession(root, `small-${index}`, { title: `小会话${index}`, mtime: now - index * 1000 });

  const store = createSessionStore({ root, now: () => now });
  try {
    await store.init();
    assert.equal(store.files.length, 60);
    const meta = store.files.find((item) => item.id === 'large');
    assert.ok(meta.size > 256 * 1024);
    const entry = await store.load(meta);
    assert.ok(entry.events.length >= 3);
    assert.equal(store.stats(meta.file).error, null);
    assert.equal(store.sessions(now).find((session) => session.id === 'large').state, 'done');

    writeSession(root, 'newest', { title: '最新会话', mtime: now + 5000 });
    store.tickSync(now + 3000);
    await until(() => store.files[0]?.id === 'newest');
  } finally {
    store.dispose();
  }
});

test('cache eviction never drops the selected transcript and evicted ones report needsLoad', async (t) => {
  const root = temporary(t);
  for (const id of ['alpha', 'beta', 'gamma'])
    writeSession(root, id, { title: `标题${id}`, answer: 'x'.repeat(4000) });

  const store = createSessionStore({ root, now: () => now, cacheBytes: 1 });
  try {
    await store.init();
    await Promise.all(store.files.map((meta) => store.load(meta)));
    store.select('beta');
    store.evict();

    const view = (id) => store.sessions(now).find((item) => item.id === id);
    const beta = store.findMeta('beta'),
      alpha = store.findMeta('alpha');

    assert.equal(store.needsLoad(beta.file), false);
    assert.ok(
      store.getRender(view('beta'), { st: styler(false) }),
      'selected transcript stays renderable',
    );

    assert.equal(store.needsLoad(alpha.file), true);
    assert.equal(view('alpha').title, '标题alpha', 'evicted sessions keep their list summary');
    assert.equal(store.getRender(view('alpha'), { st: styler(false) }), null);

    await store.load(alpha);
    assert.equal(store.needsLoad(alpha.file), false);
    assert.ok(store.getRender(view('alpha'), { st: styler(false) }), 'reloaded after eviction');
  } finally {
    store.dispose();
  }
});

test('an open session whose bridge job is no longer running shows as interrupted', async (t) => {
  const root = temporary(t),
    bridgeDir = temporary(t);
  const ids = {
    dead: '11111111-1111-4111-8111-111111111111',
    live: '22222222-2222-4222-8222-222222222222',
    plain: '33333333-3333-4333-8333-333333333333',
  };

  for (const [name, id] of Object.entries(ids)) {
    const directory = path.join(root, 'project', id);
    fs.mkdirSync(directory, { recursive: true });

    // An open turn: no turn/end, so the log alone says active (or quiet).
    const rows = [
      { type: 'session', version: 4, id, cwd: `/work/${name}`, createdAt: now - 1000 },
      event('session/title', { title: name }),
      event('turn/start', { turn: 1 }),
    ];
    fs.writeFileSync(
      path.join(directory, 'session.v4.jsonl'),
      rows.map(JSON.stringify).join('\n') + '\n',
    );
    fs.utimesSync(path.join(directory, 'session.v4.jsonl'), new Date(now), new Date(now));
  }

  const job = (id, supervisorPid) => {
    fs.mkdirSync(path.join(bridgeDir, 'jobs', id), { recursive: true });
    fs.writeFileSync(
      path.join(bridgeDir, 'jobs', id, 'job.json'),
      JSON.stringify({ version: 2, id, processState: 'running', supervisorPid }),
    );
  };
  job(ids.dead, 2147483646); // no such process
  job(ids.live, process.pid); // this test process stands in for a live supervisor

  const store = createSessionStore({ root, now: () => now, bridgeDir });
  try {
    await store.init();
    await Promise.all(store.files.map((meta) => store.load(meta)));

    const state = (name) => store.sessions(now).find((session) => session.title === name).state;
    assert.equal(state('dead'), 'interrupted');
    assert.equal(state('live'), 'active');
    assert.equal(state('plain'), 'active', 'sessions not started by dsb keep the log state');

    const meta = store.files.find((item) => item.id === ids.dead);
    assert.equal(
      summarizeSession(meta, [{ type: 'turn/start', data: { turn: 1 } }], { bridgeDir }).state,
      'interrupted',
    );
  } finally {
    store.dispose();
  }
});
