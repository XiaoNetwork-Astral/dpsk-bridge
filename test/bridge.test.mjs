import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import {
  runJob,
  readJob,
  status,
  sendMessage,
  answerRequest,
  eventsPage,
  cancelJob,
  result,
  retryJob,
  reviewJob,
  stats,
  briefText,
  waitJob,
  unlockJob,
  adoptJob,
} from '../lib/bridge.mjs';
import { currentOwner } from '../lib/owner.mjs';
import { fake, captureRuntime, setup } from './helpers/fake-dsh.mjs';

const digest = (buffer) => createHash('sha256').update(buffer).digest('hex');
const packageJson = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pngBytes = () =>
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x49, 0x48, 0x44, 0x52]);
const jpegBytes = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
  await once(child, 'close');
  return child.pid;
}

function saveRecord(home, job) {
  const dir = path.join(home, 'jobs', job.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job));
  return dir;
}

const foreignOwner = (pid) => ({
  id: 'f'.repeat(16),
  label: `other-agent ${pid}`,
  pid,
  startedAt: 1,
  source: 'process',
});

test('images are sent as base64 blocks after the text block and recorded without content', async (t) => {
  const { root, options, home } = setup(t, 'describe the images');
  const pngFile = path.join(root, 'first.png'),
    jpegFile = path.join(root, 'second.jpg');
  const png = pngBytes(),
    jpg = jpegBytes();
  fs.writeFileSync(pngFile, png);
  fs.writeFileSync(jpegFile, jpg);

  const capture = path.join(root, 'content-blocks.json');
  fs.writeFileSync(options.dshEntry, captureRuntime(capture));

  const job = await runJob({ ...options, image: [pngFile, jpegFile] }, () => {}, home);
  assert.equal(job.processState, 'completed', job.error);
  assert.equal(job.version, 2);
  assert.deepEqual(job.images, [
    { path: fs.realpathSync(pngFile), sha256: digest(png), mimeType: 'image/png' },
    { path: fs.realpathSync(jpegFile), sha256: digest(jpg), mimeType: 'image/jpeg' },
  ]);

  const blocks = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].type, 'text');
  assert.ok(
    blocks[0].text.includes(
      '[dpsk-bridge attached images]\nThis task includes 2 images, in order: first.png, second.jpg',
    ),
  );
  assert.ok(
    blocks[0].text.includes('Use standard English for your reports'),
    'DeepSeek is asked to answer in English',
  );

  assert.equal(blocks[0].text.includes(pngFile), false);
  assert.equal(blocks[1].type, 'image');
  assert.equal(blocks[1].mimeType, 'image/png');
  assert.ok(Buffer.from(blocks[1].data, 'base64').equals(png));
  assert.equal(blocks[2].type, 'image');
  assert.equal(blocks[2].mimeType, 'image/jpeg');
  assert.ok(Buffer.from(blocks[2].data, 'base64').equals(jpg));

  const jobText = fs.readFileSync(path.join(path.dirname(job.reportFile), 'job.json'), 'utf8');
  assert.equal(jobText.includes(png.toString('base64')), false);
  assert.equal(jobText.includes(jpg.toString('base64')), false);
});

test('a job without images sends exactly one text block', async (t) => {
  const { root, options, home } = setup(t, 'plain task');
  const capture = path.join(root, 'content-blocks.json');
  fs.writeFileSync(options.dshEntry, captureRuntime(capture));
  const job = await runJob(options, () => {}, home);
  assert.equal(job.processState, 'completed', job.error);
  const prompt = fs.readFileSync(path.join(path.dirname(job.reportFile), 'prompt.txt'), 'utf8');
  assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')), [{ type: 'text', text: prompt }]);
  assert.deepEqual(job.images, []);
  assert.equal('session' in job, false);
  assert.ok(!prompt.includes('[dpsk-bridge attached images]'));
});

test('a non-image file is rejected before dsh starts or job files are written', async (t) => {
  const { root, options, home } = setup(t, 'reject');
  const fakeImage = path.join(root, 'not-really.png');
  fs.writeFileSync(fakeImage, 'plain text, not an image');

  const marker = path.join(root, 'started.txt');
  fs.writeFileSync(
    options.dshEntry,
    `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'started');`,
  );

  const real = fs.realpathSync(fakeImage);
  await assert.rejects(
    runJob({ ...options, image: [fakeImage] }, () => {}, home),
    (error) =>
      /Unsupported image format \(JPEG, PNG, GIF and WebP only\): /.test(error.message) &&
      error.message.includes(real),
  );

  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(home), false);
});

test('images beyond one SDK message or beyond the count limit are rejected before launch', async (t) => {
  const { root, options, home } = setup(t, 'too large');
  const marker = path.join(root, 'started.txt');
  fs.writeFileSync(
    options.dshEntry,
    `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'started');`,
  );

  const big = Buffer.alloc(7 * 1024 * 1024);
  pngBytes().copy(big);
  const bigFile = path.join(root, 'big.png');
  fs.writeFileSync(bigFile, big);

  await assert.rejects(
    runJob({ ...options, image: [bigFile] }, () => {}, home),
    /Images are too large for one SDK message \(\d+ > 8388608\); downscale or split them/,
  );

  assert.equal(fs.existsSync(marker), false);

  const many = Array.from({ length: 21 }, (_, index) => {
    const file = path.join(root, `many-${index}.png`);
    fs.writeFileSync(file, pngBytes());
    return file;
  });

  await assert.rejects(
    runJob({ ...options, image: many }, () => {}, home),
    /At most 20 images per job/,
  );

  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(home), false);
});

