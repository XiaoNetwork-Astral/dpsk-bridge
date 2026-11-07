import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { flushInput, parseInput, runSnapshot, toggleOwnerFilter } from '../lib/viewer/app.mjs';
import { show, watch } from '../lib/viewer/cli.mjs';
import { createSessionStore } from '../lib/viewer/store.mjs';
import { createEventReader, listSessionFiles } from '../lib/sessions.mjs';

const cli = fileURLToPath(new URL('../bin/dsv.mjs', import.meta.url));
const plain = (text) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');

// Injected into the TUI child process: a tiny virtual terminal that applies the
// row-addressed writes of the screen differ, so tests read what the user sees.
const VT = String.raw`const screen=[];const apply=s=>{s=String(s);if(s.includes('\x1b[2J'))screen.length=0;
const p=s.split(/\x1b\[(\d+);1H/);for(let i=1;i<p.length;i+=2)screen[p[i]-1]=p[i+1].replace(/\x1b\[0J[\s\S]*$/,'');
const m=/\x1b\[(\d+);1H\x1b\[0J/.exec(s);if(m)screen.length=m[1]-1;return p.length>1;};
const view=()=>Array.from(screen,l=>l??'').join('\r\n');`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsv-reading-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let seq = 0;
  const event = (type, data) => ({ type, seq: ++seq, time: 1700000000000 + seq, data });

  const events = [
    { type: 'session', version: 4, id: 'reading', cwd: '/work/bridge', createdAt: 1700000000000 },
    event('session/title', { title: '优化会话查看器' }),
    event('turn/start', { turn: 1 }),
    event('user/message', {
      source: { kind: 'user' },
      content: [
        {
          type: 'text',
          text: '减少阅读负担，保留完整过程。\n\n【桥接报告约定】INTERNAL_BRIDGE_CONTRACT',
        },
      ],
    }),
  ];

  for (let i = 0; i < 80; i++) {
    events.push(
      event('tool/call', {
        turn: 1,
        step: i,
        callId: `call-${i}`,
        name: 'read_file',
        arguments: JSON.stringify({ path: `/work/bridge/src/file-${i}.mjs` }),
      }),
      event('tool/result', {
        turn: 1,
        step: i,
        message: {
          role: 'tool',
          toolCallId: `call-${i}`,
          content: [
            { type: 'text', text: `SUCCESS_TOOL_DUMP_${i}\n` + 'long output '.repeat(100) },
          ],
        },
      }),
    );
  }

  events.push(
    event('assistant/message', {
      turn: 1,
      step: 81,
      message: {
        content: [
          { type: 'reasoning', text: 'HIDDEN_REASONING' },
          {
            type: 'text',
            text: 'RESULT: OK\n已完成阅读界面调整。\n\n- 结果优先显示\n- 完整过程按需展开\n- 任务之间不再自动跳转',
          },
        ],
      },
    }),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  );

  const dir = path.join(root, 'project', 'reading');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'session.v4.jsonl'),
    events.map(JSON.stringify).join('\n') + '\n',
  );

  return root;
}

function writeSimpleSession(
  root,
  id,
  { title = `TASK_${id}`, answer = `ANSWER_${id}`, mtime = Date.now() } = {},
) {
  const directory = path.join(root, 'project', id);
  fs.mkdirSync(directory, { recursive: true });

  const rows = [
    { type: 'session', version: 4, id, cwd: `/work/${id}`, createdAt: mtime - 1000 },
    { type: 'session/title', seq: 1, time: mtime - 1000, data: { title } },
    { type: 'turn/start', seq: 2, time: mtime - 1000, data: { turn: 1 } },
    {
      type: 'assistant/message',
      seq: 3,
      time: mtime - 1000,
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: answer }] } },
    },
    {
      type: 'turn/end',
      seq: 4,
      time: mtime - 1000,
      data: { turn: 1, reason: { kind: 'completed' } },
    },
  ];

  const file = path.join(directory, 'session.v4.jsonl');
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
  fs.utimesSync(file, new Date(mtime), new Date(mtime));

  return file;
}

function writeReasonSession(root, id, reason, { title = `TASK_${id}`, mtime = Date.now() } = {}) {
  const directory = path.join(root, 'project', id);
  fs.mkdirSync(directory, { recursive: true });
  const rows = [
    { type: 'session', version: 4, id, cwd: `/work/${id}`, createdAt: mtime - 1000 },
    { type: 'session/title', seq: 1, time: mtime - 1000, data: { title } },
    { type: 'turn/start', seq: 2, time: mtime - 1000, data: { turn: 1 } },
    { type: 'turn/end', seq: 3, time: mtime - 1000, data: { turn: 1, reason } },
  ];
  const file = path.join(directory, 'session.v4.jsonl');
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
  fs.utimesSync(file, new Date(mtime), new Date(mtime));
  return file;
}

