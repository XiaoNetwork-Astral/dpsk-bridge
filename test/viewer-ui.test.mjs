import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../bin/dsv.mjs', import.meta.url));
const plain = text => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
// Injected into the TUI child process: a tiny virtual terminal that applies the
// row-addressed writes of the screen differ, so tests read what the user sees.
const VT = String.raw`const screen=[];const apply=s=>{s=String(s);if(s.includes('\x1b[2J'))screen.length=0;
const p=s.split(/\x1b\[(\d+);1H/);for(let i=1;i<p.length;i+=2)screen[p[i]-1]=p[i+1].replace(/\x1b\[0J[\s\S]*$/,'');
const m=/\x1b\[(\d+);1H\x1b\[0J/.exec(s);if(m)screen.length=m[1]-1;return p.length>1;};
const view=()=>Array.from(screen,l=>l??'').join('\r\n');`;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsv-reading-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let seq = 0;
  const event = (type, data) => ({ type, seq: ++seq, time: 1700000000000 + seq, data });
  const events = [{ type: 'session', version: 4, id: 'reading', cwd: '/work/bridge', createdAt: 1700000000000 },
    event('session/title', { title: '优化会话查看器' }), event('turn/start', { turn: 1 }),
    event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '减少阅读负担，保留完整过程。\n\n【桥接报告约定】INTERNAL_BRIDGE_CONTRACT' }] })];
  for (let i = 0; i < 80; i++) {
    events.push(event('tool/call', { turn: 1, step: i, callId: `call-${i}`, name: 'read_file', arguments: JSON.stringify({ path: `/work/bridge/src/file-${i}.mjs` }) }),
      event('tool/result', { turn: 1, step: i, message: { role: 'tool', toolCallId: `call-${i}`, content: [{ type: 'text', text: `SUCCESS_TOOL_DUMP_${i}\n` + 'long output '.repeat(100) }] } }));
  }
  events.push(event('assistant/message', { turn: 1, step: 81, message: { content: [{ type: 'reasoning', text: 'HIDDEN_REASONING' },
    { type: 'text', text: 'RESULT: OK\n已完成阅读界面调整。\n\n- 结果优先显示\n- 完整过程按需展开\n- 任务之间不再自动跳转' }] } }), event('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  const dir = path.join(root, 'project', 'reading'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl'), events.map(JSON.stringify).join('\n') + '\n');
  return root;
}

test('default CLI shows the answer before a single process summary and hides technical clutter', t => {
  const root = fixture(t);
  const run = flags => spawnSync(process.execPath, [cli, 'show', 'reading', ...flags], { encoding: 'utf8', env: { ...process.env, DSH_SESSIONS_ROOT: root } });
  const compact = run([]); assert.equal(compact.status, 0, compact.stderr);
  assert.match(compact.stdout, /已完成阅读界面调整/); assert.match(compact.stdout, /80 tool calls/);
  for (const hidden of ['HIDDEN_REASONING', 'SUCCESS_TOOL_DUMP', 'INTERNAL_BRIDGE_CONTRACT', 'cacheReadTokens', 'format v4']) assert.ok(!compact.stdout.includes(hidden), hidden);
  assert.ok(compact.stdout.indexOf('已完成阅读界面调整') < compact.stdout.indexOf('减少阅读负担'));
  assert.ok(compact.stdout.split('\n').length < 25);
  const processView = run(['--details']); assert.equal(processView.status, 0, processView.stderr); assert.match(processView.stdout, /src\/file-0.mjs/);
  const full = run(['--full', '--reasoning']); assert.equal(full.status, 0, full.stderr); assert.match(full.stdout, /SUCCESS_TOOL_DUMP/); assert.match(full.stdout, /HIDDEN_REASONING/);
});

test('long answers and full tool output remain complete and terminal controls are removed', t => {
  const root = fixture(t), file = path.join(root, 'project', 'reading', 'session.v4.jsonl');
  const events = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  const control = '\x1b]0;HOSTILE_TITLE\x07\x1b[2J';
  events[0].cwd = '/work/' + control + 'bridge';
  events[1].data.title = control + '任务';
  const long = Array.from({ length: 2105 }, (_, i) => `line-${i}`).join('\n');
  events.find(e => e.type === 'assistant/message').data.message.content = [{ type: 'text', text: control + long }];
  events.find(e => e.type === 'tool/result').data.message.content = [{ type: 'text', text: control + long }];
  events.find(e => e.type === 'tool/call').data.arguments = JSON.stringify({ command: control + 'safe-command' });
  fs.writeFileSync(file, events.map(JSON.stringify).join('\n') + '\n');
  for (const flags of [[], ['--full'], ['--all']]) {
    const result = spawnSync(process.execPath, [cli, 'show', 'reading', ...flags], { encoding: 'utf8', env: { ...process.env, DSH_SESSIONS_ROOT: root }, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /line-2104/);
    assert.ok(!result.stdout.includes('\x1b[2J')); assert.ok(!result.stdout.includes('\x1b]0;'));
    if (flags.includes('--full')) assert.equal(result.stdout.match(/line-2104/g).length, 2);
  }
});

test('actual TUI frame stays readable at wide and narrow sizes and exposes process/help via keys', t => {
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
    const output = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, DSH_SESSIONS_ROOT: root }, timeout: 15000 });
    assert.equal(output.status, 0, output.stderr);
    // Snapshots: start (list focused), Enter (reading view), d (process view), ? (help), ? (help closed).
    const [start, reading, processView, help, closed] = JSON.parse(output.stdout).map(plain);
    assert.match(start, /优化会话查看器/);
    if (columns >= 100) assert.match(start, /已完成阅读界面调整/);
    assert.match(reading, /Result/); assert.match(reading, /已完成阅读界面调整/);
    assert.ok(!reading.includes('SUCCESS_TOOL_DUMP')); assert.ok(!reading.includes('HIDDEN_REASONING'));
    assert.match(processView, /src\/file-0.mjs/); assert.match(help, /Anywhere +Tab/); assert.ok(!closed.includes('Shift+Tab'));
    for (const frame of [start, reading, processView, help, closed]) assert.ok(frame.split('\r\n').length <= 30);
  }
});