test('retry carries unchanged images and rejects images changed since the previous run', async (t) => {
  const { root, options, home } = setup(t, 'retry with image');
  const file = path.join(root, 'image.png'),
    png = pngBytes();
  fs.writeFileSync(file, png);

  const capture = path.join(root, 'content-blocks.json');
  fs.writeFileSync(options.dshEntry, captureRuntime(capture));

  const job = await runJob({ ...options, image: [file] }, () => {}, home);
  assert.equal(job.processState, 'completed', job.error);

  const retry = await retryJob(job, 'look again', () => {}, home);
  assert.equal(retry.processState, 'completed', retry.error);
  assert.deepEqual(
    retry.images.map((image) => image.path),
    [fs.realpathSync(file)],
  );

  assert.equal(JSON.parse(fs.readFileSync(capture, 'utf8')).length, 2);

  fs.writeFileSync(file, Buffer.concat([pngBytes(), Buffer.from([0x01])]));
  await assert.rejects(
    retryJob(job, 'look again', () => {}, home),
    /Image changed since the previous run; create a new job/,
  );
});

test('an image changed after launch fails the job with a clear error', async (t) => {
  const { root, options, home } = setup(t, 'change after launch');
  const file = path.join(root, 'image.png');
  fs.writeFileSync(file, pngBytes());

  const job = await runJob(
    { ...options, image: [file] },
    (event) => {
      if (event.event === 'started')
        fs.writeFileSync(file, Buffer.concat([pngBytes(), Buffer.from([0x02])]));
    },
    home,
  );

  assert.equal(job.processState, 'failed');
  assert.match(job.error, /Image changed since launch: /);
});

test('SDK delivers followups and answers during wait, persists receipts and usage', async (t) => {
  const { options, home } = setup(t, '[chat] bounded task');
  let id, messageInput, answerInput;

  const job = await runJob(
    options,
    (event) => {
      if (event.event === 'started') {
        id = event.id;
        messageInput = sendMessage(readJob(id, home), 'host update 中文', home).inputId;
      }
      if (event.event === 'request')
        answerInput = answerRequest(
          readJob(id, home),
          event.requestId,
          { answers: [{ id: 'choice', selected: [], custom: 'Continue' }] },
          home,
        ).inputId;
    },
    home,
  );

  assert.equal(job.processState, 'completed', job.error);
  assert.equal(job.reportedResult, 'OK');
  assert.match(result(job).report, /host update 中文/);
  assert.equal(job.usage.tokens.uncachedInputTokens, 10);

  const page = eventsPage(job, 0, 200);
  assert.ok(page.events.some((e) => e.event === 'input_delivered' && e.inputId === messageInput));
  assert.ok(page.events.some((e) => e.event === 'input_delivered' && e.inputId === answerInput));
  assert.equal(eventsPage(job, page.cursor).events.length, 0);
  assert.throws(() => eventsPage(job, 1), /Cursor/);
  assert.throws(() => sendMessage(job, 'too late', home), /no longer accepting/);
});

test('cancellation terminates the dedicated SDK process and releases its reservation', async (t) => {
  const { options, home } = setup(t, '[hold] wait forever');

  const job = await runJob(
    options,
    (e) => {
      if (e.event === 'started') cancelJob(readJob(e.id, home), home);
    },
    home,
  );

  assert.equal(job.processState, 'cancelled', job.error);

  const next = await runJob({ ...options, originalBrief: 'simple' }, () => {}, home);
  assert.equal(next.processState, 'completed', next.error);
});

test('timeout settles a waiting SDK and old installed SDK gives an upgrade error', async (t) => {
  const { options, home, root } = setup(t, '[hold] wait forever');

  const job = await runJob({ ...options, timeout: 0.3 }, () => {}, home);
  assert.equal(job.processState, 'timed_out', job.error);

  fs.writeFileSync(
    path.join(root, 'runtime', 'package.json'),
    JSON.stringify({ version: '0.1.5-rc.1' }),
  );

  await assert.rejects(
    runJob(options, () => {}, home),
    /Update/,
  );
});

test('dsh below the version declared in package.json is rejected', async (t) => {
  const { options, home, root } = setup(t, 'version gate');
  fs.writeFileSync(
    path.join(root, 'runtime', 'package.json'),
    JSON.stringify({ version: '0.0.0' }),
  );
  await assert.rejects(
    runJob(options, () => {}, home),
    new RegExp(`Update @deepseek-ai/dsh to >=${escapeRegExp(packageJson.dshVersion)}`),
  );
});

test('retry preserves the original task and current SDK settings', async (t) => {
  const { options, home } = setup(t, 'bounded task');

  const job = await runJob(options, () => {}, home);
  assert.equal(job.processState, 'completed', job.error);
  assert.equal(job.reportedResult, 'OK');

  const retry = await retryJob(job, 'verify again', () => {}, home);
  assert.equal(retry.model, job.model);
  assert.equal(retry.parentId, job.id);

  assert.match(
    fs.readFileSync(path.join(path.dirname(retry.reportFile), 'prompt.txt'), 'utf8'),
    /verify again/,
  );

  assert.equal(retry.processState, 'completed', retry.error);
});

