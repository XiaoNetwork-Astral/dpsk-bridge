import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runJob, readJob, waitJob, sendMessage, answerRequest, cancelJob, eventsPage } from '../lib/bridge.mjs';
import { setup } from './helpers/fake-dsh.mjs';

// Three questions, then an approval, then a fourth (capped) and a fifth (after --user-ok).
const questionCapFake = `
import readline from 'node:readline';
const write = (m, done) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n', done);
let sessionId, seq=0, asked=0, waitId, finished=false;
const event=(type,data)=>write({method:'session.event',params:{sessionId,event:{type,seq:++seq,time:Date.now(),data}}});
const ask=()=>{asked++;write({id:'ask-'+asked,method:'user-question/ask',params:{requestId:'q-'+asked,sessionId,questions:[{id:'choice',question:'Q'+asked,options:[]}]}});};
const approve=()=>write({id:'approval-rpc',method:'approval/request',params:{sessionId}});
const finish=()=>{
 if(finished)return;finished=true;
 event('assistant/message',{turn:1,step:1,message:{role:'assistant',content:[{type:'text',text:'RESULT: OK'}]},usage:{inputTokens:10,outputTokens:4,cacheReadTokens:0,cacheWriteTokens:0}});
 event('turn/end',{turn:1,reason:{kind:'completed'}});
 if(waitId)write({id:waitId,result:{}});
};
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')write({id:m.id,result:{serverInfo:{name:'deepseek-harness-sdk-runtime'}}});
 else if(m.method==='session/prompt'){sessionId=m.params.sessionId;if(asked===0)ask();write({id:m.id,result:{messageId:'m'}});}
 else if(m.method==='session/wait'){if(finished)write({id:m.id,result:{}});else waitId=m.id;}
 else if(m.method==='shutdown'){write({id:m.id,result:{}},()=>process.exit(0));}
 else if(typeof m.id==='string'&&m.id.startsWith('ask-')){if(asked<3)ask();else if(asked===3)approve();else if(asked===4)ask();else finish();}
 else if(m.id==='approval-rpc')ask();
});
`;

// Emits usage 100/150/200, then stays open until a follow-up prompt finishes the turn.
const contextFake = `
import readline from 'node:readline';
const write = (m, done) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n', done);
let sessionId, seq=0, waitId, finished=false, prompts=0;
const event=(type,data)=>write({method:'session.event',params:{sessionId,event:{type,seq:++seq,time:Date.now(),data}}});
const usage=t=>({inputTokens:t,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0});
const message=(turn,step,tokens)=>event('assistant/message',{turn,step,message:{role:'assistant',content:[{type:'text',text:'RESULT: OK'}]},usage:usage(tokens)});
const finish=()=>{
 if(finished)return;finished=true;
 message(2,1,1);event('turn/end',{turn:2,reason:{kind:'completed'}});
 if(waitId)write({id:waitId,result:{}});
};
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')write({id:m.id,result:{serverInfo:{name:'deepseek-harness-sdk-runtime'}}});
 else if(m.method==='session/prompt'){
  sessionId=m.params.sessionId;prompts++;
  if(prompts===1){message(1,1,100);message(1,2,150);message(1,3,200);}else finish();
  write({id:m.id,result:{messageId:'m'+prompts}});
 } else if(m.method==='session/wait'){if(finished)write({id:m.id,result:{}});else waitId=m.id;}
 else if(m.method==='shutdown'){write({id:m.id,result:{}},()=>process.exit(0));}
});
`;

// Asks one question, then cancels it from the runtime while the job keeps running.
const cancelFake = `
import readline from 'node:readline';
const write = (m, done) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n', done);
let sessionId, waitId, asked=false;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')write({id:m.id,result:{serverInfo:{name:'deepseek-harness-sdk-runtime'}}});
 else if(m.method==='session/prompt'){
  sessionId=m.params.sessionId;
  if(!asked){asked=true;write({id:'ask-rpc',method:'user-question/ask',params:{requestId:'q-cancel',sessionId,questions:[{id:'choice',question:'Proceed?',options:[]}]}});
   write({method:'user-question.cancelled',params:{requestId:'q-cancel',sessionId}});}
  write({id:m.id,result:{messageId:'m'}});
 } else if(m.method==='session/wait')waitId=m.id;
 else if(m.method==='shutdown'){write({id:m.id,result:{}},()=>process.exit(0));}
 else if(m.id==='ask-rpc'){/* the host answer is intentionally ignored */}
});
`;