test('default CLI shows the answer before a single process summary and hides technical clutter', (t) => {
  const root = fixture(t);
  const run = (flags) =>
    spawnSync(process.execPath, [cli, 'show', 'reading', ...flags], {
      encoding: 'utf8',
      env: { ...process.env, DSH_SESSIONS_ROOT: root },
    });

  const compact = run([]);
  assert.equal(compact.status, 0, compact.stderr);
  assert.match(compact.stdout, /已完成阅读界面调整/);
  assert.match(compact.stdout, /80 tool calls/);
  for (const hidden of [
    'HIDDEN_REASONING',
    'SUCCESS_TOOL_DUMP',
    'INTERNAL_BRIDGE_CONTRACT',
    'cacheReadTokens',
    'format v4',
  ])
    assert.ok(!compact.stdout.includes(hidden), hidden);
  assert.ok(compact.stdout.indexOf('已完成阅读界面调整') < compact.stdout.indexOf('减少阅读负担'));
  assert.ok(compact.stdout.split('\n').length < 25);

  const processView = run(['--details']);
  assert.equal(processView.status, 0, processView.stderr);
  assert.match(processView.stdout, /src\/file-0.mjs/);

  const full = run(['--full', '--reasoning']);
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /SUCCESS_TOOL_DUMP/);
  assert.match(full.stdout, /HIDDEN_REASONING/);
});

test('long answers and full tool output remain complete and terminal controls are removed', (t) => {
  const root = fixture(t),
    file = path.join(root, 'project', 'reading', 'session.v4.jsonl');

  const events = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  const control = '\x1b]0;HOSTILE_TITLE\x07\x1b[2J';
  events[0].cwd = '/work/' + control + 'bridge';
  events[1].data.title = control + '任务';
  const long = Array.from({ length: 2105 }, (_, i) => `line-${i}`).join('\n');

  events.find((e) => e.type === 'assistant/message').data.message.content = [
    { type: 'text', text: control + long },
  ];
  events.find((e) => e.type === 'tool/result').data.message.content = [
    { type: 'text', text: control + long },
  ];
  events.find((e) => e.type === 'tool/call').data.arguments = JSON.stringify({
    command: control + 'safe-command',
  });
  fs.writeFileSync(file, events.map(JSON.stringify).join('\n') + '\n');

  for (const flags of [[], ['--full'], ['--all']]) {
    const result = spawnSync(process.execPath, [cli, 'show', 'reading', ...flags], {
      encoding: 'utf8',
      env: { ...process.env, DSH_SESSIONS_ROOT: root },
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /line-2104/);
    assert.ok(!result.stdout.includes('\x1b[2J'));
    assert.ok(!result.stdout.includes('\x1b]0;'));
    if (flags.includes('--full')) assert.equal(result.stdout.match(/line-2104/g).length, 2);
  }
});

test('actual TUI frame stays readable at wide and narrow sizes and exposes process/help via keys', (t) => {
  const root = fixture(t);
  for (const columns of [128, 80]) {
    const script = `
${VT}
const snaps=[];const stdout=process.stdout.write.bind(process.stdout);
Object.defineProperty(process.stdout,'isTTY',{value:true});Object.defineProperty(process.stdin,'isTTY',{value:true});
Object.defineProperty(process.stdout,'columns',{value:${columns}});Object.defineProperty(process.stdout,'rows',{value:30});
process.stdin.setRawMode=()=>{};process.stdout.write=s=>{apply(s);return true;};
process.argv=['node',${JSON.stringify(cli)},'--no-update-check'];await import(${JSON.stringify(pathToFileURL(cli).href)});
snaps.push(view());for(const k of ['\\r','d','?','?']){process.stdin.emit('data',Buffer.from(k));snaps.push(view());}
stdout(JSON.stringify(snaps));process.exit(0);`;

    const output = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, DSH_SESSIONS_ROOT: root },
      timeout: 15000,
    });
    assert.equal(output.status, 0, output.stderr);

    // Snapshots: start (list focused), Enter (reading view), d (process view), ? (help), ? (help closed).
    const [start, reading, processView, help, closed] = JSON.parse(output.stdout).map(plain);
    assert.match(start, /优化会话查看器/);
    if (columns >= 100) assert.match(start, /已完成阅读界面调整/);
    assert.match(reading, /Result/);
    assert.match(reading, /已完成阅读界面调整/);
    assert.ok(!reading.includes('SUCCESS_TOOL_DUMP'));
    assert.ok(!reading.includes('HIDDEN_REASONING'));
    assert.match(processView, /src\/file-0.mjs/);
    assert.match(help, /Anywhere +Tab/);
    assert.ok(!closed.includes('Shift+Tab'));
    for (const frame of [start, reading, processView, help, closed])
      assert.ok(frame.split('\r\n').length <= 30);
  }
});