test('a task allows one rework, refuses the second, and resumes do not count', async (t) => {
  const { options, home } = setup(t, 'rework cap');

  const job = await runJob(options, () => {}, home);
  assert.equal(job.retryKind, null);

  const first = await retryJob(job, 'first rework', () => {}, home);
  assert.equal(first.retryKind, 'rework');

  await assert.rejects(
    retryJob(first, 'second rework', () => {}, home),
    /already used its one rework.*--user-ok/,
  );

  const resumed = await retryJob(first, 'resume interrupted work', () => {}, home, {
    resume: true,
  });
  assert.equal(resumed.retryKind, 'resume');
  assert.equal(resumed.processState, 'completed', resumed.error);

  const second = await retryJob(first, 'second rework', () => {}, home, { userOk: true });
  assert.equal(second.retryKind, 'rework');
  assert.equal(second.processState, 'completed', second.error);
});

test('legacy retries without retryKind count as reworks', async (t) => {
  const { options, home } = setup(t, 'legacy rework');

  const job = await runJob(options, () => {}, home);
  const legacy = await retryJob(job, 'legacy retry', () => {}, home);

  const file = path.join(home, 'jobs', legacy.id, 'job.json');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete record.retryKind;
  fs.writeFileSync(file, JSON.stringify(record));

  await assert.rejects(
    retryJob(readJob(legacy.id, home), 'another rework', () => {}, home),
    /already used its one rework/,
  );

  const resumed = await retryJob(readJob(legacy.id, home), 'resume only', () => {}, home, {
    resume: true,
  });
  assert.equal(resumed.retryKind, 'resume');
});

test('a followup delivered during wait forces another wait barrier before shutdown', async (t) => {
  const { options, home } = setup(t, 'race');

  fs.writeFileSync(
    options.dshEntry,
    `
import readline from 'node:readline';
const send=(m,done)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n',done);
let sessionId, prompts=0, firstWait=null, stale=false, completed=false, seq=0;
const event=(type,data)=>send({method:'session.event',params:{sessionId,event:{type,seq:++seq,time:Date.now(),data}}});
const finish=text=>{event('assistant/message',{turn:prompts,step:1,message:{role:'assistant',content:[{type:'text',text:'RESULT: OK\\n'+text}]}});event('turn/end',{turn:prompts,reason:{kind:'completed'}});};
const staleFinish=()=>{
 if(stale || !firstWait || prompts < 2)return;
 stale=true;
 finish('stale first answer');
 send({id:firstWait,result:{}});firstWait=null;
};
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{serverInfo:{name:'deepseek-harness-sdk-runtime'}}});
 else if(m.method==='session/prompt'){
  sessionId=m.params.sessionId;prompts++;
  send({id:m.id,result:{messageId:'m'+prompts}});
  staleFinish();
 }else if(m.method==='session/wait'){
  if(prompts>=2){
   finish('updated answer');completed=true;send({id:m.id,result:{}});
  }else{
   firstWait=m.id;
   // Ask the host for the follow-up only after this wait exists, so it is
   // delivered during the wait instead of racing ahead of it.
   send({id:'ask-race',method:'user-question/ask',params:{requestId:'q-race',sessionId,questions:[{id:'choice',question:'Continue?',options:[]}]}});
  }
 }else if(m.method==='shutdown'){send({id:m.id,result:{}},()=>process.exit(completed?0:9));}
});`,
  );

  let id;
  const job = await runJob(
    options,
    (e) => {
      if (e.event === 'started') id = e.id;
      if (e.event === 'request' && e.requestId === 'q-race')
        sendMessage(readJob(id, home), 'second turn', home);
    },
    home,
  );

  assert.equal(job.processState, 'completed', job.error);
  assert.match(result(job).report, /updated answer/);
  assert.doesNotMatch(result(job).report, /stale first answer/);
});

test('malformed SDK output fails the job and still releases the workspace', async (t) => {
  const { options, home } = setup(t, 'bad runtime');
  fs.writeFileSync(options.dshEntry, `console.log('invalid JSON');setInterval(()=>{},1000);`);
  const failed = await runJob(options, () => {}, home);
  assert.equal(failed.processState, 'failed');
  assert.match(failed.error, /JSON|Unexpected/);
  fs.writeFileSync(options.dshEntry, fake);
  const next = await runJob(options, () => {}, home);
  assert.equal(next.processState, 'completed', next.error);
});

test('cleanup_failed jobs point at unlock and a new task instead of retry or review', async () => {
  const job = { id: '00000000-0000-4000-8000-000000000000', processState: 'cleanup_failed' };
  const expected =
    /run dsb unlock 00000000-0000-4000-8000-000000000000 --confirm-stopped, then start a new task with dsb run\. This job cannot be retried or reviewed\./;
  await assert.rejects(
    retryJob(job, 'again', () => {}),
    expected,
  );
  assert.throws(() => reviewJob(job, 'rework', 'note'), expected);
});

