import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { liveProcessState, heartbeatFresh, supervisorLive, touchHeartbeat } from '../lib/job-state.mjs';
import { runJob, readJob, status, cancelJob, unlockJob, sendMessage, answerRequest, waitJob } from '../lib/bridge.mjs';
import { acquireSlot, releaseReservation } from '../lib/scheduler.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const stale = file => { const old = new Date(Date.now() - 2 * 60 * 1000); fs.utimesSync(file, old, old); };

async function until(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await delay(20);
  }
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
  await once(child, 'close');
  return child.pid;
}

function fixture(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dpsk-bridge-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'bridge'), workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  return { root, home, workspace };
}

// A job whose heartbeat is stale is not live even when its recorded PID is
// present: that is exactly the Windows PID-reuse case.
test('a job with an existing PID but a stale heartbeat is not live', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-bridge-stale-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const heartbeatFile = path.join(root, 'heartbeat');
  fs.writeFileSync(heartbeatFile, '');
  stale(heartbeatFile);
  const job = { version: 2, processState: 'running', supervisorPid: process.pid, heartbeatFile };
  assert.equal(supervisorLive(job), false);
  assert.equal(liveProcessState(job), 'unknown');
  assert.equal(status(job).processState, 'unknown');
});

test('a stale heartbeat also stops send, answer, and cancel', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-bridge-actions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const heartbeatFile = path.join(root, 'heartbeat');
  fs.writeFileSync(heartbeatFile, '');
  stale(heartbeatFile);
  const job = { version: 2, processState: 'running', supervisorPid: process.pid, heartbeatFile,
    pendingRequests: [{ requestId: 'request-1', method: 'user-question/ask', params: {} }] };
  assert.throws(() => sendMessage(job, 'hello', root), /heartbeat/);
  assert.throws(() => answerRequest(job, 'request-1', {}, root), /heartbeat/);
  assert.throws(() => cancelJob(job, root), /heartbeat/);
});

// A fresh heartbeat stays valid past one refresh interval; only the 60 s
// staleness margin can expire it. Time is injected instead of waiting.
test('a fresh heartbeat stays live while idle beyond one heartbeat interval', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-bridge-fresh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const heartbeatFile = path.join(root, 'heartbeat');
  fs.writeFileSync(heartbeatFile, '');
  const touchedAt = Date.now();
  touchHeartbeat(heartbeatFile, touchedAt);
  const job = { version: 2, processState: 'running', supervisorPid: process.pid, heartbeatFile };
  // Older than the 5 s refresh interval but well inside the 60 s margin.
  assert.equal(liveProcessState(job, touchedAt + 5000 + 2000), 'running');
  assert.equal(liveProcessState(job, touchedAt + 61000), 'unknown');
});

// Records written before heartbeats keep the PID-only check.
test('a legacy job without a heartbeat keeps the PID-only behavior', async t => {
  assert.equal(heartbeatFresh(undefined), null);
  const job = { version: 2, processState: 'running', supervisorPid: process.pid };
  assert.equal(liveProcessState(job), 'running');
  job.supervisorPid = await deadPid();
  assert.equal(liveProcessState(job), 'unknown');
});

test('wait returns unknown for a stale heartbeat instead of waiting forever', async t => {
  const { root, home } = fixture(t, 'wait-stale');
  const id = '00000000-0000-4000-8000-000000000063';
  const dir = path.join(home, 'jobs', id), heartbeatFile = path.join(dir, 'heartbeat');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(heartbeatFile, '');
  stale(heartbeatFile);
  const job = { version: 2, id, parentId: null, rootId: id, processState: 'running',
    supervisorPid: process.pid, heartbeatFile, pendingRequests: [], startedAt: Date.now(),
    review: null, exitCode: null, reportedResult: null, cwd: root,
    reportFile: path.join(dir, 'report.txt'), stderrFile: path.join(dir, 'stderr.log'), eventsFile: path.join(dir, 'events.jsonl') };
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job));
  const began = Date.now();
  const waited = await waitJob({ id }, 1, home);
  assert.equal(waited.reason, 'unknown');
  assert.equal(waited.processState, 'unknown');
  assert.ok(Date.now() - began < 500, `wait took ${Date.now() - began}ms`);
});