test('new sessions do not steal the current reading position and explicit navigation still switches', (t) => {
  const root = fixture(t);

  const script = `
import fs from 'node:fs';import path from 'node:path';
${VT}
const frames=[],timers=[];const stdout=process.stdout.write.bind(process.stdout);
globalThis.setInterval=(callback,ms)=>{timers.push({callback,ms});return 1;};
Object.defineProperty(process.stdout,'isTTY',{value:true});Object.defineProperty(process.stdin,'isTTY',{value:true});
Object.defineProperty(process.stdout,'columns',{value:128});Object.defineProperty(process.stdout,'rows',{value:30});
process.stdin.setRawMode=()=>{};process.stdout.write=s=>{if(apply(s))frames.push(view());return true;};
process.argv=['node',${JSON.stringify(cli)},'--no-update-check'];await import(${JSON.stringify(pathToFileURL(cli).href)});
const dir=path.join(process.env.DSH_SESSIONS_ROOT,'project','new');fs.mkdirSync(dir,{recursive:true});
const rows=[{type:'session',version:4,id:'new',cwd:'/work/new',createdAt:Date.now()},
{type:'session/title',seq:1,data:{title:'新到达的会话'}},{type:'turn/start',seq:2,data:{turn:1}},
{type:'assistant/message',seq:3,data:{turn:1,message:{content:[{type:'text',text:'NEW_SESSION_RESULT'}]}}},
{type:'turn/end',seq:4,data:{turn:1,reason:{kind:'completed'}}}];
fs.writeFileSync(path.join(dir,'session.v4.jsonl'),rows.map(JSON.stringify).join('\\n')+'\\n');
fs.utimesSync(path.join(dir,'session.v4.jsonl'),new Date(),new Date(Date.now()+2000));
timers.find(t=>t.ms===1000).callback();
process.stdin.emit('data',Buffer.from('gjj'));stdout(JSON.stringify(frames));process.exit(0);`;

  const output = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, DSH_SESSIONS_ROOT: root },
    timeout: 15000,
  });
  assert.equal(output.status, 0, output.stderr);

  const frames = JSON.parse(output.stdout).map(plain);
  assert.match(frames[1], /新到达的会话/);
  assert.match(frames[1], /已完成阅读界面调整/);
  assert.ok(!frames[1].includes('NEW_SESSION_RESULT'));
  assert.match(frames.at(-1), /NEW_SESSION_RESULT/);
});

test('groups fold with keyboard and mouse, retain reading state, and stay folded on refresh', (t) => {
  const root = fixture(t),
    now = new Date(2026, 0, 15, 12).getTime();
  const reading = path.join(root, 'project', 'reading', 'session.v4.jsonl');
  fs.utimesSync(reading, new Date(now), new Date(now));

  for (const [id, days] of [
    ['today-other', 0],
    ['yesterday', 1],
    ['week', 3],
    ['older', 12],
  ]) {
    const dir = path.join(root, 'project', id);
    fs.mkdirSync(dir, { recursive: true });

    const events = [
      { type: 'session', version: 4, id, cwd: '/work/' + id, createdAt: now },
      { type: 'session/title', seq: 1, data: { title: 'TASK_' + id } },
      { type: 'turn/start', seq: 2, data: { turn: 1 } },
      {
        type: 'assistant/message',
        seq: 3,
        data: { turn: 1, message: { content: [{ type: 'text', text: 'ANSWER_' + id }] } },
      },
      { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    ];

    const file = path.join(dir, 'session.v4.jsonl');
    fs.writeFileSync(file, events.map(JSON.stringify).join('\n') + '\n');
    fs.utimesSync(file, new Date(now), new Date(now - days * 86400000 - 60000));
  }

  for (const columns of [128, 80]) {
    const script = `
${VT}
const frames={},timers=[];let current='';const stdout=process.stdout.write.bind(process.stdout);Date.now=()=>${now};
globalThis.setInterval=(callback,ms)=>{timers.push({callback,ms});return 1;};
Object.defineProperty(process.stdout,'isTTY',{value:true});Object.defineProperty(process.stdin,'isTTY',{value:true});
Object.defineProperty(process.stdout,'columns',{value:${columns}});Object.defineProperty(process.stdout,'rows',{value:20});
process.stdin.setRawMode=()=>{};process.stdout.write=s=>{if(apply(s))current=view();return true;};
process.argv=['node',${JSON.stringify(cli)},'--no-update-check'];await import(${JSON.stringify(pathToFileURL(cli).href)});
const key=s=>process.stdin.emit('data',Buffer.from(s));
frames.initial=current;key('g\\r');frames.folded=current;
timers.find(t=>t.ms===1000).callback();frames.refreshed=current;
key('jjj');frames.readingYesterday=current;
key('\\x1b[D');frames.leftFold=current;key('\\x1b[C');frames.rightOpen=current;
key('jj ');frames.weekOpen=current;
key('\\x1b[<0;4;3M');frames.mouseOpen=current;key('\\x1b[<0;4;3M');frames.mouseFold=current;
stdout(JSON.stringify(frames));process.exit(0);`;

    const output = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, DSH_SESSIONS_ROOT: root },
      timeout: 15000,
    });
    assert.equal(output.status, 0, output.stderr);

    const frames = Object.fromEntries(
      Object.entries(JSON.parse(output.stdout)).map(([key, value]) => [key, plain(value)]),
    );

    const sidebar = (frame) =>
      frame
        .split('\r\n')
        .slice(1, -1)
        .map((line) => (columns >= 100 ? (line.split('│')[1] ?? '') : line))
        .join('\n');

    const initial = sidebar(frames.initial);

    // Both sessions ended within the last minutes, so they are still under 运行中 › 刚结束.
    assert.match(initial, /▾ Running/);
    assert.match(initial, /▾ Just ended/);
    assert.match(initial, /▾ Finished/);
    assert.match(initial, /▾ 2026-1-14 /);
    assert.match(initial, /▸ 2026-1-12 /);
    assert.match(initial, /▸ 2026-1-3 /);
    assert.match(initial, /TASK_yesterday/, 'the newest day is open');
    assert.ok(!initial.includes('TASK_week'));

    assert.match(sidebar(frames.folded), /▸ Running/);
    assert.ok(!sidebar(frames.folded).includes('优化会话查看器'));
    assert.match(sidebar(frames.refreshed), /▸ Running/);
    if (columns >= 100) assert.match(frames.folded, /已完成阅读界面调整/);
    if (columns >= 100) assert.match(frames.readingYesterday, /ANSWER_yesterday/);
    else assert.match(sidebar(frames.readingYesterday), /▌ +✓ TASK_yesterday/);

    assert.match(sidebar(frames.leftFold), /▸ 2026-1-14 /);
    assert.ok(!sidebar(frames.leftFold).includes('TASK_yesterday'));
    assert.match(sidebar(frames.rightOpen), /TASK_yesterday/);
    assert.match(sidebar(frames.weekOpen), /▾ 2026-1-12 /);
    assert.match(sidebar(frames.weekOpen), /TASK_week/);
    assert.match(sidebar(frames.mouseOpen), /▾ Running/);
    assert.match(sidebar(frames.mouseFold), /▸ Running/);
    for (const frame of Object.values(frames)) assert.ok(frame.split('\r\n').length <= 20);
  }
});