test('unlock releases the reservation but keeps cleanup_failed non-retryable', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-bridge-unlock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const home = path.join(root, 'bridge'),
    id = '00000000-0000-4000-8000-000000000020';
  const dir = path.join(home, 'jobs', id),
    pid = await deadPid();

  const job = {
    version: 2,
    id,
    rootId: id,
    parentId: null,
    processState: 'cleanup_failed',
    supervisorPid: pid,
    childPid: pid,
    pendingRequests: [],
    review: null,
    exitCode: null,
    reportedResult: null,
    cwd: root,
  };

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job));

  const stateFile = path.join(home, 'scheduler', 'state.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      version: 1,
      nextSequence: 2,
      reservations: [
        {
          id,
          token: '00000000-0000-4000-8000-000000000021',
          supervisorPid: pid,
          childPid: pid,
          workspace: fs.realpathSync(root),
          scopes: [fs.realpathSync(root)],
          readOnly: false,
          exclusive: false,
          resources: [],
          maxConcurrent: 8,
          state: 'active',
          sequence: 1,
          queuedAt: Date.now(),
          startedAt: Date.now(),
        },
      ],
    }),
  );

  await assert.rejects(unlockJob(job, false, home), /confirm-stopped/);
  await assert.rejects(
    unlockJob({ ...job, supervisorPid: process.pid }, true, home),
    /still present/,
  );

  assert.deepEqual(await unlockJob(job, true, home), {
    id,
    unlocked: true,
    note: 'Inspect partial changes before creating a new run; unknown runs are not automatically retried.',
  });

  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).reservations, []);

  const expected = /then start a new task with dsb run\. This job cannot be retried or reviewed\./;
  await assert.rejects(
    retryJob(job, 'again', () => {}, home),
    expected,
  );

  assert.throws(() => reviewJob(job, 'rework', 'note', home), expected);
});

test('a failed after.json write keeps the successful run result', async (t) => {
  const { options, home } = setup(t, 'bookkeeping after.json');

  const original = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to).endsWith('after.json')) throw new Error('simulated after.json failure');
    return original(from, to);
  };

  let job;
  try {
    job = await runJob(options, () => {}, home);
  } finally {
    fs.renameSync = original;
  }

  assert.equal(job.processState, 'completed', job.error);
  assert.equal(job.reportedResult, 'OK');
  assert.match(job.error, /writing after\.json: simulated after\.json failure/);

  const saved = readJob(job.id, home);
  assert.equal(saved.processState, 'completed');
  assert.equal(saved.reportedResult, 'OK');
  assert.match(saved.error, /after\.json/);
});

test('a failed final save keeps the successful run result and records an event', async (t) => {
  const { options, home } = setup(t, 'bookkeeping final save');

  const original = fs.renameSync;
  let failJobSave = false;
  fs.renameSync = (from, to) => {
    if (String(to).endsWith('after.json')) {
      const result = original(from, to);
      failJobSave = true;
      return result;
    }
    if (failJobSave && String(to).endsWith('job.json')) {
      failJobSave = false;
      throw new Error('simulated final save failure');
    }
    return original(from, to);
  };

  let job;
  try {
    job = await runJob(options, () => {}, home);
  } finally {
    fs.renameSync = original;
  }

  assert.equal(job.processState, 'completed', job.error);
  assert.equal(job.reportedResult, 'OK');
  assert.match(job.error, /saving bookkeeping: simulated final save failure/);

  assert.ok(eventsPage(job, 0, 200).events.some((event) => event.event === 'bookkeeping_failed'));

  const saved = readJob(job.id, home);
  assert.equal(saved.processState, 'completed');
  assert.equal(saved.reportedResult, 'OK');
});

test('stats counts version-1 records as legacy and reserves unreadable for failures', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-bridge-stats-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'bridge'),
    jobs = path.join(home, 'jobs');

  const ids = {
    legacy: '00000000-0000-4000-8000-000000000030',
    current: '00000000-0000-4000-8000-000000000031',
    broken: '00000000-0000-4000-8000-000000000032',
  };

  for (const id of Object.values(ids)) fs.mkdirSync(path.join(jobs, id), { recursive: true });

  fs.writeFileSync(
    path.join(jobs, ids.legacy, 'job.json'),
    JSON.stringify({ version: 1, id: ids.legacy }),
  );
  fs.writeFileSync(
    path.join(jobs, ids.current, 'job.json'),
    JSON.stringify({
      version: 2,
      id: ids.current,
      rootId: ids.current,
      parentId: null,
      usage: null,
      review: null,
    }),
  );
  fs.writeFileSync(path.join(jobs, ids.broken, 'job.json'), '{not json');

  const summary = stats(home);
  assert.equal(summary.jobs, 1);
  assert.equal(summary.legacyJobs, 1);
  assert.equal(summary.unreadableJobs, 1);
});