test('the supervisor refreshes its heartbeat while the job stays idle', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-bridge-beat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'bridge');
  fs.mkdirSync(path.join(root, 'runtime', 'lib'), { recursive: true });
  const entry = path.join(root, 'runtime', 'lib', 'bin.mjs');
  fs.writeFileSync(entry, `
import readline from 'node:readline';
const write = m => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m}) + '\\n');
readline.createInterface({input: process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') write({id: m.id, result: {serverInfo: {name: 'deepseek-harness-sdk-runtime'}}});
  else if (m.method === 'session/prompt') write({id: m.id, result: {messageId: 'm'}});
  else if (m.method === 'shutdown') { write({id: m.id, result: {}}); setTimeout(() => process.exit(0), 10); }
});
`);
  fs.writeFileSync(path.join(root, 'runtime', 'package.json'), JSON.stringify({ version: '0.2.2-alpha.3' }));
  const brief = path.join(root, 'brief.md');
  fs.writeFileSync(brief, '[hold] stay alive');
  let id;
  const running = runJob({ cwd: root, brief, dshEntry: entry, timeout: 10, heartbeatIntervalMs: 25 }, event => {
    if (event.event === 'started') id = event.id;
  }, home);
  try {
    await until(() => id);
    const record = readJob(id, home);
    const before = fs.statSync(record.heartbeatFile).mtimeMs;
    await until(() => fs.statSync(record.heartbeatFile).mtimeMs > before);
    await delay(120);
    assert.equal(status(readJob(id, home)).processState, 'running');
    assert.equal(liveProcessState(readJob(id, home)), 'running');
  } finally {
    try {
      const record = readJob(id, home);
      if (!['completed', 'failed', 'timed_out', 'cancelled', 'launch_failed', 'cleanup_failed'].includes(record.processState))
        cancelJob(record, home);
    } catch {}
    await running.catch(() => {});
  }
});

test('unlock proceeds past an existing child PID when the supervisor heartbeat is stale', async t => {
  const { root, home } = fixture(t, 'unlock');
  const id = '00000000-0000-4000-8000-000000000060';
  const dir = path.join(home, 'jobs', id), heartbeatFile = path.join(dir, 'heartbeat');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(heartbeatFile, '');
  stale(heartbeatFile);
  const supervisorPid = await deadPid(), childPid = process.pid;
  const job = { version: 2, id, rootId: id, parentId: null, processState: 'cleanup_failed',
    supervisorPid, childPid, heartbeatFile, pendingRequests: [], review: null,
    exitCode: null, reportedResult: null, cwd: root };
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job));
  const stateFile = path.join(home, 'scheduler', 'state.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, nextSequence: 2, reservations: [{
    id, token: '00000000-0000-4000-8000-000000000061', supervisorPid, childPid, heartbeatFile,
    workspace: fs.realpathSync(root), scopes: [fs.realpathSync(root)], readOnly: false, exclusive: false, resources: [],
    maxConcurrent: 8, state: 'active', sequence: 1, queuedAt: Date.now(), startedAt: Date.now(),
  }] }));
  const unlocked = await unlockJob(job, true, home);
  assert.equal(unlocked.unlocked, true);
  assert.match(unlocked.warning, new RegExp(`child ${childPid}`));
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).reservations, []);
});

test('unlock still refuses a live supervisor or a legacy reused PID', async t => {
  const { root, home } = fixture(t, 'unlock-live');
  const id = '00000000-0000-4000-8000-000000000062';
  const dir = path.join(home, 'jobs', id);
  fs.mkdirSync(dir, { recursive: true });
  const legacy = { version: 2, id, rootId: id, parentId: null, processState: 'cleanup_failed',
    supervisorPid: process.pid, childPid: null, pendingRequests: [], review: null,
    exitCode: null, reportedResult: null, cwd: root };
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(legacy));
  await assert.rejects(unlockJob(legacy, true, home), /still present/);
  const fresh = { ...legacy, heartbeatFile: path.join(dir, 'heartbeat') };
  fs.writeFileSync(fresh.heartbeatFile, '');
  await assert.rejects(unlockJob(fresh, true, home), /still present/);
});

test('the scheduler releases a reservation whose supervisor heartbeat is stale', async t => {
  const { home, workspace } = fixture(t, 'reservation');
  const heartbeatFile = path.join(home, 'reservation-heartbeat');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(heartbeatFile, '');
  const state = () => JSON.parse(fs.readFileSync(path.join(home, 'scheduler', 'state.json'), 'utf8'));
  const live = await acquireSlot({ home, workspace, id: 'fresh-owner', heartbeatFile });
  await assert.rejects(releaseReservation(home, 'fresh-owner', { confirmedStopped: true }), /still present/);
  await live.release();
  const slot = await acquireSlot({ home, workspace, id: 'stale-owner', heartbeatFile });
  stale(heartbeatFile);
  await releaseReservation(home, 'stale-owner', { confirmedStopped: true });
  assert.deepEqual(state().reservations, []);
  await slot.release().catch(() => {});
});