test('mouse wheel scrolls the transcript without moving the highlighted block', (t) => {
  const root = fixture(t);

  const script = `
${VT}
const frames={},timers=[];let current='';const stdout=process.stdout.write.bind(process.stdout);
globalThis.setInterval=(callback,ms)=>{timers.push({callback,ms});return 1;};
Object.defineProperty(process.stdout,'isTTY',{value:true});Object.defineProperty(process.stdin,'isTTY',{value:true});
Object.defineProperty(process.stdout,'columns',{value:128});Object.defineProperty(process.stdout,'rows',{value:20});
process.stdin.setRawMode=()=>{};process.stdout.write=s=>{if(apply(s))current=view();return true;};
process.argv=['node',${JSON.stringify(cli)},'--no-update-check'];await import(${JSON.stringify(pathToFileURL(cli).href)});
const key=s=>process.stdin.emit('data',Buffer.from(s));
key('\\tdjj');frames.cursor=current;
for(let i=0;i<4;i++)key('\\x1b[<65;80;10M');frames.wheeled=current;
key('j');frames.resumed=current;
stdout(JSON.stringify(frames));process.exit(0);`;

  const output = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, DSH_SESSIONS_ROOT: root },
    timeout: 15000,
  });
  assert.equal(output.status, 0, output.stderr);

  const frames = Object.fromEntries(
    Object.entries(JSON.parse(output.stdout)).map(([key, value]) => [key, plain(value)]),
  );

  // Detail rows carry the highlight bar right after the detail box's left border.
  const highlighted = (frame) =>
    frame
      .split('\r\n')
      .slice(2, -2)
      .map((line, index) => [index, line])
      .filter(([, line]) => line.indexOf('│▌', 1) > 0);

  const before = highlighted(frames.cursor);
  assert.ok(
    before.length > 0 && before[0][0] > 0,
    'the cursor starts below the first transcript row',
  );
  assert.notEqual(frames.wheeled, frames.cursor, 'the wheel scrolled the transcript');

  // Old behavior moved the highlight to the first visible block; now it stays on its block, now off screen.
  assert.deepEqual(
    highlighted(frames.wheeled),
    [],
    'the highlighted block scrolled away instead of jumping',
  );

  const resumed = highlighted(frames.resumed);
  assert.ok(
    resumed.length > 0 && resumed[0][0] === 0,
    'the next key press resumes from the top of what is on screen',
  );
});