test('a started job records its owner and workspace kind and guards ownership until adopted', async (t) => {
  const { options, home } = setup(t, 'ownership guard');
  const job = await runJob(options, () => {}, home);
  assert.equal(job.processState, 'completed', job.error);

  const saved = readJob(job.id, home);
  assert.deepEqual(saved.owner, currentOwner());
  assert.equal(saved.workspaceKind, 'directory');

  const file = path.join(home, 'jobs', job.id, 'job.json');
  const record = JSON.parse(fs.readFileSync(file, 'utf8')),
    gone = foreignOwner(await deadPid());
  record.owner = gone;
  fs.writeFileSync(file, JSON.stringify(record));

  const guarded = [
    ['cancel', () => cancelJob(readJob(job.id, home), home)],
    ['send', () => sendMessage(readJob(job.id, home), 'hello', home)],
    ['review', () => reviewJob(readJob(job.id, home), 'rework', 'look again', home)],
    ['retry', () => retryJob(readJob(job.id, home), 'again', () => {}, home)],
    ['unlock', () => unlockJob(readJob(job.id, home), true, home)],
    ['answer', () => answerRequest(readJob(job.id, home), 'request-1', {}, home)],
  ];

  for (const [name, run] of guarded)
    await assert.rejects(async () => run(), /which is gone\. Adopt it first: dsb adopt/, name);

  const adopted = adoptJob(readJob(job.id, home), {}, home);
  assert.equal(adopted.adopted, true);
  assert.equal(adopted.previousOwner, gone.label);
  assert.deepEqual(readJob(job.id, home).owner, currentOwner());
  assert.ok(
    eventsPage(readJob(job.id, home), 0, 200).events.some(
      (event) => event.event === 'owner_adopted' && event.from === gone.label,
    ),
  );

  assert.equal(cancelJob(readJob(job.id, home), home).cancelRequested, false);
  assert.equal(reviewJob(readJob(job.id, home), 'rework', 'look again', home).acceptance, 'rework');

  // Lifecycle preconditions still apply to the adopted job; only ownership is released.
  for (const [name, run] of [
    ['send', () => sendMessage(readJob(job.id, home), 'hello', home)],
    ['unlock', () => unlockJob(readJob(job.id, home), true, home)],
    ['answer', () => answerRequest(readJob(job.id, home), 'request-1', {}, home)],
  ]) {
    let message = '';
    try {
      await run();
    } catch (error) {
      message = error.message;
    }
    assert.doesNotMatch(message, /dsb adopt/, name);
  }

  const retry = await retryJob(readJob(job.id, home), 'again', () => {}, home);
  assert.equal(retry.processState, 'completed', retry.error);
});

test('adopting a live foreign job enables cancel, send, answer, and unlock', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-bridge-adopt-live-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'bridge'),
    id = '00000000-0000-4000-8000-000000000080';
  const dir = path.join(home, 'jobs', id),
    heartbeatFile = path.join(dir, 'heartbeat');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(heartbeatFile, '');

  const job = {
    version: 2,
    id,
    rootId: id,
    parentId: null,
    processState: 'running',
    supervisorPid: process.pid,
    childPid: null,
    heartbeatFile,
    pendingRequests: [{ requestId: 'request-1', method: 'user-question/ask', params: {} }],
    answeredQuestions: 0,
    questionCapLifted: false,
    owner: foreignOwner(await deadPid()),
    cwd: root,
    review: null,
    exitCode: null,
    reportedResult: null,
    startedAt: Date.now(),
  };
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job));

  for (const [name, run] of [
    ['cancel', () => cancelJob(readJob(id, home), home)],
    ['send', () => sendMessage(readJob(id, home), 'hello', home)],
    ['answer', () => answerRequest(readJob(id, home), 'request-1', { answers: [] }, home)],
  ])
    await assert.rejects(async () => run(), /Adopt it first: dsb adopt/, name);

  assert.equal(adoptJob(readJob(id, home), {}, home).adopted, true);

  assert.equal(cancelJob(readJob(id, home), home).cancelRequested, true);
  assert.ok(fs.existsSync(path.join(dir, 'cancel.request')));
  assert.match(sendMessage(readJob(id, home), 'hello', home).inputId, /^[a-f0-9-]{36}$/);
  assert.match(
    answerRequest(readJob(id, home), 'request-1', { answers: [] }, home).inputId,
    /^[a-f0-9-]{36}$/,
  );
  assert.equal(
    fs.readdirSync(path.join(dir, 'inbox')).filter((name) => name.endsWith('.json')).length,
    2,
  );

  // A stale heartbeat lets the adopted job be unlocked once its reservation is abandoned.
  const old = new Date(Date.now() - 2 * 60 * 1000);
  fs.utimesSync(heartbeatFile, old, old);
  const stateFile = path.join(home, 'scheduler', 'state.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      version: 1,
      nextSequence: 2,
      reservations: [
        {
          id,
          token: '00000000-0000-4000-8000-000000000081',
          supervisorPid: job.owner.pid,
          childPid: null,
          workspace: fs.realpathSync(root),
          scopes: [fs.realpathSync(root)],
          readOnly: false,
          exclusive: false,
          resources: [],
          maxConcurrent: 8,
          state: 'active',
          sequence: 1,
          queuedAt: Date.now(),
          startedAt: Date.now(),
        },
      ],
    }),
  );

  const unlocked = await unlockJob(readJob(id, home), true, home);
  assert.equal(unlocked.unlocked, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).reservations, []);
});

test('adoptJob takes over an orphan, refuses a live owner, and no-ops when already owned', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-bridge-adopt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'bridge'),
    id = '00000000-0000-4000-8000-000000000090';
  const dir = path.join(home, 'jobs', id),
    file = path.join(dir, 'job.json'),
    gone = foreignOwner(await deadPid());

  fs.mkdirSync(dir, { recursive: true });
  const job = {
    version: 2,
    id,
    rootId: id,
    parentId: null,
    processState: 'completed',
    cwd: root,
    review: null,
    pendingRequests: [],
  };
  fs.writeFileSync(file, JSON.stringify({ ...job, owner: gone }));

  const adopted = adoptJob(readJob(id, home), {}, home);
  assert.equal(adopted.adopted, true);
  assert.equal(adopted.previousOwner, gone.label);
  assert.equal(adopted.owner, currentOwner().label);
  assert.deepEqual(readJob(id, home).owner, currentOwner());

  const event = JSON.parse(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim());
  assert.equal(event.event, 'owner_adopted');
  assert.equal(event.from, gone.label);
  assert.equal(event.to, currentOwner().label);

  assert.deepEqual(adoptJob(readJob(id, home), {}, home), {
    id,
    adopted: false,
    owner: currentOwner().label,
    note: 'Already owned by this session',
  });

  const live = {
    id: 'a'.repeat(16),
    label: 'live-agent',
    pid: process.pid,
    startedAt: null,
    source: 'process',
  };
  fs.writeFileSync(file, JSON.stringify({ ...readJob(id, home), owner: live }));

  assert.throws(
    () => adoptJob(readJob(id, home), {}, home),
    /still held by live-agent, which is running.*--user-ok/,
  );
  assert.equal(adoptJob(readJob(id, home), { userOk: true }, home).adopted, true);
  assert.deepEqual(readJob(id, home).owner, currentOwner());
});

