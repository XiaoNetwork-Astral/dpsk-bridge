import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { COMMANDS, parse, parseCommand, rootHelp, commandHelp } from '../lib/cli.mjs';

const dsbBin = fileURLToPath(new URL('../bin/dsb.mjs', import.meta.url));

// The parser this command table replaces. Legal invocations must keep the same
// option object, including the four arrays the old parser always initialized.
function oldParse(args, allowed) {
  const out = { patch: [], scope: [], resource: [], image: [] };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!allowed.includes(key)) throw new Error(`Unknown option: ${key}`);
    if (key === '--confirmed-stopped') { out.confirmedStopped = true; continue; }
    if (key === '--read-only') { out.readOnly = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    const name = key.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    if (['patch', 'scope', 'resource', 'image'].includes(name)) out[name].push(value);
    else { if (name in out) throw new Error(`Duplicate option: ${key}`); out[name] = value; }
  }
  return out;
}

const CASES = [
  {
    name: 'run',
    id: null,
    args: [
      '--cwd', 'project', '--brief', 'brief.md',
      '--patch', 'a.yml', '--patch', 'b.yml',
      '--image', 'one.png', '--image', 'two.png',
      '--timeout', '600', '--dsh-entry', '/opt/dsh/lib/bin.js',
      '--provider', 'deepseek-official', '--model', 'deepseek-flash',
      '--max-concurrent', '4', '--scope', 'src', '--scope', 'lib',
      '--read-only', '--resource', 'editor', '--resource', 'browser',
      '--notify-cmd', 'echo done',
    ],
    allowed: ['--cwd', '--brief', '--patch', '--image', '--timeout', '--dsh-entry', '--provider', '--model',
      '--max-concurrent', '--scope', '--read-only', '--resource', '--notify-cmd'],
  },
  { name: 'wait', id: '11111111-1111-1111-1111-111111111111', args: ['11111111-1111-1111-1111-111111111111', '--timeout', '600'], allowed: ['--timeout'] },
  { name: 'status', id: '22222222-2222-2222-2222-222222222222', args: ['22222222-2222-2222-2222-222222222222'], allowed: [] },
  { name: 'result', id: '33333333-3333-3333-3333-333333333333', args: ['33333333-3333-3333-3333-333333333333'], allowed: [] },
  { name: 'events', id: '44444444-4444-4444-4444-444444444444', args: ['44444444-4444-4444-4444-444444444444', '--after', '128', '--limit', '20'], allowed: ['--after', '--limit'] },
  { name: 'send', id: '55555555-5555-5555-5555-555555555555', args: ['55555555-5555-5555-5555-555555555555', '--message-file', 'message.md'], allowed: ['--message-file'] },
  { name: 'answer', id: '66666666-6666-6666-6666-666666666666', args: ['66666666-6666-6666-6666-666666666666', '--request', 'req-1', '--answer', 'answer.json'], allowed: ['--request', '--answer'] },
  { name: 'retry', id: '77777777-7777-7777-7777-777777777777', args: ['77777777-7777-7777-7777-777777777777', '--feedback', 'feedback.md', '--notify-cmd', 'echo retry'], allowed: ['--feedback', '--notify-cmd'] },
  { name: 'review', id: '88888888-8888-8888-8888-888888888888', args: ['88888888-8888-8888-8888-888888888888', '--verdict', 'accepted', '--note', 'tests pass', '--accounting', 'accounting.json'], allowed: ['--verdict', '--note', '--accounting'] },
  { name: 'cancel', id: '99999999-9999-9999-9999-999999999999', args: ['99999999-9999-9999-9999-999999999999'], allowed: [] },
  { name: 'unlock', id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', args: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '--confirmed-stopped'], allowed: ['--confirmed-stopped'] },
  { name: 'stats', id: null, args: [], allowed: [] },
];

test('every command parses legal arguments exactly like the previous parser', () => {
  for (const item of CASES) {
    const parsed = parseCommand(item.name, item.args);
    const rest = item.id === null ? item.args : item.args.slice(1);
    assert.equal(parsed.action, 'command', item.name);
    assert.deepEqual(parsed.options, oldParse(rest, item.allowed), item.name);
    assert.deepEqual(parsed.positionals, item.id === null ? {} : { id: item.id }, item.name);
  }
});

test('repeatable options accumulate in order', () => {
  const parsed = parseCommand('run', ['--brief', 'brief.md', '--patch', 'a', '--patch', 'b', '--scope', 's1', '--scope', 's2',
    '--resource', 'r1', '--resource', 'r2', '--image', 'i1', '--image', 'i2']);
  assert.deepEqual(parsed.options.patch, ['a', 'b']);
  assert.deepEqual(parsed.options.scope, ['s1', 's2']);
  assert.deepEqual(parsed.options.resource, ['r1', 'r2']);
  assert.deepEqual(parsed.options.image, ['i1', 'i2']);
});

test('unknown options, missing values, duplicates, and extra arguments are rejected', () => {
  assert.throws(() => parseCommand('run', ['--brief', 'brief.md', '--bogus']), /Unknown option: --bogus.*dsb run --help/);
  assert.throws(() => parseCommand('run', ['--brief']), /Missing value for --brief.*dsb run --help/);
  assert.throws(() => parseCommand('run', ['--brief', '--cwd', 'project']), /Missing value for --brief/);
  assert.throws(() => parseCommand('run', ['--brief', 'one.md', '--brief', 'two.md']), /Duplicate option: --brief/);
  assert.throws(() => parseCommand('run', ['--brief', 'brief.md', '--cwd', 'one', '--cwd', 'two']), /Duplicate option: --cwd/);
  assert.throws(() => parseCommand('run', ['--brief', 'brief.md', 'extra']), /Unexpected argument: extra/);
  assert.throws(() => parseCommand('stats', ['extra']), /Unexpected argument: extra/);
});

test('required options are reported with a command help hint', () => {
  assert.throws(() => parseCommand('run', []), /Missing required option: --brief.*dsb run --help/);
  assert.throws(() => parseCommand('send', ['id']), /Missing required option: --message-file/);
  assert.throws(() => parseCommand('answer', ['id', '--request', 'req']), /Missing required option: --answer/);
  assert.throws(() => parseCommand('answer', ['id', '--answer', 'answer.json']), /Missing required option: --request/);
  assert.throws(() => parseCommand('review', ['id', '--verdict', 'accepted']), /Missing required option: --note/);
  assert.throws(() => parseCommand('unlock', ['id']), /Missing required option: --confirmed-stopped/);
});

test('ID-taking commands reject a missing ID at parse time', () => {
  const cases = {
    wait: [], status: [], result: [], events: [], cancel: [],
    send: ['--message-file', 'message.md'],
    answer: ['--request', 'req', '--answer', 'answer.json'],
    retry: ['--feedback', 'feedback.md'],
    review: ['--verdict', 'accepted', '--note', 'evidence'],
    unlock: ['--confirmed-stopped'],
  };
  for (const [name, args] of Object.entries(cases))
    assert.throws(() => parseCommand(name, args), new RegExp(`Missing required argument: <ID>\\. Run 'dsb ${name} --help' for usage`), name);
});

test('global help, command help, and version dispatch', () => {
  for (const argv of [[], ['-h'], ['--help'], ['help']]) assert.deepEqual(parse(argv), { action: 'help', command: null }, argv.join(' '));
  assert.deepEqual(parse(['help', 'run']), { action: 'help', command: 'run' });
  assert.deepEqual(parse(['run', '--help']), { action: 'help', command: 'run' });
  assert.deepEqual(parse(['run', '-h']), { action: 'help', command: 'run' });
  assert.deepEqual(parse(['review', '--help']), { action: 'help', command: 'review' });
  assert.deepEqual(parse(['-V']), { action: 'version' });
  assert.deepEqual(parse(['--version']), { action: 'version' });
  assert.throws(() => parse(['bogus']), /Unknown command: bogus.*dsb --help/);
  assert.throws(() => parse(['help', 'bogus']), /Unknown command: bogus/);
});

test('top-level and command help contain every command and option', () => {
  const root = rootHelp();
  assert.match(root, /^dsb — delegate tasks to DeepSeek Harness with bidirectional sessions/);
  assert.match(root, /Usage: dsb <COMMAND> \[OPTIONS\]/);
  assert.match(root, /^Commands:$/m);
  assert.match(root, /^Options:$/m);
  assert.match(root, /^Environment:$/m);
  assert.doesNotMatch(root, /^Notes:$/m);
  assert.match(root, /-h, --help/);
  assert.match(root, /-V, --version/);
  for (const item of COMMANDS) {
    assert.match(root, new RegExp(`^  ${item.name}\\s+`, 'm'), item.name);
    assert.ok(root.includes(item.summary), item.name);
    const help = commandHelp(item.name);
    const flatHelp = help.replace(/\s+/g, ' ');
    assert.ok(help.startsWith(item.summary), item.name);
    assert.ok(help.includes(`Usage: ${item.usage}`), item.name);
    assert.match(help, /^Options:$/m, item.name);
    assert.match(help, /-h, --help/, item.name);
    for (const option of item.options) {
      assert.ok(help.includes(option.long), `${item.name}: ${option.long}`);
      if (option.value) assert.ok(help.includes(`${option.long} <${option.value}>`), `${item.name}: ${option.long} ${option.value}`);
      if (option.required) assert.ok(flatHelp.includes('[required]'), `${item.name}: ${option.long} required`);
      if (option.default !== undefined) assert.ok(flatHelp.includes(`[default: ${option.default}]`), `${item.name}: ${option.long} default`);
    }
    if (item.positionals.length) assert.match(help, /^Arguments:$/m, item.name);
  }
  assert.throws(() => commandHelp('bogus'), /Unknown command: bogus/);
});

test('help has no Notes section and keeps essentials in option descriptions', () => {
  const flat = text => text.replace(/\s+/g, ' ');
  const all = [rootHelp(), ...COMMANDS.map(command => commandHelp(command.name))].join('\n');
  assert.doesNotMatch(all, /^Notes:$/m);
  const root = flat(rootHelp());
  assert.match(root, /DPSK_PROVIDER Default model route \(default: deepseek-official\)/);
  assert.match(root, /DPSK_MODEL Default model name \(default: deepseek-flash\)/);
  assert.match(root, /DPSK_CONCURRENCY .*default: 8/);
  const wait = flat(commandHelp('wait'));
  assert.match(wait, /finishes, needs an answer, or times out/);
  assert.match(wait, /1\.\.3600/); assert.match(wait, /default: 600/);
  const review = flat(commandHelp('review'));
  assert.ok(review.includes('{"currency":"CNY","source":"...","deepseekCost":0.12}'));
  assert.match(review, /every key ending in Cost is recorded, omit unknown costs/);
  assert.match(flat(commandHelp('events')), /Byte cursor from a previous events response/);
  const run = flat(commandHelp('run'));
  assert.match(run, /Cooperative write scope, not a sandbox/);
  assert.match(run, /--dsh-entry <FILE>/); assert.match(run, /Advanced\/debug/);
  assert.match(run, /--notify-cmd <COMMAND> Experimental/);
  assert.match(flat(commandHelp('retry')), /--notify-cmd <COMMAND>/);
  assert.match(flat(commandHelp('answer')), /--request <REQUEST_ID>.*--answer <JSON_FILE>/);
});

test('guard-rail flags parse and appear in help', () => {
  const id = '00000000-0000-4000-8000-000000000060';
  assert.equal(parseCommand('answer', [id, '--request', 'req', '--answer', 'answer.json', '--user-ok']).options.userOk, true);
  const retry = parseCommand('retry', [id, '--feedback', 'feedback.md', '--resume', '--user-ok']);
  assert.equal(retry.options.resume, true);
  assert.equal(retry.options.userOk, true);
  assert.equal(parseCommand('run', ['--brief', 'brief.md', '--context-limit', '5000']).options.contextLimit, '5000');
  const flat = text => text.replace(/\s+/g, ' ');
  assert.match(flat(commandHelp('answer')), /--user-ok.*3-question job cap/);
  assert.match(flat(commandHelp('retry')), /--resume.*timeout or unanswered question/);
  assert.match(flat(commandHelp('retry')), /--user-ok.*one-rework task cap/);
  assert.match(flat(commandHelp('run')), /--context-limit <TOKENS>.*DPSK_CONTEXT_LIMIT/);
  assert.match(flat(rootHelp()), /DPSK_CONTEXT_LIMIT Default context reminder threshold/);
});

test('long descriptions wrap to 100 columns by default and remain aligned', () => {
  const helps = [rootHelp(), ...COMMANDS.map(item => commandHelp(item.name))];
  for (const help of helps) {
    for (const line of help.split('\n')) assert.ok(line.length <= 100, `${line.length}: ${line}`);
  }
  const run = commandHelp('run');
  const cwd = run.split('\n').find(line => line.includes('--cwd <DIR>'));
  const brief = run.split('\n').find(line => line.includes('Task brief (UTF-8)'));
  assert.ok(cwd && brief);
  assert.equal(cwd.indexOf('Project directory'), brief.indexOf('Task brief (UTF-8)'));
});

test('a narrower width wraps option descriptions and keeps the indent', () => {
  const help = commandHelp('run', { columns: 80 });
  for (const line of help.split('\n')) assert.ok(line.length <= 80, `${line.length}: ${line}`);
  const lines = help.split('\n');
  const first = lines.findIndex(line => line.includes('--max-concurrent'));
  assert.ok(first >= 0);
  const descriptionColumn = lines[first].indexOf('Maximum concurrent');
  assert.ok(descriptionColumn > 0);
  assert.match(lines[first], /--max-concurrent <N>\s+\S/);
  assert.ok(lines[first + 1].startsWith(' '.repeat(descriptionColumn)));
  assert.notEqual(lines[first + 1][descriptionColumn], ' ');
});

function cliRuntime(report) {
  return `
import readline from 'node:readline';
const write = m => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
let sessionId, seq = 0;
const event = (type, data) => write({ method: 'session.event', params: { sessionId, event: { type, seq: ++seq, time: Date.now(), data } } });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') write({ id: m.id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime' } } });
  else if (m.method === 'session/prompt') {
    sessionId = m.params.sessionId;
    event('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: ${JSON.stringify(report)} }] } });
    event('turn/end', { turn: 1, reason: { kind: 'completed' } });
    write({ id: m.id, result: { messageId: 'm' } });
  } else if (m.method === 'session/wait') write({ id: m.id, result: {} });
  else if (m.method === 'shutdown') { write({ id: m.id, result: {} }); setTimeout(() => process.exit(0), 10); }
});`;
}

async function runCli(t, report) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-dsb-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'runtime', 'lib'), { recursive: true });
  const entry = path.join(root, 'runtime', 'lib', 'bin.mjs');
  fs.writeFileSync(entry, cliRuntime(report));
  fs.writeFileSync(path.join(root, 'runtime', 'package.json'), JSON.stringify({ version: '0.2.1-rc.3' }));
  const brief = path.join(root, 'brief.md'); fs.writeFileSync(brief, 'cli exit code');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [dsbBin, 'run', '--brief', brief, '--dsh-entry', entry, '--cwd', root, '--timeout', '20'], {
      env: { ...process.env, DSH_HOME: root }, windowsHide: true,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

test('bin/dsb.mjs exits 0 for a completed OK run and 1 for a completed non-OK run', { timeout: 60000 }, async t => {
  const ok = await runCli(t, 'RESULT: OK');
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  const failed = await runCli(t, 'RESULT: FAIL');
  assert.equal(failed.code, 1, failed.stdout + failed.stderr);
});
