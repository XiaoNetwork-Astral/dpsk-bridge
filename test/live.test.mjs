import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import {
  runSdk,
  queueInput,
  eventsPage,
  sdkTimeouts,
  SDK_INITIALIZE_TIMEOUT_MS,
  SDK_PROMPT_TIMEOUT_MS,
  SDK_MCP_HANDSHAKE_TIMEOUT_MS,
} from '../lib/live.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for fake SDK');
    await delay(10);
  }
}

// Fake SDK child
class FakeChild extends EventEmitter {
  constructor(stall = []) {
    super();
    this.stdout = new PassThrough();
    this.received = [];

    // A stalled method is read but never answered, so a test can observe its timeout.
    this.stall = new Set(stall);

    // Only an unanswered session/wait can finish the job. Clearing the flag on
    // finish prevents a later test step from answering a stale id.
    this.waiting = null;

    this.stdin = new Writable({
      write: (chunk, encoding, done) => {
        const message = JSON.parse(chunk.toString().trim());
        queueMicrotask(() => this.receive(message));
        done();
      },
    });
  }

  send(message) {
    if (!this.stdout.destroyed)
      this.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }

  receive(message) {
    if (this.stall.has(message.method)) return;
    if (message.method === 'initialize') {
      this.initialize = message.params;
      this.send({
        id: message.id,
        result: { serverInfo: { name: 'deepseek-harness-sdk-runtime' } },
      });
    } else if (message.method === 'session/prompt') {
      this.sessionId = message.params.sessionId;
      this.send({
        method: 'session.event',
        params: { sessionId: this.sessionId, event: { type: 'turn/start', data: { turn: 1 } } },
      });
      this.send({ id: message.id, result: { messageId: randomUUID() } });
    } else if (message.method === 'session/wait') this.waiting = message.id;
    else if (message.method === 'shutdown') this.send({ id: message.id, result: {} });
    else if (message.method) throw new Error(`Unexpected fake SDK method ${message.method}`);
    else this.received.push(message);
  }

  ask(
    params = {
      requestId: 'q-1',
      sessionId: 'root-session',
      questions: [{ id: 'q', question: 'Continue?' }],
    },
  ) {
    this.send({ id: 'ask-rpc-1', method: 'user-question/ask', params });
  }

  approval(params = { sessionId: 'root-session', toolName: 'pwsh', callId: 'call-1' }) {
    this.send({ id: 'approval-rpc-1', method: 'approval/request', params });
  }

  cancel(requestId) {
    this.send({
      method: 'user-question.cancelled',
      params: { requestId, sessionId: 'root-session' },
    });
  }

  finish() {
    assert.ok(this.waiting, 'a session/wait must be pending');
    const id = this.waiting;
    this.waiting = null;

    this.send({
      method: 'session.event',
      params: {
        sessionId: this.sessionId,
        event: {
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: 'RESULT: OK\nFinished.' }] } },
        },
      },
    });
    this.send({
      method: 'session.event',
      params: {
        sessionId: this.sessionId,
        event: { type: 'turn/end', data: { reason: { kind: 'completed' } } },
      },
    });
    this.send({ id, result: {} });
  }
}