test('a record with no owner field stays operable by any session', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-bridge-no-owner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'bridge'),
    id = '00000000-0000-4000-8000-0000000000a0';

  const job = {
    version: 2,
    id,
    rootId: id,
    parentId: null,
    processState: 'completed',
    cwd: root,
    review: null,
    pendingRequests: [],
    exitCode: 0,
    reportedResult: 'OK',
  };
  saveRecord(home, job);

  assert.equal(cancelJob(readJob(id, home), home).cancelRequested, false);
  assert.equal(reviewJob(readJob(id, home), 'rework', 'note', home).acceptance, 'rework');
});

test('stats counts this session and unowned jobs, and --all counts every session', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-bridge-stats-owner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'bridge'),
    mine = currentOwner(),
    otherId = mine.id === 'f'.repeat(16) ? 'e'.repeat(16) : 'f'.repeat(16);

  const records = [
    { id: '00000000-0000-4000-8000-0000000000b0', owner: mine },
    { id: '00000000-0000-4000-8000-0000000000b1' },
    {
      id: '00000000-0000-4000-8000-0000000000b2',
      owner: { id: otherId, label: 'other-agent 42', pid: 999999, startedAt: 1, source: 'process' },
    },
  ];

  for (const record of records)
    saveRecord(home, {
      version: 2,
      rootId: record.id,
      parentId: null,
      processState: 'completed',
      cwd: root,
      review: null,
      pendingRequests: [],
      usage: null,
      ...record,
    });

  const own = stats(home);
  assert.equal(own.jobs, 2);
  assert.equal(own.otherSessionJobs, 1);
  assert.equal(own.counts, 'jobs started by this session');

  const every = stats(home, { all: true });
  assert.equal(every.jobs, 3);
  assert.equal(every.otherSessionJobs, 0);
  assert.equal(every.counts, 'every session sharing this DSH_HOME');
});

test('retired forwarding fields and events in old records are read without errors', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-bridge-legacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'bridge'),
    id = '00000000-0000-4000-8000-000000000060';
  const dir = path.join(home, 'jobs', id),
    requestId = '00000000-0000-4000-8000-000000000061';

  fs.mkdirSync(dir, { recursive: true });
  const job = {
    version: 2,
    id,
    parentId: null,
    rootId: id,
    processState: 'completed',
    supervisorPid: process.pid,
    pendingRequests: [],
    answeredQuestions: 0,
    forwardedQuestions: 1,
    hostDirectory: path.join(dir, 'host'),
    startedAt: Date.now(),
    review: null,
    exitCode: 0,
    reportedResult: 'OK',
    cwd: root,
    reportFile: path.join(dir, 'report.txt'),
    stderrFile: path.join(dir, 'stderr.log'),
    eventsFile: path.join(dir, 'events.jsonl'),
  };

  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job));
  fs.writeFileSync(
    job.eventsFile,
    [
      JSON.stringify({ event: 'request', requestId, method: 'user-question/ask', params: {} }),
      JSON.stringify({
        event: 'input_forwarded',
        inputId: requestId,
        requestId,
        receipt: 'awaiting-plugin-consumption',
      }),
      JSON.stringify({
        event: 'input_delivered',
        inputId: requestId,
        requestId,
        receipt: 'plugin-consumed',
      }),
    ].join('\n') + '\n',
  );

  const record = readJob(id, home),
    snapshot = status(record);
  assert.equal(snapshot.answeredQuestions, 0);
  assert.deepEqual(snapshot.pendingRequests, []);
  assert.deepEqual(
    eventsPage(record, 0, 10).events.map((event) => event.event),
    ['request', 'input_forwarded', 'input_delivered'],
  );

  assert.equal((await waitJob({ id }, 1, home)).reason, 'finished');
});

test('wait does not revive a request answered after the event scan', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-bridge-wait-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'bridge'),
    id = '00000000-0000-4000-8000-000000000040';
  const dir = path.join(home, 'jobs', id),
    requestId = '00000000-0000-4000-8000-000000000041';

  fs.mkdirSync(dir, { recursive: true });
  const job = {
    version: 2,
    id,
    parentId: null,
    rootId: id,
    processState: 'running',
    supervisorPid: process.pid,
    pendingRequests: [{ requestId, method: 'user-question/ask', params: {} }],
    startedAt: Date.now(),
    review: null,
    exitCode: null,
    reportedResult: null,
    cwd: root,
    reportFile: path.join(dir, 'report.txt'),
    stderrFile: path.join(dir, 'stderr.log'),
    eventsFile: path.join(dir, 'events.jsonl'),
  };

  const jobFile = path.join(dir, 'job.json'),
    eventsFile = path.join(dir, 'events.jsonl');
  fs.writeFileSync(jobFile, JSON.stringify(job));
  fs.writeFileSync(eventsFile, '');

  let delivered = false;
  const originalStat = fs.statSync,
    originalRead = fs.readFileSync;
  fs.statSync = (file, ...rest) => {
    const result = originalStat(file, ...rest);
    if (String(file) === eventsFile) delivered = true;
    return result;
  };
  fs.readFileSync = (file, ...rest) =>
    String(file) === jobFile && delivered
      ? JSON.stringify({ ...job, pendingRequests: [] })
      : originalRead(file, ...rest);

  let waited;
  try {
    waited = await waitJob({ id }, 1, home);
  } finally {
    fs.statSync = originalStat;
    fs.readFileSync = originalRead;
  }

  assert.equal(waited.reason, 'timeout');
  assert.deepEqual(waited.actionableRequests, []);
});