test('new sessions do not steal the current reading position and explicit navigation still switches', t => {
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
  const output = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, DSH_SESSIONS_ROOT: root }, timeout: 15000 });
  assert.equal(output.status, 0, output.stderr);
  const frames = JSON.parse(output.stdout).map(plain);
  assert.match(frames[1], /新到达的会话/); assert.match(frames[1], /已完成阅读界面调整/); assert.ok(!frames[1].includes('NEW_SESSION_RESULT'));
  assert.match(frames.at(-1), /NEW_SESSION_RESULT/);
});

test('groups fold with keyboard and mouse, retain reading state, and stay folded on refresh', t => {
  const root = fixture(t), now = new Date(2026, 0, 15, 12).getTime();
  const reading = path.join(root, 'project', 'reading', 'session.v4.jsonl');
  fs.utimesSync(reading, new Date(now), new Date(now));
  for (const [id, days] of [['today-other', 0], ['yesterday', 1], ['week', 3], ['older', 12]]) {
    const dir = path.join(root, 'project', id); fs.mkdirSync(dir, { recursive: true });
    const events = [{ type: 'session', version: 4, id, cwd: '/work/' + id, createdAt: now },
      { type: 'session/title', seq: 1, data: { title: 'TASK_' + id } },
      { type: 'turn/start', seq: 2, data: { turn: 1 } },
      { type: 'assistant/message', seq: 3, data: { turn: 1, message: { content: [{ type: 'text', text: 'ANSWER_' + id }] } } },
      { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } }];
    const file = path.join(dir, 'session.v4.jsonl'); fs.writeFileSync(file, events.map(JSON.stringify).join('\n') + '\n');
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
    const output = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, DSH_SESSIONS_ROOT: root }, timeout: 15000 });
    assert.equal(output.status, 0, output.stderr);
    const frames = Object.fromEntries(Object.entries(JSON.parse(output.stdout)).map(([key, value]) => [key, plain(value)]));
    const sidebar = frame => frame.split('\r\n').slice(1, -1).map(line => columns >= 100 ? line.split('│')[1] ?? '' : line).join('\n');
    const initial = sidebar(frames.initial);
    // Both sessions ended within the last minutes, so they are still under 运行中 › 刚结束.
    assert.match(initial, /▾ Running/); assert.match(initial, /▾ Just ended/);
    assert.match(initial, /▾ Finished/); assert.match(initial, /▾ 2026-1-14 /);
    assert.match(initial, /▸ 2026-1-12 /); assert.match(initial, /▸ 2026-1-3 /);
    assert.match(initial, /TASK_yesterday/, 'the newest day is open'); assert.ok(!initial.includes('TASK_week'));
    assert.match(sidebar(frames.folded), /▸ Running/); assert.ok(!sidebar(frames.folded).includes('优化会话查看器'));
    assert.match(sidebar(frames.refreshed), /▸ Running/);
    if (columns >= 100) assert.match(frames.folded, /已完成阅读界面调整/);
    if (columns >= 100) assert.match(frames.readingYesterday, /ANSWER_yesterday/);
    else assert.match(sidebar(frames.readingYesterday), /▌ +✓ TASK_yesterday/);
    assert.match(sidebar(frames.leftFold), /▸ 2026-1-14 /); assert.ok(!sidebar(frames.leftFold).includes('TASK_yesterday'));
    assert.match(sidebar(frames.rightOpen), /TASK_yesterday/);
    assert.match(sidebar(frames.weekOpen), /▾ 2026-1-12 /); assert.match(sidebar(frames.weekOpen), /TASK_week/);
    assert.match(sidebar(frames.mouseOpen), /▾ Running/); assert.match(sidebar(frames.mouseFold), /▸ Running/);
    for (const frame of Object.values(frames)) assert.ok(frame.split('\r\n').length <= 20);
  }
});