function background(t, options, home, onEvent = () => {}) {
  let id;
  const started = Promise.withResolvers();
  const running = runJob(options, event => {
    if (event.event === 'started') { id = event.id; started.resolve(id); }
    onEvent(event);
  }, home);
  running.catch(error => started.reject(error));
  t.after(async () => {
    try {
      const latest = readJob(id, home);
      if (!['completed', 'failed', 'timed_out', 'cancelled', 'launch_failed', 'cleanup_failed'].includes(latest.processState))
        cancelJob(latest, home);
    } catch {}
    await running.catch(() => {});
  });
  return { started: started.promise, running };
}

async function waitForEvent(id, home, name, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = eventsPage(readJob(id, home), 0, 200).events.find(event => event.event === name);
    if (found) return found;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for event ${name}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function until(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test('wait returns finished immediately for a terminal job', async t => {
  const { options, home } = setup(t, 'wait finished');
  const job = await runJob(options, () => {}, home);
  const waited = await waitJob(job, 5, home);
  assert.equal(waited.event, 'wait');
  assert.equal(waited.reason, 'finished');
  assert.equal(waited.id, job.id);
  assert.equal(waited.processState, 'completed');
  assert.equal(waited.reportedResult, 'OK');
});

test('wait returns request for a pending question and finished after the answer', async t => {
  const { options, home } = setup(t, '[chat] answer me');
  const { started, running } = background(t, options, home);
  const id = await started;
  const request = await waitJob({ id }, 10, home);
  assert.equal(request.reason, 'request');
  assert.equal(request.processState, 'running');
  assert.equal(request.pendingRequests.length, 1);
  assert.deepEqual(request.actionableRequests, [request.pendingRequests[0].requestId]);
  sendMessage(readJob(id, home), 'host follow up', home);
  answerRequest(readJob(id, home), request.pendingRequests[0].requestId,
    { answers: [{ id: 'choice', selected: [], custom: 'Continue' }] }, home);
  const finished = await waitJob({ id }, 10, home);
  assert.equal(finished.reason, 'finished');
  assert.equal(finished.reportedResult, 'OK');
  assert.deepEqual(finished.actionableRequests, []);
  const job = await running;
  assert.equal(job.processState, 'completed', job.error);
});

test('question cap refuses the fourth answer until --user-ok, while approvals never count', async t => {
  const { options, home } = setup(t, '[cap] questions');
  fs.writeFileSync(options.dshEntry, questionCapFake);
  const { started, running } = background(t, options, home);
  const id = await started;
  const answer = { answers: [{ id: 'choice', selected: [], custom: 'Continue' }] };
  for (let n = 1; n <= 3; n++) {
    const request = await waitJob({ id }, 10, home);
    assert.equal(request.reason, 'request', `question ${n}`);
    assert.deepEqual(request.actionableRequests, [`q-${n}`]);
    answerRequest(readJob(id, home), `q-${n}`, answer, home);
  }
  const approval = await waitJob({ id }, 10, home);
  assert.equal(approval.reason, 'request');
  assert.equal(approval.pendingRequests[0].method, 'approval/request');
  assert.match(approval.pendingRequests[0].requestId, /^[a-f0-9-]{36}$/);
  assert.equal(readJob(id, home).answeredQuestions, 3);
  answerRequest(readJob(id, home), approval.pendingRequests[0].requestId, { outcome: 'allowed-once' }, home);
  const capped = await waitJob({ id }, 10, home);
  assert.equal(capped.reason, 'escalate');
  assert.deepEqual(capped.actionableRequests, ['q-4']);
  assert.equal(capped.answeredQuestions, 3);
  assert.equal(capped.questionCapLifted, false);
  assert.throws(() => answerRequest(readJob(id, home), 'q-4', answer, home),
    /already had 3 questions answered.*--user-ok/);
  assert.equal(answerRequest(readJob(id, home), 'q-4', answer, home, true).state, 'queued');
  const lifted = await waitJob({ id }, 10, home);
  assert.equal(lifted.reason, 'request');
  assert.deepEqual(lifted.actionableRequests, ['q-5']);
  const after = readJob(id, home);
  assert.equal(after.answeredQuestions, 4);
  assert.equal(after.questionCapLifted, true);
  answerRequest(after, 'q-5', answer, home);
  const finished = await waitJob({ id }, 10, home);
  assert.equal(finished.reason, 'finished');
  const job = await running;
  assert.equal(job.processState, 'completed', job.error);
  assert.equal(job.answeredQuestions, 5);
  assert.equal(job.questionCapLifted, true);
  assert.equal(eventsPage(job, 0, 200).events.filter(event => event.event === 'input_delivered').length, 6);
});

test('wait stops reporting a cancelled question as actionable', async t => {
  const { options, home } = setup(t, '[cancel] question');
  fs.writeFileSync(options.dshEntry, cancelFake);
  const { started, running } = background(t, options, home);
  const id = await started;
  await waitForEvent(id, home, 'request_cancelled');
  const waited = await waitJob({ id }, 1, home);
  assert.equal(waited.reason, 'timeout');
  assert.deepEqual(waited.actionableRequests, []);
  assert.deepEqual(waited.pendingRequests, []);
  cancelJob(readJob(id, home), home);
  const job = await running;
  assert.equal(job.processState, 'cancelled', job.error);
});

test('wait returns timeout for a running job and errors for bad timeouts or missing jobs', async t => {
  const { options, home } = setup(t, '[hold] wait forever');
  const { started, running } = background(t, options, home);
  const id = await started;
  const began = performance.now();
  const waited = await waitJob({ id }, 1, home);
  assert.equal(waited.reason, 'timeout');
  assert.equal(waited.processState, 'running');
  // A monotonic lower bound, far below the 1 s timeout, proves wait blocked
  // without making the test sensitive to a slow machine.
  assert.ok(performance.now() - began >= 500, `wait returned after ${performance.now() - began}ms`);
  cancelJob(readJob(id, home), home);
  const job = await running;
  assert.equal(job.processState, 'cancelled', job.error);

  await assert.rejects(waitJob(job, 0, home), /timeout must be between 1 and 3600 seconds/);
  await assert.rejects(waitJob(job, 3601, home), /timeout must be between 1 and 3600 seconds/);
  await assert.rejects(waitJob({ id: '00000000-0000-4000-8000-000000000000' }, 1, home), /ENOENT/);
});

test('context reminder is recorded once while running and wait returns context exactly once', async t => {
  const { options, home } = setup(t, '[context] threshold');
  fs.writeFileSync(options.dshEntry, contextFake);
  const { started, running } = background(t, { ...options, contextLimit: 100 }, home);
  const id = await started;
  const remembered = await until(() => {
    const record = readJob(id, home);
    return record.contextReminder && record.context?.tokens === 200 && record;
  });
  assert.equal(remembered.processState, 'running');
  assert.equal(remembered.context.tokens, 200);
  assert.equal(remembered.contextLimit, 100);
  assert.equal(remembered.contextReminder.tokens, 100);
  assert.equal(remembered.contextReminder.threshold, 100);
  assert.equal(eventsPage(remembered, 0, 200).events.filter(event => event.event === 'context_reminder').length, 1);

  const waited = await waitJob({ id }, 5, home);
  assert.equal(waited.reason, 'context');
  assert.equal(waited.context.tokens, 200);
  assert.equal(waited.actionableRequests.length, 0);
  assert.ok(fs.existsSync(path.join(home, 'jobs', id, 'context.reported')));
  const again = await waitJob({ id }, 1, home);
  assert.equal(again.reason, 'timeout');

  sendMessage(readJob(id, home), 'finish now', home);
  const finished = await waitJob({ id }, 10, home);
  assert.equal(finished.reason, 'finished');
  const job = await running;
  assert.equal(job.processState, 'completed', job.error);
  assert.equal(eventsPage(job, 0, 200).events.filter(event => event.event === 'context_reminder').length, 1);
  // Once the job has ended, an unreported reminder no longer delays finished.
  fs.rmSync(path.join(home, 'jobs', id, 'context.reported'));
  assert.equal((await waitJob({ id }, 1, home)).reason, 'finished');
});

test('wait keeps pending requests out of actionableRequests while the job is finishing', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-bridge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'bridge'), id = '00000000-0000-4000-8000-000000000001';
  const dir = path.join(home, 'jobs', id), requestId = '00000000-0000-4000-8000-000000000002';
  fs.mkdirSync(dir, { recursive: true });
  const job = { version: 2, id, parentId: null, rootId: id, processState: 'finishing',
    supervisorPid: process.pid, pendingRequests: [{ requestId, method: 'user-question/ask', params: {} }],
    startedAt: Date.now(), review: null, exitCode: null, reportedResult: null, cwd: root,
    reportFile: path.join(dir, 'report.txt'), stderrFile: path.join(dir, 'stderr.log'), eventsFile: path.join(dir, 'events.jsonl') };
  const file = path.join(dir, 'job.json');
  fs.writeFileSync(file, JSON.stringify(job));

  const began = performance.now();
  const waited = await waitJob({ id }, 1, home);
  assert.equal(waited.reason, 'timeout');
  assert.ok(performance.now() - began >= 500, `wait returned after ${performance.now() - began}ms`);
  assert.deepEqual(waited.actionableRequests, []);
  assert.deepEqual(waited.pendingRequests.map(request => request.requestId), [requestId]);

  // A real run clears pendingRequests when the job ends.
  job.processState = 'completed'; job.pendingRequests = [];
  fs.writeFileSync(file, JSON.stringify(job));
  const done = await waitJob({ id }, 1, home);
  assert.equal(done.reason, 'finished');
  assert.equal(done.processState, 'completed');
  assert.deepEqual(done.actionableRequests, []);
});