test('wait returns a pending request before an unreported context reminder', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-bridge-wait-context-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'bridge'),
    id = '00000000-0000-4000-8000-000000000070';
  const dir = path.join(home, 'jobs', id),
    requestId = '00000000-0000-4000-8000-000000000071';

  fs.mkdirSync(dir, { recursive: true });
  const job = {
    version: 2,
    id,
    parentId: null,
    rootId: id,
    processState: 'running',
    supervisorPid: process.pid,
    pendingRequests: [{ requestId, method: 'user-question/ask', params: {} }],
    answeredQuestions: 0,
    context: { tokens: 200000, at: Date.now() },
    contextLimit: 100,
    contextReminder: { tokens: 200000, threshold: 100, at: Date.now() },
    startedAt: Date.now(),
    review: null,
    exitCode: null,
    reportedResult: null,
    cwd: root,
    reportFile: path.join(dir, 'report.txt'),
    stderrFile: path.join(dir, 'stderr.log'),
    eventsFile: path.join(dir, 'events.jsonl'),
  };

  const jobFile = path.join(dir, 'job.json');
  fs.writeFileSync(jobFile, JSON.stringify(job));
  fs.writeFileSync(job.eventsFile, '');

  const marker = path.join(dir, 'context.reported');
  const request = await waitJob({ id }, 1, home);
  assert.equal(request.reason, 'request');
  assert.equal(fs.existsSync(marker), false);

  job.pendingRequests = [];
  fs.writeFileSync(jobFile, JSON.stringify(job));

  const context = await waitJob({ id }, 1, home);
  assert.equal(context.reason, 'context');
  assert.ok(fs.existsSync(marker));

  job.processState = 'completed';
  fs.writeFileSync(jobFile, JSON.stringify(job));
  assert.equal((await waitJob({ id }, 1, home)).reason, 'finished');
});

test('run time limit rejects zero with the real allowed range', async (t) => {
  const { options, home } = setup(t, 'timeout range');
  for (const timeout of [0, 86401])
    await assert.rejects(
      runJob({ ...options, timeout }, () => {}, home),
      /time-limit must be greater than 0 and at most 86400 seconds/,
    );
});

test('an inbox file whose rejection event cannot be written is reported and kept', async (t) => {
  const { options, home } = setup(t, 'inbox disposition');

  const originalAppend = fs.appendFileSync;
  fs.appendFileSync = (file, data, ...rest) => {
    if (typeof data === 'string' && data.includes('"input_rejected"'))
      throw new Error('simulated event cap');
    return originalAppend(file, data, ...rest);
  };
  let job;
  try {
    job = await runJob(
      options,
      (event) => {
        if (event.event === 'started')
          fs.writeFileSync(
            path.join(home, 'jobs', event.id, 'inbox', 'stray.json'),
            JSON.stringify({ id: 'stray', kind: 'message', data: { text: 'x' } }),
          );
      },
      home,
    );
  } finally {
    fs.appendFileSync = originalAppend;
  }

  assert.equal(job.processState, 'completed', job.error);
  assert.match(job.error, /Inbox disposition failed: stray: simulated event cap/);

  assert.match(fs.readFileSync(job.stderrFile, 'utf8'), /Inbox disposition failed:/);
  assert.ok(fs.existsSync(path.join(home, 'jobs', job.id, 'inbox', 'stray.json')));
});

test('review accepted requires exit code zero and an OK reported result', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-bridge-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'bridge'),
    id = '00000000-0000-4000-8000-000000000050';
  const dir = path.join(home, 'jobs', id);

  fs.mkdirSync(dir, { recursive: true });
  const job = {
    version: 2,
    id,
    rootId: id,
    parentId: null,
    processState: 'completed',
    supervisorPid: process.pid,
    pendingRequests: [],
    review: null,
    exitCode: 0,
    reportedResult: 'OK',
    cwd: root,
  };

  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job));

  for (const candidate of [
    { ...job, exitCode: 1 },
    { ...job, reportedResult: 'FAIL' },
  ])
    assert.throws(
      () => reviewJob(candidate, 'accepted', 'evidence', home),
      /cannot be marked accepted/,
    );

  assert.equal(reviewJob(job, 'accepted', 'evidence', home).acceptance, 'accepted');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8')).review.verdict,
    'accepted',
  );
});

test('accounting accepts an unknown host Cost key and stats aggregates it', async (t) => {
  const { options, home } = setup(t, 'accounting');

  const job = await runJob(options, () => {}, home);
  reviewJob(job, 'rework', 'needs another look', home, {
    currency: 'CNY',
    source: 'test',
    geminiCost: 1.5,
    deepseekCost: 2,
  });

  const group = stats(home).costsByCurrency.CNY;
  assert.equal(group.geminiCost, 1.5);
  assert.equal(group.geminiRecords, 1);
  assert.equal(group.deepseekCost, 2);
  assert.equal(group.deepseekRecords, 1);
  assert.equal(group.claudeCost, 0);
  assert.equal(group.codexRecords, 0);
});