test('keyboard covers group folding, jumping to running sessions, free scrolling and modal help', (t) => {
  const root = fixture(t),
    now = new Date(2026, 0, 15, 12).getTime();
  fs.utimesSync(
    path.join(root, 'project', 'reading', 'session.v4.jsonl'),
    new Date(now),
    new Date(now - 3 * 86400000),
  );

  // Two running sessions (open turn, fresh) and one finished yesterday.
  for (const [id, open, days] of [
    ['run-a', true, 0],
    ['run-b', true, 0],
    ['done-y', false, 1],
  ]) {
    const dir = path.join(root, 'project', id);
    fs.mkdirSync(dir, { recursive: true });

    const events = [
      { type: 'session', version: 4, id, cwd: '/work/' + id, createdAt: now },
      { type: 'session/title', seq: 1, data: { title: 'TASK_' + id } },
      { type: 'turn/start', seq: 2, data: { turn: 1 } },
      {
        type: 'assistant/message',
        seq: 3,
        data: { turn: 1, message: { content: [{ type: 'text', text: 'ANSWER_' + id }] } },
      },
      ...(open
        ? []
        : [{ type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } }]),
    ];

    const file = path.join(dir, 'session.v4.jsonl');
    fs.writeFileSync(file, events.map(JSON.stringify).join('\n') + '\n');
    fs.utimesSync(
      file,
      new Date(now),
      new Date(now - days * 86400000 - (id === 'run-b' ? 1000 : 0)),
    );
  }

  const script = `
${VT}
const frames={},timers=[];let current='';const stdout=process.stdout.write.bind(process.stdout);Date.now=()=>${now};
globalThis.setInterval=(callback,ms)=>{timers.push({callback,ms});return 1;};
Object.defineProperty(process.stdout,'isTTY',{value:true});Object.defineProperty(process.stdin,'isTTY',{value:true});
Object.defineProperty(process.stdout,'columns',{value:128});Object.defineProperty(process.stdout,'rows',{value:24});
process.stdin.setRawMode=()=>{};process.stdout.write=s=>{if(apply(s))current=view();return true;};
process.argv=['node',${JSON.stringify(cli)},'--no-update-check'];await import(${JSON.stringify(pathToFileURL(cli).href)});
const key=s=>process.stdin.emit('data',Buffer.from(s));
frames.initial=current;key('z');frames.folded=current;key('Z');frames.opened=current;
key('n');frames.next1=current;key('n');frames.next2=current;key('n');frames.next3=current;
key('?');frames.help=current;key('\\x1b[<0;10;5M');frames.helpClick=current;key('\\x1b');
const closeDeadline=Date.now()+2000;
while(current.includes('Help  ? to close')){if(Date.now()>closeDeadline)throw new Error('help did not close');await new Promise(resolve=>setTimeout(resolve,10));}
frames.helpClosed=current;
stdout(JSON.stringify(frames));process.exit(0);`;

  const output = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, DSH_SESSIONS_ROOT: root },
    timeout: 15000,
  });
  assert.equal(output.status, 0, output.stderr);

  const frames = Object.fromEntries(
    Object.entries(JSON.parse(output.stdout)).map(([key, value]) => [key, plain(value)]),
  );
  const sidebar = (frame) =>
    frame
      .split('\r\n')
      .slice(1, -1)
      .map((line) => line.split('│')[1] ?? '')
      .join('\n');

  assert.match(sidebar(frames.initial), /▸ 2026-1-12 /, 'older days start folded');
  assert.match(sidebar(frames.folded), /▸ Running/);
  assert.match(sidebar(frames.folded), /▸ Finished/);
  assert.ok(!sidebar(frames.folded).includes('TASK_'), 'z folds every group');
  for (const label of [/▾ Running/, /▾ Finished/, /▾ 2026-1-14 /, /▾ 2026-1-12 /])
    assert.match(sidebar(frames.opened), label);

  // n cycles through the running sessions and shows each transcript.
  const title = (frame) => frame.split('\r\n')[1];
  const firstRun = /TASK_run-(a|b)/.exec(title(frames.next1))?.[1];
  assert.ok(firstRun, title(frames.next1));
  assert.match(title(frames.next2), new RegExp('TASK_run-' + (firstRun === 'a' ? 'b' : 'a')));
  assert.match(title(frames.next3), new RegExp('TASK_run-' + firstRun));

  // Help is modal: a click on the list underneath changes nothing.
  assert.match(frames.help, /Help  \? to close/);
  assert.equal(frames.helpClick, frames.help);
  assert.doesNotMatch(frames.helpClosed, /Help  \? to close/);
});

test('Ctrl+D scrolls the transcript like the wheel while PgDn moves the highlight along', (t) => {
  const root = fixture(t);

  const script = `
${VT}
const frames={},timers=[];let current='';const stdout=process.stdout.write.bind(process.stdout);
globalThis.setInterval=(callback,ms)=>{timers.push({callback,ms});return 1;};
Object.defineProperty(process.stdout,'isTTY',{value:true});Object.defineProperty(process.stdin,'isTTY',{value:true});
Object.defineProperty(process.stdout,'columns',{value:128});Object.defineProperty(process.stdout,'rows',{value:20});
process.stdin.setRawMode=()=>{};process.stdout.write=s=>{if(apply(s))current=view();return true;};
process.argv=['node',${JSON.stringify(cli)},'--no-update-check'];await import(${JSON.stringify(pathToFileURL(cli).href)});
const key=s=>process.stdin.emit('data',Buffer.from(s));
key('\\tdjj');frames.cursor=current;key('\\x04\\x04');frames.ctrlD=current;
key('gjj');key('\\x1b[6~');frames.pageDown=current;
stdout(JSON.stringify(frames));process.exit(0);`;

  const output = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, DSH_SESSIONS_ROOT: root },
    timeout: 15000,
  });
  assert.equal(output.status, 0, output.stderr);

  const frames = Object.fromEntries(
    Object.entries(JSON.parse(output.stdout)).map(([key, value]) => [key, plain(value)]),
  );

  const highlighted = (frame) =>
    frame
      .split('\r\n')
      .slice(2, -2)
      .filter((line) => line.indexOf('│▌', 1) > 0);

  assert.ok(highlighted(frames.cursor).length > 0);
  assert.notEqual(frames.ctrlD, frames.cursor, 'Ctrl+D scrolled');
  assert.deepEqual(
    highlighted(frames.ctrlD),
    [],
    'the highlight stayed on its block, now off screen',
  );
  assert.ok(highlighted(frames.pageDown).length > 0, 'PgDn brings the highlight onto the new page');
});

