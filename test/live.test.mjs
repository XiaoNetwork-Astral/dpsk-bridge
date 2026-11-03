import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { runSdk, queueInput, eventsPage } from '../lib/live.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = check(); if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for fake SDK');
    await delay(10);
  }
}
class FakeChild extends EventEmitter {
  constructor() {
    super(); this.stdout = new PassThrough(); this.received = [];
    this.stdin = new Writable({ write: (chunk, encoding, done) => {
      const message = JSON.parse(chunk.toString().trim());
      queueMicrotask(() => this.receive(message)); done();
    } });
  }
  send(message) { if (!this.stdout.destroyed) this.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); }
  receive(message) {
    if (message.method === 'initialize') {
      this.initialize = message.params;
      this.send({ id: message.id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime' } } });
    } else if (message.method === 'session/prompt') {
      this.sessionId = message.params.sessionId;
      this.send({ method: 'session.event', params: { sessionId: this.sessionId, event: { type: 'turn/start', data: { turn: 1 } } } });
      this.send({ id: message.id, result: { messageId: randomUUID() } });
    } else if (message.method === 'session/wait') this.waiting = message.id;
    else if (message.method === 'shutdown') this.send({ id: message.id, result: {} });
    else if (message.method) throw new Error(`Unexpected fake SDK method ${message.method}`);
    else this.received.push(message);
  }
  ask(params = { requestId: 'q-1', sessionId: 'root-session', questions: [{ id: 'q', question: 'Continue?' }] }) {
    this.send({ id: 'ask-rpc-1', method: 'user-question/ask', params });
  }
  approval(params = { sessionId: 'root-session', toolName: 'pwsh', callId: 'call-1' }) {
    this.send({ id: 'approval-rpc-1', method: 'approval/request', params });
  }
  cancel(requestId) { this.send({ method: 'user-question.cancelled', params: { requestId, sessionId: 'root-session' } }); }
  finish() {
    assert.ok(this.waiting);
    this.send({ method: 'session.event', params: { sessionId: this.sessionId, event: { type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'RESULT: OK\nFinished.' }] } } } } });
    this.send({ method: 'session.event', params: { sessionId: this.sessionId, event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } } });
    this.send({ id: this.waiting, result: {} });
  }
}
function fixture(t, emit = () => {}, signal = null) {
  const root = fs.mkdtempSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'live-fixture-'));
  const home = path.join(root, 'home'), id = randomUUID(), dir = path.join(home, 'jobs', id);
  fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
  const job = { id, cwd: root, sdkSessionId: 'root-session', provider: 'fake', model: 'fake',
    processState: 'running', reportFile: path.join(dir, 'report.txt') };
  const save = () => fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job));
  save(); const child = new FakeChild(), controller = new AbortController();
  const task = runSdk(child, { job, dir, prompt: 'test only', save, emit, signal: signal || controller.signal }); task.catch(() => {});
  t.after(async () => {
    controller.abort(new Error('Test cleanup')); await task.catch(() => {});
    child.stdin.destroy(); child.stdout.destroy(); fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, home, dir, job, child, task };
}
function events(f) {
  const file = path.join(f.dir, 'events.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
async function settle(f) { await until(() => f.child.waiting); f.child.finish(); await f.task; }

test('advertises native host capabilities over initialize and answers a native user question', async t => {
  const f = fixture(t);
  const initialized = await until(() => f.child.initialize);
  assert.deepEqual(initialized.capabilities, { userQuestions: true });
  assert.equal(initialized.approvalRequests, true);
  f.child.ask();
  const pending = await until(() => f.job.pendingRequests[0]);
  assert.equal(pending.requestId, 'q-1');
  assert.equal(pending.method, 'user-question/ask');
  assert.ok(events(f).some(event => event.event === 'request' && event.requestId === 'q-1'));
  const inputId = queueInput(f.job, 'answer', { requestId: pending.requestId,
    answer: { answers: [{ id: 'q', selected: [], custom: 'Continue' }] } }, f.home).inputId;
  const response = await until(() => f.child.received[0]);
  assert.deepEqual(response, { jsonrpc: '2.0', id: 'ask-rpc-1', result: { answers: [{ id: 'q', selected: [], custom: 'Continue' }] } });
  const delivered = await until(() => events(f).find(event => event.event === 'input_delivered' && event.inputId === inputId));
  assert.equal(delivered.requestId, 'q-1');
  assert.deepEqual(f.job.pendingRequests, []);
  assert.equal(f.job.answeredQuestions, 1);
  await settle(f);
});

test('a native cancellation clears the request and rejects a still-queued answer', async t => {
  const f = fixture(t);
  f.child.ask({ requestId: 'q-cancel', sessionId: 'root-session', questions: [{ id: 'q', question: 'Continue?' }] });
  const pending = await until(() => f.job.pendingRequests[0]);
  const inputId = queueInput(f.job, 'answer', { requestId: pending.requestId,
    answer: { answers: [{ id: 'q', selected: [], custom: 'Continue' }] } }, f.home).inputId;
  // Hide the queued answer from the drain until the cancellation is recorded, so
  // the two orderings in the fix are deterministic rather than a 100 ms race.
  const inbox = path.join(f.dir, 'inbox'), original = fs.readdirSync; let hidden = true;
  t.mock.method(fs, 'readdirSync', function(directory, ...args) {
    if (hidden && directory === inbox) return [];
    return original.call(this, directory, ...args);
  });
  f.child.cancel(pending.requestId);
  await until(() => events(f).some(event => event.event === 'request_cancelled' && event.requestId === 'q-cancel'));
  assert.deepEqual(f.job.pendingRequests, []);
  hidden = false;
  await until(() => events(f).some(event => event.event === 'input_rejected' && event.inputId === inputId));
  assert.equal(events(f).some(event => event.event === 'input_delivered' && event.inputId === inputId), false);
  assert.deepEqual(f.job.pendingRequests, []);
  assert.deepEqual(f.child.received, []);
  await settle(f);
});

test('a native approval without a wire request id gets a stable bridge id and an outcome answer', async t => {
  const f = fixture(t);
  f.child.approval();
  const pending = await until(() => f.job.pendingRequests[0]);
  assert.equal(pending.method, 'approval/request');
  assert.match(pending.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(pending.params.requestId, pending.requestId);
  assert.equal(pending.params.toolName, 'pwsh');
  // The same id is what dsb status exposes and dsb answer accepts.
  assert.equal(f.job.pendingRequests[0].requestId, pending.requestId);
  queueInput(f.job, 'answer', { requestId: pending.requestId, answer: { outcome: 'allowed-once' } }, f.home);
  const response = await until(() => f.child.received[0]);
  assert.deepEqual(response, { jsonrpc: '2.0', id: 'approval-rpc-1', result: { outcome: 'allowed-once' } });
  await until(() => events(f).some(event => event.event === 'input_delivered' && event.requestId === pending.requestId));
  assert.deepEqual(f.job.pendingRequests, []);
  assert.equal(f.job.answeredQuestions || 0, 0);
  await settle(f);
});

test('an invalid answer is rejected before it reaches dsh and the request stays pending', async t => {
  const f = fixture(t);
  f.child.ask();
  const pending = await until(() => f.job.pendingRequests[0]);
  const rejectedId = queueInput(f.job, 'answer', { requestId: pending.requestId, answer: { answers: [] } }, f.home).inputId;
  await until(() => events(f).some(event => event.event === 'input_rejected' && event.inputId === rejectedId));
  assert.deepEqual(f.child.received, []);
  assert.deepEqual(f.job.pendingRequests.map(request => request.requestId), [pending.requestId]);
  queueInput(f.job, 'answer', { requestId: pending.requestId,
    answer: { answers: [{ id: 'q', selected: ['A'], custom: 'valid' }] } }, f.home);
  await until(() => f.child.received.length === 1);
  assert.deepEqual(f.job.pendingRequests, []);
  await settle(f);
});

test('an unsupported host request is rejected without becoming pending', async t => {
  const f = fixture(t);
  f.child.send({ id: 'other-1', method: 'tools/call', params: { name: 'x' } });
  const rejection = await until(() => f.child.received[0]);
  assert.equal(rejection.id, 'other-1');
  assert.equal(rejection.error.code, -32601);
  assert.deepEqual(f.job.pendingRequests ?? [], []);
  await settle(f);
});

test('an already aborted signal rejects the session instead of running it', async t => {
  const controller = new AbortController();
  controller.abort(new Error('Already cancelled'));
  const f = fixture(t, () => {}, controller.signal);
  await assert.rejects(f.task, /Already cancelled/);
  assert.equal(fs.existsSync(f.job.reportFile), false);
  assert.equal(f.child.waiting, undefined);
});

test('eventsPage ignores an unterminated tail and reports no more pages', async t => {
  const root = fs.mkdtempSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'events-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'events.jsonl'), job = { id: 'events-job', eventsFile: file };
  const line = event => JSON.stringify({ event }) + '\n';
  fs.writeFileSync(file, line('first') + '{"event":"partial"');
  const page = eventsPage(job);
  assert.deepEqual(page.events, [{ event: 'first' }]);
  assert.equal(page.more, false);
  assert.equal(page.cursor, Buffer.byteLength(line('first')));
  assert.deepEqual(eventsPage(job, page.cursor).events, []);
});

test('eventsPage keeps more true while complete records remain past the limit', async t => {
  const root = fs.mkdtempSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'events-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'events.jsonl'), job = { id: 'events-job', eventsFile: file };
  fs.writeFileSync(file, ['first', 'second', 'third'].map(event => JSON.stringify({ event }) + '\n').join(''));
  const page = eventsPage(job, 0, 2);
  assert.deepEqual(page.events, [{ event: 'first' }, { event: 'second' }]);
  assert.equal(page.more, true);
  const rest = eventsPage(job, page.cursor, 2);
  assert.deepEqual(rest.events, [{ event: 'third' }]);
  assert.equal(rest.more, false);
});