test('accounting rejects negative unknown host costs', async (t) => {
  const { options, home } = setup(t, 'negative accounting');
  const job = await runJob(options, () => {}, home);
  assert.throws(
    () =>
      reviewJob(job, 'rework', 'look again', home, {
        currency: 'CNY',
        source: 'test',
        geminiCost: -1,
      }),
    /Costs must be nonnegative numbers/,
  );
});

test('legacy accounting keys keep their aggregate behavior', async (t) => {
  const { options, home } = setup(t, 'legacy accounting');

  const job = await runJob(options, () => {}, home);
  reviewJob(job, 'rework', 'look again', home, {
    currency: 'USD',
    source: 'test',
    claudeCost: 1,
    codexCost: 2.5,
    deepseekCost: 3,
  });

  assert.deepEqual(
    { ...stats(home).costsByCurrency.USD },
    {
      claudeCost: 1,
      codexCost: 2.5,
      deepseekCost: 3,
      claudeRecords: 1,
      codexRecords: 1,
      deepseekRecords: 1,
    },
  );
});

test('a null cost means unknown: it is accepted and neither summed nor counted', async (t) => {
  const { options, home } = setup(t, 'null accounting');

  const job = await runJob(options, () => {}, home);

  reviewJob(job, 'rework', 'look again', home, {
    currency: 'EUR',
    source: 'test',
    claudeCost: null,
    deepseekCost: 4,
  });

  const group = stats(home).costsByCurrency.EUR;
  assert.equal(group.claudeCost, 0);
  assert.equal(group.claudeRecords, 0);
  assert.equal(group.deepseekRecords, 1);
});

test('context limit from the option and environment is recorded and inherited by retry', async (t) => {
  const { options, home } = setup(t, 'context limit');

  const job = await runJob({ ...options, contextLimit: 5 }, () => {}, home);
  assert.equal(job.processState, 'completed', job.error);
  assert.equal(job.contextLimit, 5);
  assert.equal(job.context.tokens, 10);
  assert.equal(job.contextReminder.threshold, 5);

  const retry = await retryJob(job, 'again', () => {}, home);
  assert.equal(retry.contextLimit, 5);
  assert.equal(retry.processState, 'completed', retry.error);

  const previous = process.env.DPSK_CONTEXT_LIMIT;
  process.env.DPSK_CONTEXT_LIMIT = '7';

  try {
    const env = await runJob({ ...options, originalBrief: 'env context' }, () => {}, home);
    assert.equal(env.contextLimit, 7);
    assert.equal(env.contextReminder.threshold, 7);
  } finally {
    if (previous === undefined) delete process.env.DPSK_CONTEXT_LIMIT;
    else process.env.DPSK_CONTEXT_LIMIT = previous;
  }

  await assert.rejects(
    runJob({ ...options, contextLimit: 0 }, () => {}, home),
    /context-limit must be a positive integer/,
  );
});

test('status exposes question and context guard-rail fields', async (t) => {
  const { options, home } = setup(t, 'status limits');
  const job = await runJob({ ...options, contextLimit: 50 }, () => {}, home);
  assert.equal(job.processState, 'completed', job.error);
  const snapshot = status(job);
  assert.equal(snapshot.answeredQuestions, 0);
  assert.equal(snapshot.questionLimit, 3);
  assert.equal(snapshot.questionCapLifted, false);
  assert.equal(snapshot.contextLimit, 50);
  assert.equal(snapshot.context.tokens, 10);
  assert.equal(snapshot.contextReminder, null);
});

test('briefText uses the caller label in its errors', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-bridge-brief-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const long = path.join(root, 'long.md'),
    blank = path.join(root, 'blank.md');
  fs.writeFileSync(long, 'x'.repeat(48001));
  fs.writeFileSync(blank, ' \n');
  assert.throws(() => briefText(long), /Brief is too long: use concise goals/);
  assert.throws(() => briefText(long, 'Message'), /Message file is too long \(limit 48000 bytes\)/);
  assert.throws(() => briefText(blank), /Brief must not be blank/);
  assert.throws(() => briefText(blank, 'Answer'), /Answer must not be blank/);
});

test('a job queued behind another keeps its whole time limit', async (t) => {
  // One slot, so the second job waits for longer than its own limit. The limit
  // runs from startup, so waiting must not consume any of it.
  const holder = setup(t, '[hold] occupy the only slot');
  const waiter = setup(t, 'simple');

  let announceStart;
  const holderRunning = new Promise((resolve) => {
    announceStart = resolve;
  });

  const holderJob = runJob(
    { ...holder.options, timeout: 3, maxConcurrent: 1 },
    (event) => {
      if (event.event === 'started') announceStart();
    },
    holder.home,
  );
  await holderRunning;

  const waiterJob = await runJob(
    { ...waiter.options, timeout: 2, maxConcurrent: 1 },
    () => {},
    holder.home,
  );
  await holderJob;

  const waited = waiterJob.runningAt - waiterJob.startedAt;
  assert.ok(waited > 2000, `expected a wait longer than the 2s limit, got ${waited}ms`);
  assert.equal(waiterJob.processState, 'completed', waiterJob.error);
});