test('the transcript follows output appended after the wheel or j reaches the bottom until a wheel-up parks it', (t) => {
  const root = fixture(t);

  // Appended records use the same assistant/message shape as the fixture. Each
  // one adds a single process-view line after the transcript's current end.
  const script = `
import fs from 'node:fs';import path from 'node:path';
${VT}
const frames={},timers=[];let current='';const stdout=process.stdout.write.bind(process.stdout);
globalThis.setInterval=(callback,ms)=>{timers.push({callback,ms});return 1;};
Object.defineProperty(process.stdout,'isTTY',{value:true});Object.defineProperty(process.stdin,'isTTY',{value:true});
Object.defineProperty(process.stdout,'columns',{value:128});Object.defineProperty(process.stdout,'rows',{value:20});
process.stdin.setRawMode=()=>{};process.stdout.write=s=>{if(apply(s))current=view();return true;};
process.argv=['node',${JSON.stringify(cli)},'--no-update-check'];await import(${JSON.stringify(pathToFileURL(cli).href)});
const key=s=>process.stdin.emit('data',Buffer.from(s));
const tick=()=>timers.find(t=>t.ms===1000).callback();
const file=path.join(process.env.DSH_SESSIONS_ROOT,'project','reading','session.v4.jsonl');
let seq=5000;
const append=text=>fs.appendFileSync(file,JSON.stringify({type:'assistant/message',seq:++seq,time:Date.now(),data:{turn:2,step:seq,message:{content:[{type:'text',text}]}}})+'\\n');
const wheelDown=()=>key('\\x1b[<65;80;10M'),wheelUp=()=>key('\\x1b[<64;80;10M');
key('\\td');
frames.start=current;
for(let i=0;i<60;i++)wheelDown();
frames.bottom=current;
append('FOLLOW_WHEEL_ONE appended after the wheel reached the bottom');
tick();frames.wheelFollow=current;
wheelUp();frames.wheelUp=current;
append('FOLLOW_WHEEL_TWO appended after one wheel-up step');
tick();frames.wheelParked=current;
key('g'+'j'.repeat(200));frames.jBottom=current;
append('FOLLOW_J_ONE appended after j reached the last block');
tick();frames.jFollow=current;
key('gG');frames.goBottom=current;
append('FOLLOW_G_ONE appended after G');
tick();frames.goBottomFollow=current;
stdout(JSON.stringify(frames));process.exit(0);`;

  const output = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, DSH_SESSIONS_ROOT: root },
    timeout: 15000,
  });

  assert.equal(output.status, 0, output.stderr);

  const frames = Object.fromEntries(
    Object.entries(JSON.parse(output.stdout)).map(([key, value]) => [key, plain(value)]),
  );

  // Content rows of the detail box, without the top/bottom borders or footer.
  const detailRows = (frame) => frame.split('\r\n').slice(2, -2);

  // The pane's right edge carries a scroll thumb that moves as the log grows.
  const detailBody = (frame) => detailRows(frame).map((line) => line.slice(0, -1));

  // 1. The wheel reached the bottom, then appended output stays in view.
  assert.ok(!frames.start.includes('已完成阅读界面调整'), 'the process view starts at the top');
  assert.match(
    frames.bottom,
    /已完成阅读界面调整/,
    'the wheel scrolled to the bottom before appending',
  );
  assert.match(
    detailRows(frames.wheelFollow).at(-1),
    /FOLLOW_WHEEL_ONE/,
    'the view followed output appended after the wheel reached the bottom',
  );

  // 2. One wheel-up step parks the view: later output must not pull it back down.
  assert.notEqual(frames.wheelUp, frames.wheelFollow, 'the wheel-up moved the view');
  assert.match(
    frames.jBottom,
    /FOLLOW_WHEEL_TWO/,
    'the last existing block was reached later from the top',
  );
  assert.ok(
    !frames.wheelParked.includes('FOLLOW_WHEEL_TWO'),
    'the parked view does not jump to appended output',
  );
  assert.deepEqual(
    detailBody(frames.wheelParked),
    detailBody(frames.wheelUp),
    'the parked view stayed where it was',
  );

  // 3. Moving down with j onto the last block resumes following.
  assert.match(
    detailRows(frames.jFollow).at(-1),
    /FOLLOW_J_ONE/,
    'the view followed output appended after j reached the last block',
  );

  // 4. G still follows.
  assert.match(
    frames.goBottom,
    /FOLLOW_J_ONE/,
    'G jumped to the bottom of the existing transcript',
  );
  assert.match(
    detailRows(frames.goBottomFollow).at(-1),
    /FOLLOW_G_ONE/,
    'G followed output appended afterwards',
  );
});

test('split escape sequences wait for the next chunk while a lone Escape is flushed', () => {
  const arrow = { pending: '' };
  assert.deepEqual(parseInput('\x1b[', arrow), []);
  assert.deepEqual(
    parseInput('A', arrow).map((token) => token.key),
    ['up'],
  );
  const mouse = { pending: '' };
  assert.deepEqual(parseInput('\x1b[<0;4', mouse), []);
  const [event] = parseInput(';10M', mouse);
  assert.deepEqual(event, { type: 'mouse', button: 0, x: 4, y: 10, press: true });
  const lone = { pending: '' };
  assert.deepEqual(parseInput('\x1b', lone), []);
  assert.deepEqual(
    flushInput(lone).map((token) => token.key),
    ['escape'],
  );
  const noContinue = { pending: '' };
  assert.deepEqual(parseInput('\x1b', noContinue), []);
  assert.deepEqual(
    parseInput('A', noContinue).map((token) => token.key),
    ['escape', 'A'],
  );
});