// Fixtures
function fixture(
  t,
  { emit = () => {}, signal = null, job: fields = {}, stall = [], onReady = null } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-fixture-'));
  const home = path.join(root, 'home'),
    id = randomUUID(),
    dir = path.join(home, 'jobs', id);

  fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });

  const job = {
    id,
    cwd: root,
    sdkSessionId: 'root-session',
    provider: 'fake',
    model: 'fake',
    processState: 'running',
    reportFile: path.join(dir, 'report.txt'),
    ...fields,
  };

  const save = () => fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job));
  save();

  const child = new FakeChild(stall),
    controller = new AbortController();

  const task = runSdk(child, {
    job,
    dir,
    prompt: 'test only',
    save,
    emit,
    signal: signal || controller.signal,
    onReady,
  });
  task.catch(() => {});

  t.after(async () => {
    controller.abort(new Error('Test cleanup'));
    await task.catch(() => {});
    child.stdin.destroy();
    child.stdout.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  return { root, home, dir, job, child, task };
}

function events(f) {
  const file = path.join(f.dir, 'events.jsonl');
  return fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

async function settle(f) {
  await until(() => f.child.waiting);
  f.child.finish();
  await f.task;
}

test('advertises native host capabilities over initialize and answers a native user question', async (t) => {
  const f = fixture(t);
  const initialized = await until(() => f.child.initialize);
  assert.deepEqual(initialized.capabilities, { userQuestions: true });
  assert.equal(initialized.approvalRequests, true);

  f.child.ask();
  const pending = await until(() => f.job.pendingRequests[0]);
  assert.equal(pending.requestId, 'q-1');
  assert.equal(pending.method, 'user-question/ask');
  assert.ok(events(f).some((event) => event.event === 'request' && event.requestId === 'q-1'));

  const inputId = queueInput(
    f.job,
    'answer',
    {
      requestId: pending.requestId,
      answer: { answers: [{ id: 'q', selected: [], custom: 'Continue' }] },
    },
    f.home,
  ).inputId;

  const response = await until(() => f.child.received[0]);
  assert.deepEqual(response, {
    jsonrpc: '2.0',
    id: 'ask-rpc-1',
    result: { answers: [{ id: 'q', selected: [], custom: 'Continue' }] },
  });

  const delivered = await until(() =>
    events(f).find((event) => event.event === 'input_delivered' && event.inputId === inputId),
  );
  assert.equal(delivered.requestId, 'q-1');
  assert.deepEqual(f.job.pendingRequests, []);
  assert.equal(f.job.answeredQuestions, 1);

  await settle(f);
});

test('a native cancellation clears the request and rejects a still-queued answer', async (t) => {
  const f = fixture(t);
  f.child.ask({
    requestId: 'q-cancel',
    sessionId: 'root-session',
    questions: [{ id: 'q', question: 'Continue?' }],
  });

  const pending = await until(() => f.job.pendingRequests[0]);
  const inputId = queueInput(
    f.job,
    'answer',
    {
      requestId: pending.requestId,
      answer: { answers: [{ id: 'q', selected: [], custom: 'Continue' }] },
    },
    f.home,
  ).inputId;

  // Hide the queued answer from the drain until the cancellation is recorded, so
  // the two orderings in the fix are deterministic rather than a 100 ms race.
  const inbox = path.join(f.dir, 'inbox'),
    original = fs.readdirSync;
  let hidden = true;
  t.mock.method(fs, 'readdirSync', function (directory, ...args) {
    if (hidden && directory === inbox) return [];
    return original.call(this, directory, ...args);
  });

  f.child.cancel(pending.requestId);
  await until(() =>
    events(f).some(
      (event) => event.event === 'request_cancelled' && event.requestId === 'q-cancel',
    ),
  );
  assert.deepEqual(f.job.pendingRequests, []);
  hidden = false;

  await until(() =>
    events(f).some((event) => event.event === 'input_rejected' && event.inputId === inputId),
  );
  assert.equal(
    events(f).some((event) => event.event === 'input_delivered' && event.inputId === inputId),
    false,
  );
  assert.deepEqual(f.job.pendingRequests, []);
  assert.deepEqual(f.child.received, []);

  await settle(f);
});

test('a native approval without a wire request id gets a stable bridge id and an outcome answer', async (t) => {
  const f = fixture(t);
  f.child.approval();

  const pending = await until(() => f.job.pendingRequests[0]);
  assert.equal(pending.method, 'approval/request');
  assert.match(pending.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(pending.params.requestId, pending.requestId);
  assert.equal(pending.params.toolName, 'pwsh');

  // The same id is what dsb status exposes and dsb answer accepts.
  assert.equal(f.job.pendingRequests[0].requestId, pending.requestId);

  queueInput(
    f.job,
    'answer',
    { requestId: pending.requestId, answer: { outcome: 'allowed-once' } },
    f.home,
  );

  const response = await until(() => f.child.received[0]);
  assert.deepEqual(response, {
    jsonrpc: '2.0',
    id: 'approval-rpc-1',
    result: { outcome: 'allowed-once' },
  });

  await until(() =>
    events(f).some(
      (event) => event.event === 'input_delivered' && event.requestId === pending.requestId,
    ),
  );
  assert.deepEqual(f.job.pendingRequests, []);
  assert.equal(f.job.answeredQuestions || 0, 0);

  await settle(f);
});

test('an invalid answer is rejected before it reaches dsh and the request stays pending', async (t) => {
  const f = fixture(t);
  f.child.ask();

  const pending = await until(() => f.job.pendingRequests[0]);
  const rejectedId = queueInput(
    f.job,
    'answer',
    { requestId: pending.requestId, answer: { answers: [] } },
    f.home,
  ).inputId;

  await until(() =>
    events(f).some((event) => event.event === 'input_rejected' && event.inputId === rejectedId),
  );
  assert.deepEqual(f.child.received, []);
  assert.deepEqual(
    f.job.pendingRequests.map((request) => request.requestId),
    [pending.requestId],
  );

  queueInput(
    f.job,
    'answer',
    {
      requestId: pending.requestId,
      answer: { answers: [{ id: 'q', selected: ['A'], custom: 'valid' }] },
    },
    f.home,
  );

  await until(() => f.child.received.length === 1);
  assert.deepEqual(f.job.pendingRequests, []);

  await settle(f);
});

test('an unsupported host request is rejected without becoming pending', async (t) => {
  const f = fixture(t);
  f.child.send({ id: 'other-1', method: 'tools/call', params: { name: 'x' } });
  const rejection = await until(() => f.child.received[0]);
  assert.equal(rejection.id, 'other-1');
  assert.equal(rejection.error.code, -32601);
  assert.deepEqual(f.job.pendingRequests ?? [], []);
  await settle(f);
});

test('an already aborted signal rejects the session instead of running it', async (t) => {
  const controller = new AbortController();
  controller.abort(new Error('Already cancelled'));
  const f = fixture(t, { signal: controller.signal });
  await assert.rejects(f.task, /Already cancelled/);
  assert.equal(fs.existsSync(f.job.reportFile), false);
  assert.equal(f.child.waiting, null);
});

test('eventsPage ignores an unterminated tail and reports no more pages', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'events-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'events.jsonl'),
    job = { id: 'events-job', eventsFile: file };
  const line = (event) => JSON.stringify({ event }) + '\n';

  fs.writeFileSync(file, line('first') + '{"event":"partial"');
  const page = eventsPage(job);
  assert.deepEqual(page.events, [{ event: 'first' }]);
  assert.equal(page.more, false);
  assert.equal(page.cursor, Buffer.byteLength(line('first')));
  assert.deepEqual(eventsPage(job, page.cursor).events, []);
});

test('eventsPage keeps more true while complete records remain past the limit', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'events-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'events.jsonl'),
    job = { id: 'events-job', eventsFile: file };
  fs.writeFileSync(
    file,
    ['first', 'second', 'third'].map((event) => JSON.stringify({ event }) + '\n').join(''),
  );

  const page = eventsPage(job, 0, 2);
  assert.deepEqual(page.events, [{ event: 'first' }, { event: 'second' }]);
  assert.equal(page.more, true);

  const rest = eventsPage(job, page.cursor, 2);
  assert.deepEqual(rest.events, [{ event: 'third' }]);
  assert.equal(rest.more, false);
});

test('sdkTimeouts returns the documented defaults when a job states no timeouts', () => {
  assert.equal(SDK_INITIALIZE_TIMEOUT_MS, 120000);
  assert.equal(SDK_PROMPT_TIMEOUT_MS, 90000);
  assert.deepEqual(sdkTimeouts({ id: 'job' }), {
    initializeMs: SDK_INITIALIZE_TIMEOUT_MS,
    promptMs: SDK_PROMPT_TIMEOUT_MS,
  });
});

test('sdkTimeouts adds one MCP handshake per patch only to the initialize default', () => {
  assert.equal(SDK_MCP_HANDSHAKE_TIMEOUT_MS, 60000);
  assert.deepEqual(sdkTimeouts({ id: 'job', patches: ['a.json', 'b.json'] }), {
    initializeMs: SDK_INITIALIZE_TIMEOUT_MS + 2 * SDK_MCP_HANDSHAKE_TIMEOUT_MS,
    promptMs: SDK_PROMPT_TIMEOUT_MS,
  });
});

test('sdkTimeouts keeps an explicit initialize timeout even when patches exist', () => {
  assert.deepEqual(
    sdkTimeouts({ initializeTimeoutMs: 45000, promptTimeoutMs: 10000, patches: ['a.json'] }),
    { initializeMs: 45000, promptMs: 10000 },
  );
});

test('sdkTimeouts rejects a stated timeout unless it is a positive safe integer', () => {
  const invalid = [
    ['initializeTimeoutMs', 0],
    ['initializeTimeoutMs', -1],
    ['initializeTimeoutMs', 1.5],
    ['initializeTimeoutMs', '30000'],
    ['promptTimeoutMs', 0],
    ['promptTimeoutMs', -60000],
    ['promptTimeoutMs', 2.5],
    ['promptTimeoutMs', '90000'],
  ];

  for (const [field, value] of invalid)
    assert.throws(
      () => sdkTimeouts({ [field]: value }),
      new RegExp(field),
      `${field} accepted ${JSON.stringify(value)}`,
    );
});

test('an initialize timeout reports that dsh did not finish starting', async (t) => {
  const f = fixture(t, { job: { initializeTimeoutMs: 50 }, stall: ['initialize'] });
  await assert.rejects(f.task, /dsh did not finish starting within 50 ms/);
});

test('a session/prompt timeout reports that the session was not created', async (t) => {
  const f = fixture(t, { job: { promptTimeoutMs: 50 }, stall: ['session/prompt'] });
  await assert.rejects(f.task, /session was not created within 50 ms/);
});

test('a queued message timeout keeps the transport wording and rejects the input', async (t) => {
  // The budget also covers the acknowledged first prompt, so keep it generous.
  const f = fixture(t, { job: { promptTimeoutMs: 200 } });
  await until(() => f.child.waiting);

  // The initial prompt was acknowledged; stall only the queued follow-up.
  f.child.stall.add('session/prompt');
  const inputId = queueInput(f.job, 'message', { text: 'more' }, f.home).inputId;

  const rejected = await until(() =>
    events(f).find((event) => event.event === 'input_rejected' && event.inputId === inputId),
  );
  assert.match(rejected.error, /SDK session\/prompt timed out/);

  await settle(f);
});

test('onReady is called once after initialize succeeds and before the prompt', async (t) => {
  const calls = [];
  const f = fixture(t, {
    onReady: () => {
      calls.push({
        initialized: Boolean(f.child.initialize),
        prompted: Boolean(f.child.sessionId),
      });
    },
  });

  await until(() => f.child.waiting);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { initialized: true, prompted: false });

  await settle(f);
  assert.equal(calls.length, 1);
});

test('onReady is not called when initialize fails', async (t) => {
  const calls = [];
  const f = fixture(t, {
    job: { initializeTimeoutMs: 50 },
    stall: ['initialize'],
    onReady: () => calls.push('ready'),
  });

  await assert.rejects(f.task, /dsh did not finish starting within 50 ms/);
  assert.deepEqual(calls, []);
});

test('a throwing onReady does not fail the run', async (t) => {
  const f = fixture(t, {
    onReady: () => {
      throw new Error('startup gate failed');
    },
  });

  await settle(f);
  assert.match(fs.readFileSync(f.job.reportFile, 'utf8'), /RESULT: OK/);
});