test('mouse wheel scrolls the transcript without moving the highlighted block', t => {
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
  const output = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, DSH_SESSIONS_ROOT: root }, timeout: 15000 });
  assert.equal(output.status, 0, output.stderr);
  const frames = Object.fromEntries(Object.entries(JSON.parse(output.stdout)).map(([key, value]) => [key, plain(value)]));
  // Detail rows carry the highlight bar right after the detail box's left border.
  const highlighted = frame => frame.split('\r\n').slice(2, -2).map((line, index) => [index, line]).filter(([, line]) => line.indexOf('│▌', 1) > 0);
  const before = highlighted(frames.cursor);
  assert.ok(before.length > 0 && before[0][0] > 0, 'the cursor starts below the first transcript row');
  assert.notEqual(frames.wheeled, frames.cursor, 'the wheel scrolled the transcript');
  // Old behavior moved the highlight to the first visible block; now it stays on its block, now off screen.
  assert.deepEqual(highlighted(frames.wheeled), [], 'the highlighted block scrolled away instead of jumping');
  const resumed = highlighted(frames.resumed);
  assert.ok(resumed.length > 0 && resumed[0][0] === 0, 'the next key press resumes from the top of what is on screen');
});

test('keyboard covers group folding, jumping to running sessions, free scrolling and modal help', t => {
  const root = fixture(t), now = new Date(2026, 0, 15, 12).getTime();
  fs.utimesSync(path.join(root, 'project', 'reading', 'session.v4.jsonl'), new Date(now), new Date(now - 3 * 86400000));
  // Two running sessions (open turn, fresh) and one finished yesterday.
  for (const [id, open, days] of [['run-a', true, 0], ['run-b', true, 0], ['done-y', false, 1]]) {
    const dir = path.join(root, 'project', id); fs.mkdirSync(dir, { recursive: true });
    const events = [{ type: 'session', version: 4, id, cwd: '/work/' + id, createdAt: now },
      { type: 'session/title', seq: 1, data: { title: 'TASK_' + id } }, { type: 'turn/start', seq: 2, data: { turn: 1 } },
      { type: 'assistant/message', seq: 3, data: { turn: 1, message: { content: [{ type: 'text', text: 'ANSWER_' + id }] } } },
      ...(open ? [] : [{ type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } }])];
    const file = path.join(dir, 'session.v4.jsonl'); fs.writeFileSync(file, events.map(JSON.stringify).join('\n') + '\n');
    fs.utimesSync(file, new Date(now), new Date(now - days * 86400000 - (id === 'run-b' ? 1000 : 0)));
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
key('?');frames.help=current;key('\\x1b[<0;10;5M');frames.helpClick=current;key('\\x1b');frames.helpClosed=current;
stdout(JSON.stringify(frames));process.exit(0);`;
  const output = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, DSH_SESSIONS_ROOT: root }, timeout: 15000 });
  assert.equal(output.status, 0, output.stderr);
  const frames = Object.fromEntries(Object.entries(JSON.parse(output.stdout)).map(([key, value]) => [key, plain(value)]));
  const sidebar = frame => frame.split('\r\n').slice(1, -1).map(line => line.split('│')[1] ?? '').join('\n');
  assert.match(sidebar(frames.initial), /▸ 2026-1-12 /, 'older days start folded');
  assert.match(sidebar(frames.folded), /▸ Running/); assert.match(sidebar(frames.folded), /▸ Finished/);
  assert.ok(!sidebar(frames.folded).includes('TASK_'), 'z folds every group');
  for (const label of [/▾ Running/, /▾ Finished/, /▾ 2026-1-14 /, /▾ 2026-1-12 /]) assert.match(sidebar(frames.opened), label);
  // n cycles through the running sessions and shows each transcript.
  const title = frame => frame.split('\r\n')[1];
  const firstRun = /TASK_run-(a|b)/.exec(title(frames.next1))?.[1];
  assert.ok(firstRun, title(frames.next1));
  assert.match(title(frames.next2), new RegExp('TASK_run-' + (firstRun === 'a' ? 'b' : 'a')));
  assert.match(title(frames.next3), new RegExp('TASK_run-' + firstRun));
  // Help is modal: a click on the list underneath changes nothing.
  assert.match(frames.help, /Help  \? to close/);
  assert.equal(frames.helpClick, frames.help);
  assert.doesNotMatch(frames.helpClosed, /Help  \? to close/);
});

test('Ctrl+D scrolls the transcript like the wheel while PgDn moves the highlight along', t => {
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
  const output = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, DSH_SESSIONS_ROOT: root }, timeout: 15000 });
  assert.equal(output.status, 0, output.stderr);
  const frames = Object.fromEntries(Object.entries(JSON.parse(output.stdout)).map(([key, value]) => [key, plain(value)]));
  const highlighted = frame => frame.split('\r\n').slice(2, -2).filter(line => line.indexOf('│▌', 1) > 0);
  assert.ok(highlighted(frames.cursor).length > 0);
  assert.notEqual(frames.ctrlD, frames.cursor, 'Ctrl+D scrolled');
  assert.deepEqual(highlighted(frames.ctrlD), [], 'the highlight stayed on its block, now off screen');
  assert.ok(highlighted(frames.pageDown).length > 0, 'PgDn brings the highlight onto the new page');
});