test('merged plan calls keep the header and reading overview tool-call counts equal', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsv-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let seq = 0;
  const event = (type, data) => ({ type, seq: ++seq, time: 1700000000000 + seq, data });

  const rows = [
    { type: 'session', version: 4, id: 'plan-count', cwd: '/work/plan', createdAt: 1700000000000 },
    event('session/title', { title: 'PLAN_COUNT_TASK' }),
    event('turn/start', { turn: 1 }),
    event('user/message', {
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'plan the work' }],
    }),
    event('tool/call', {
      turn: 1,
      step: 1,
      callId: 'plan-1',
      name: 'todo_write',
      arguments: JSON.stringify({ todos: [{ content: 'one' }] }),
    }),
    event('tool/result', {
      turn: 1,
      step: 1,
      message: { role: 'tool', toolCallId: 'plan-1', content: [{ type: 'text', text: 'saved' }] },
    }),
    event('tool/call', {
      turn: 1,
      step: 2,
      callId: 'plan-2',
      name: 'todo_write',
      arguments: JSON.stringify({ todos: [{ content: 'two' }] }),
    }),
    event('tool/result', {
      turn: 1,
      step: 2,
      message: { role: 'tool', toolCallId: 'plan-2', content: [{ type: 'text', text: 'saved' }] },
    }),
    event('tool/call', {
      turn: 1,
      step: 3,
      callId: 'shell-1',
      name: 'shell',
      arguments: JSON.stringify({ command: 'false' }),
    }),
    event('tool/result', {
      turn: 1,
      step: 3,
      message: {
        role: 'tool',
        toolCallId: 'shell-1',
        isError: true,
        content: [{ type: 'text', text: 'failed' }],
      },
    }),
    event('assistant/message', {
      turn: 1,
      step: 4,
      message: { content: [{ type: 'text', text: 'RESULT: FAIL\nonly the plan was saved' }] },
    }),
    event('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { message: 'provider failure' } },
    }),
  ];

  const directory = path.join(root, 'project', 'plan-count');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'session.v4.jsonl'),
    rows.map(JSON.stringify).join('\n') + '\n',
  );

  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));

  const run = (flags) => {
    lines.length = 0;
    show('plan-count', flags, { root });
    return lines.join('\n');
  };

  const full = run({ full: true }),
    reading = run({});
  const headerCount = Number(/(\d+) tool call/.exec(full)?.[1]);
  const overviewCount = Number(/(\d+) tool call/.exec(reading)?.[1]);
  assert.equal(headerCount, 3, 'two plan calls plus one failed tool call');
  assert.equal(overviewCount, headerCount);

  assert.match(reading, /\(2 plan updates shown as one note\)/);
  assert.match(full, /✗ Failed/);
});

test('show reports a read error as one line instead of throwing', (t) => {
  const root = fixture(t);
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  t.mock.method(console, 'log', () => {});
  const previous = process.exitCode;

  try {
    show(
      'latest',
      {},
      {
        root,
        read: () => {
          throw Object.assign(new Error('EPERM: locked'), { code: 'EPERM' });
        },
      },
    );
  } finally {
    process.exitCode = previous;
  }

  assert.deepEqual(errors, ['Could not read the log: EPERM: locked']);
});

test('error and aborted turn reasons show Failed and Aborted in ls and show', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsv-reasons-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeReasonSession(
    root,
    'failed',
    { kind: 'error', error: { message: 'provider failure' } },
    { title: 'FAILED_TASK' },
  );
  writeReasonSession(root, 'aborted', { kind: 'aborted' }, { title: 'ABORTED_TASK' });

  const env = { ...process.env, DSH_SESSIONS_ROOT: root };
  const ls = spawnSync(process.execPath, [cli, 'ls'], { encoding: 'utf8', env });
  assert.equal(ls.status, 0, ls.stderr);
  assert.match(ls.stdout, /✗ Failed/);
  assert.match(ls.stdout, /✗ Aborted/);

  for (const [id, label] of [
    ['failed', 'Failed'],
    ['aborted', 'Aborted'],
  ]) {
    const shown = spawnSync(process.execPath, [cli, 'show', id], { encoding: 'utf8', env });
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, new RegExp(`✗ ${label}`));
  }
});

test('dsv ls hides empty sessions like the TUI', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsv-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'project', 'empty', 'session.v4.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });

  fs.writeFileSync(
    file,
    JSON.stringify({
      type: 'session',
      version: 4,
      id: 'empty',
      cwd: '/work/empty',
      createdAt: Date.now(),
    }) + '\n',
  );

  const result = spawnSync(process.execPath, [cli, 'ls'], {
    encoding: 'utf8',
    env: { ...process.env, DSH_SESSIONS_ROOT: root },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /EMPTY|Empty/);
});

test('watch reports a first read failure, keeps polling, and prints an appended event', (t) => {
  const root = fixture(t),
    file = path.join(root, 'project', 'reading', 'session.v4.jsonl');

  const real = createEventReader(file);
  let attempts = 0,
    tick;
  const logs = [],
    errors = [];

  watch('latest', {
    root,
    out: { log: (value) => logs.push(String(value)), error: (value) => errors.push(String(value)) },
    createReader: () => ({
      read() {
        attempts++;
        if (attempts === 1) throw Object.assign(new Error('EPERM: locked'), { code: 'EPERM' });
        return real.read();
      },
    }),
    list: () => [],
    now: () => 0,
    scanMs: 1e9,
    schedule: (callback) => {
      tick = callback;
      return 1;
    },
  });

  assert.deepEqual(errors, ['Could not read the log: EPERM: locked']);
  tick();
  assert.match(logs.join('\n'), /优化会话查看器/);

  fs.appendFileSync(
    file,
    JSON.stringify({
      type: 'assistant/message',
      seq: 9999,
      time: Date.now(),
      data: { turn: 1, step: 99, message: { content: [{ type: 'text', text: 'WATCH_APPEND' }] } },
    }) + '\n',
  );
  tick();
  assert.match(logs.join('\n'), /WATCH_APPEND/);
});

test('watch rescans the session tree on its scan interval, not on every tick', (t) => {
  const root = fixture(t);
  let scans = 0,
    tick,
    clock = 1000;
  const logs = [];

  watch('latest', {
    root,
    out: { log: (value) => logs.push(String(value)), error: () => {} },
    list: () => {
      scans++;
      return listSessionFiles(root);
    },
    now: () => clock,
    scanMs: 5000,
    schedule: (callback) => {
      tick = callback;
      return 1;
    },
  });

  for (const at of [2000, 4000, 6000, 7000]) {
    clock = at;
    tick();
  }

  assert.equal(scans, 1);
  assert.match(logs.join('\n'), /优化会话查看器/);
});

test('runSnapshot paints one frame and loads only the visible list titles', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsv-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const at = new Date(2026, 0, 15, 12).getTime();
  for (let index = 0; index < 40; index++)
    writeSimpleSession(root, `s${index}`, { mtime: at - index * 1000 });

  let store;
  const loads = [],
    chunks = [];

  const code = await runSnapshot({
    root,
    columns: 100,
    rows: 20,
    now: at,
    version: 'test',
    out: { write: (value) => chunks.push(String(value)) },
    createStore: (options) => {
      store = createSessionStore(options);
      const load = store.load.bind(store);
      store.load = async (meta) => {
        loads.push(meta.id);
        return load(meta);
      };
      return store;
    },
  });

  assert.equal(code, 0);
  const frame = chunks.join('');
  assert.equal(frame.split('\n').slice(0, -1).length, 20);
  assert.match(frame, /ANSWER_s0/);
  assert.ok(loads.length < store.files.length, `loaded ${loads.length} of ${store.files.length}`);
});

test('o toggles the owner filter from the selected session and does nothing without an owner', () => {
  const record = {
    id: 'owner-1',
    label: 'pwsh 1',
    pid: process.pid,
    startedAt: 1,
    source: 'process',
  };
  const owned = { id: 's1', owner: record };
  const plain = { id: 's2', owner: null };
  const before = JSON.stringify(owned);

  assert.equal(toggleOwnerFilter(null, owned), 'owner-1');
  assert.equal(toggleOwnerFilter('owner-1', owned), null);
  assert.equal(JSON.stringify(owned), before, 'toggling the filter leaves the selection alone');
  assert.equal(toggleOwnerFilter(null, plain), null);
  assert.equal(
    toggleOwnerFilter('owner-1', plain),
    'owner-1',
    'pressing o on an unowned session leaves an active filter alone',
  );
  assert.equal(toggleOwnerFilter('owner-1', { id: 's3' }), 'owner-1');
  assert.equal(toggleOwnerFilter(null, null), null);
  assert.doesNotThrow(() => toggleOwnerFilter(null, undefined));
});

test('session records carry the bridge owner so the viewer can badge a row', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsv-owner-'));
  const bridgeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsv-owner-bridge-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bridgeDir, { recursive: true, force: true });
  });

  const at = new Date(2026, 0, 15, 12).getTime();
  const id = '11111111-1111-4111-8111-111111111111';
  writeSimpleSession(root, id, { title: 'OWNED_TASK', mtime: at });

  const record = {
    id: 'a1b2c3d4e5f60718',
    label: 'pwsh 4321',
    pid: process.pid,
    startedAt: at,
    source: 'process',
  };
  fs.mkdirSync(path.join(bridgeDir, 'jobs', id), { recursive: true });
  fs.writeFileSync(
    path.join(bridgeDir, 'jobs', id, 'job.json'),
    JSON.stringify({ version: 2, id, owner: record }),
  );

  const store = createSessionStore({ root, bridgeDir, now: () => at });
  try {
    await store.init();
    const found = store.sessions(at).find((session) => session.id === id);
    assert.deepEqual(found.owner, record);
  } finally {
    store.dispose();
  }
});

test('dsv --snapshot prints exactly one frame from a selected session', (t) => {
  const root = fixture(t);
  const result = spawnSync(process.execPath, [cli, '--snapshot', '100x20', '--select', 'reading'], {
    encoding: 'utf8',
    env: { ...process.env, DSH_SESSIONS_ROOT: root },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split('\n').slice(0, -1).length, 20);
  assert.match(result.stdout, /已完成阅读界面调整/);
});
