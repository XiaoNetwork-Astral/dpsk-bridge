import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { COMMANDS, parse, parseCommand, rootHelp, commandHelp } from '../lib/cli.mjs';

const dsbBin = fileURLToPath(new URL('../bin/dsb.mjs', import.meta.url));
const dshVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).dshVersion;
const ID = '11111111-1111-1111-1111-111111111111';
const removedExperimentalOption = '--notify-cmd';

function messageOf(fn) {
  try { fn(); } catch (error) { return error.message; }
  assert.fail('expected the call to throw');
}

// The parser always initializes the four repeatable arrays, even for commands
// that do not accept them.
const emptyLists = () => ({ patch: [], scope: [], resource: [], image: [] });

const CASES = [
  {
    name: 'run',
    id: null,
    args: [
      '-C', 'project', '-b', 'brief.md',
      '-p', 'a.yml', '--patch=b.yml',
      '-i', 'one.png', '--image=two.png',
      '--time-limit', '600', '--dsh-entry', '/opt/dsh/lib/bin.js',
      '--provider', 'deepseek-official', '--model', 'deepseek-flash',
      '--concurrency', '4', '-s', 'src', '--scope=lib',
      '--read-only', '--resource', 'editor', '--resource', 'browser',
    ],
    expected: {
      cwd: 'project', brief: 'brief.md',
      patch: ['a.yml', 'b.yml'], image: ['one.png', 'two.png'],
      timeout: '600', dshEntry: '/opt/dsh/lib/bin.js',
      provider: 'deepseek-official', model: 'deepseek-flash',
      maxConcurrent: '4', scope: ['src', 'lib'], readOnly: true,
      resource: ['editor', 'browser'],
    },
  },
  {
    name: 'wait', id: ID, args: [ID, '-t', '600'],
    expected: { timeout: '600' },
  },
  { name: 'status', id: ID, args: [ID], expected: {} },
  { name: 'result', id: ID, args: [ID], expected: {} },
  {
    name: 'events', id: ID, args: [ID, '--cursor', '128', '--limit=20'],
    expected: { cursor: '128', limit: '20' },
  },
  {
    name: 'send', id: ID, args: [ID, '-m', 'message.md'],
    expected: { message: 'message.md' },
  },
  {
    name: 'answer', id: ID, args: [ID, '-r', 'req-1', '-a', 'answer.json'],
    expected: { request: 'req-1', answer: 'answer.json' },
  },
  {
    name: 'retry', id: ID, args: [ID, '-f', 'feedback.md', '--resume', '-u'],
    expected: { feedback: 'feedback.md', resume: true, userOk: true },
  },
  {
    name: 'review', id: ID, args: [ID, '--verdict', 'accepted', '--note', 'tests pass', '--accounting=accounting.json'],
    expected: { verdict: 'accepted', note: 'tests pass', accounting: 'accounting.json' },
  },
  { name: 'cancel', id: ID, args: [ID], expected: {} },
  {
    name: 'unlock', id: ID, args: [ID, '--confirm-stopped'],
    expected: { confirmStopped: true },
  },
  { name: 'stats', id: null, args: [], expected: {} },
];

test('every command parses legal arguments into the documented internal keys', () => {
  for (const item of CASES) {
    const parsed = parseCommand(item.name, item.args);
    assert.equal(parsed.action, 'command', item.name);
    assert.deepEqual(parsed.options, { ...emptyLists(), ...item.expected }, item.name);
    assert.deepEqual(parsed.positionals, item.id === null ? {} : { id: item.id }, item.name);
  }
});

test('every documented short alias maps to its long option', () => {
  const cases = [
    { command: 'run', prefix: ['-b', 'brief.md'], alias: '-C', value: 'project', key: 'cwd', expected: 'project' },
    { command: 'run', prefix: [], alias: '-b', value: 'brief.md', key: 'brief', expected: 'brief.md' },
    { command: 'run', prefix: ['-b', 'brief.md'], alias: '-p', value: 'a.yml', key: 'patch', expected: ['a.yml'] },
    { command: 'run', prefix: ['-b', 'brief.md'], alias: '-i', value: 'a.png', key: 'image', expected: ['a.png'] },
    { command: 'run', prefix: ['-b', 'brief.md'], alias: '-s', value: 'src', key: 'scope', expected: ['src'] },
    { command: 'wait', prefix: [ID], alias: '-t', value: '60', key: 'timeout', expected: '60' },
    { command: 'send', prefix: [ID], alias: '-m', value: 'message.md', key: 'message', expected: 'message.md' },
    { command: 'answer', prefix: [ID, '-a', 'answer.json'], alias: '-r', value: 'req-1', key: 'request', expected: 'req-1' },
    { command: 'answer', prefix: [ID, '-r', 'req-1'], alias: '-a', value: 'answer.json', key: 'answer', expected: 'answer.json' },
    { command: 'answer', prefix: [ID, '-r', 'req-1', '-a', 'answer.json'], alias: '-u', key: 'userOk', expected: true },
    { command: 'retry', prefix: [ID], alias: '-f', value: 'feedback.md', key: 'feedback', expected: 'feedback.md' },
    { command: 'retry', prefix: [ID, '-f', 'feedback.md'], alias: '-u', key: 'userOk', expected: true },
  ];
  for (const item of cases) {
    const args = [...item.prefix];
    if (item.value === undefined) args.push(item.alias);
    else args.push(item.alias, item.value);
    const parsed = parseCommand(item.command, args);
    assert.deepEqual(parsed.options[item.key], item.expected, `${item.command} ${item.alias}`);
  }
});

test('each short alias letter has exactly one meaning across all commands', () => {
  const meanings = new Map();
  for (const command of COMMANDS) for (const option of command.options) {
    if (!option.short) continue;
    const known = meanings.get(option.short);
    if (known) assert.equal(known, option.long, `${option.short} means both ${known} and ${option.long}`);
    else meanings.set(option.short, option.long);
  }
  assert.deepEqual(Object.fromEntries([...meanings].sort()), {
    '-C': '--cwd',
    '-a': '--answer',
    '-b': '--brief',
    '-f': '--feedback',
    '-i': '--image',
    '-m': '--message',
    '-p': '--patch',
    '-r': '--request',
    '-s': '--scope',
    '-t': '--timeout',
    '-u': '--user-ok',
  });
});

test('every value option also accepts --name=value', () => {
  const run = parseCommand('run', ['--brief=brief.md', '--cwd=project', '--time-limit=600', '--concurrency=4',
    '--context-limit=1000', '--provider=route', '--model=name', '--dsh-entry=/opt/dsh/lib/bin.js', '--resource=editor']);
  assert.equal(run.options.brief, 'brief.md');
  assert.equal(run.options.cwd, 'project');
  assert.equal(run.options.timeout, '600');
  assert.equal(run.options.maxConcurrent, '4');
  assert.equal(run.options.contextLimit, '1000');
  assert.equal(run.options.provider, 'route');
  assert.equal(run.options.model, 'name');
  assert.equal(run.options.dshEntry, '/opt/dsh/lib/bin.js');
  assert.deepEqual(run.options.resource, ['editor']);
  assert.equal(parseCommand('wait', [ID, '--timeout=60']).options.timeout, '60');
  assert.equal(parseCommand('events', [ID, '--cursor=128', '--limit=20']).options.cursor, '128');
  assert.equal(parseCommand('send', [ID, '--message=message.md']).options.message, 'message.md');
  const answer = parseCommand('answer', [ID, '--request=req-1', '--answer=answer.json']);
  assert.equal(answer.options.request, 'req-1');
  assert.equal(answer.options.answer, 'answer.json');
  assert.equal(parseCommand('retry', [ID, '--feedback=feedback.md']).options.feedback, 'feedback.md');
  assert.equal(parseCommand('unlock', [ID, '--confirm-stopped']).options.confirmStopped, true);
  assert.deepEqual(parseCommand('run', ['--brief=brief.md', '--patch=a.yml', '--patch=b.yml']).options.patch, ['a.yml', 'b.yml']);
  // Only the first '=' separates the name from the value.
  assert.equal(parseCommand('review', [ID, '--verdict=accepted', '--note=a=b']).options.note, 'a=b');
  assert.throws(() => parseCommand('run', ['--brief=']), /Missing value for --brief/);
});

test('renamed and removed options name their replacement', () => {
  const run = ['--brief', 'brief.md'];
  assert.throws(() => parseCommand('run', [...run, '--timeout', '5']),
    /Unknown option: --timeout\. 'dsb run' now uses --time-limit <SECONDS>/);
  assert.throws(() => parseCommand('run', [...run, '--max-concurrent', '2']),
    /Unknown option: --max-concurrent\. 'dsb run' now uses --concurrency <N>/);
  assert.equal(messageOf(() => parseCommand('run', [...run, removedExperimentalOption, 'echo'])),
    `Unknown option: ${removedExperimentalOption}. This experimental option was removed. Run 'dsb run --help' for usage`);
  assert.equal(messageOf(() => parseCommand('retry', [ID, '--feedback', 'f.md', removedExperimentalOption, 'echo'])),
    `Unknown option: ${removedExperimentalOption}. This experimental option was removed. Run 'dsb retry --help' for usage`);
  assert.throws(() => parseCommand('send', [ID, '--message-file', 'a']),
    /Unknown option: --message-file\. 'dsb send' now uses --message <FILE>/);
  assert.throws(() => parseCommand('events', [ID, '--after', '0']),
    /Unknown option: --after\. 'dsb events' now uses --cursor <BYTES>/);
  assert.throws(() => parseCommand('unlock', [ID, '--confirmed-stopped']),
    /Unknown option: --confirmed-stopped\. 'dsb unlock' now uses --confirm-stopped/);
  // A hint only applies in the command that used to accept the option.
  assert.throws(() => parseCommand('send', [ID, '--timeout', '5']), /Unknown option: --timeout\. Run/);
  // Names that kept their meaning keep working.
  assert.equal(parseCommand('wait', [ID, '--timeout', '5']).options.timeout, '5');
});

test('repeatable options accumulate in order', () => {
  const parsed = parseCommand('run', ['-b', 'brief.md', '-p', 'a', '--patch=b', '-s', 's1', '--scope=s2',
    '--resource', 'r1', '--resource=r2', '-i', 'i1', '--image=i2']);
  assert.deepEqual(parsed.options.patch, ['a', 'b']);
  assert.deepEqual(parsed.options.scope, ['s1', 's2']);
  assert.deepEqual(parsed.options.resource, ['r1', 'r2']);
  assert.deepEqual(parsed.options.image, ['i1', 'i2']);
});

test('unknown options, missing values, duplicates, and extra arguments are rejected', () => {
  assert.throws(() => parseCommand('run', ['--brief', 'brief.md', '--bogus']), /Unknown option: --bogus.*dsb run --help/);
  assert.throws(() => parseCommand('run', ['--brief']), /Missing value for --brief.*dsb run --help/);
  assert.throws(() => parseCommand('run', ['-b']), /Missing value for --brief.*dsb run --help/);
  assert.throws(() => parseCommand('run', ['--brief', '--cwd', 'project']), /Missing value for --brief/);
  assert.throws(() => parseCommand('run', ['--brief', 'one.md', '--brief', 'two.md']), /Duplicate option: --brief/);
  assert.throws(() => parseCommand('run', ['-b', 'one.md', '--brief', 'two.md']), /Duplicate option: --brief/);
  assert.throws(() => parseCommand('run', ['--brief', 'brief.md', '--cwd', 'one', '--cwd=two']), /Duplicate option: --cwd/);
  assert.throws(() => parseCommand('run', ['--brief', 'brief.md', '--read-only=true']), /--read-only does not take a value/);
  assert.throws(() => parseCommand('run', ['--brief', 'brief.md', 'extra']), /Unexpected argument: extra/);
  assert.throws(() => parseCommand('stats', ['extra']), /Unexpected argument: extra/);
});

test('required options are reported with a command help hint', () => {
  assert.throws(() => parseCommand('run', []), /Missing required option: --brief.*dsb run --help/);
  assert.throws(() => parseCommand('send', ['id']), /Missing required option: --message/);
  assert.throws(() => parseCommand('answer', ['id', '--request', 'req']), /Missing required option: --answer/);
  assert.throws(() => parseCommand('answer', ['id', '--answer', 'answer.json']), /Missing required option: --request/);
  assert.throws(() => parseCommand('review', ['id', '--verdict', 'accepted']), /Missing required option: --note/);
  assert.throws(() => parseCommand('unlock', ['id']), /Missing required option: --confirm-stopped/);
});

test('ID-taking commands reject a missing ID at parse time', () => {
  const cases = {
    wait: [], status: [], result: [], events: [], cancel: [],
    send: ['--message', 'message.md'],
    answer: ['--request', 'req', '--answer', 'answer.json'],
    retry: ['--feedback', 'feedback.md'],
    review: ['--verdict', 'accepted', '--note', 'evidence'],
    unlock: ['--confirm-stopped'],
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
      const label = option.short ? `${option.short}, ${option.long}` : option.long;
      assert.ok(help.includes(label), `${item.name}: ${label}`);
      if (option.value) assert.ok(help.includes(`${option.long} <${option.value}>`), `${item.name}: ${option.long} ${option.value}`);
      if (option.required) assert.ok(flatHelp.includes('[required]'), `${item.name}: ${option.long} required`);
      if (option.default !== undefined) assert.ok(flatHelp.includes(`[default: ${option.default}]`), `${item.name}: ${option.long} default`);
    }
    if (item.positionals.length) assert.match(help, /^Arguments:$/m, item.name);
  }
  assert.throws(() => commandHelp('bogus'), /Unknown command: bogus/);
});

test('help uses the documented aliases, value names, and has no notify option', () => {
  const run = commandHelp('run');
  assert.match(run, /-b, --brief <FILE>/);
  assert.match(run, /-C, --cwd <DIR>/);
  assert.match(run, /-p, --patch <FILE>/);
  assert.match(run, /-i, --image <FILE>/);
  assert.match(run, /-s, --scope <PATH>/);
  assert.match(run, /--time-limit <SECONDS>/);
  assert.match(run, /--concurrency <N>/);
  assert.doesNotMatch(run, /notify/i);
  assert.match(commandHelp('wait'), /-t, --timeout <SECONDS>/);
  assert.match(commandHelp('send'), /-m, --message <FILE>/);
  assert.match(commandHelp('answer'), /-r, --request <REQUEST_ID>/);
  assert.match(commandHelp('answer'), /-a, --answer <FILE>/);
  assert.match(commandHelp('answer'), /-u, --user-ok/);
  assert.match(commandHelp('retry'), /-f, --feedback <FILE>/);
  assert.match(commandHelp('retry'), /-u, --user-ok/);
  assert.match(commandHelp('events'), /--cursor <BYTES>/);
  assert.match(commandHelp('unlock'), /--confirm-stopped/);
  assert.doesNotMatch(commandHelp('retry'), /notify/i);
  assert.doesNotMatch(commandHelp('events'), /--after/);
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
  assert.match(run, /--time-limit <SECONDS> Job time limit/);
  assert.match(flat(commandHelp('answer')), /--request <REQUEST_ID>.*--answer <FILE>/);
});

test('guard-rail flags parse and appear in help', () => {
  assert.equal(parseCommand('answer', [ID, '--request', 'req', '--answer', 'answer.json', '--user-ok']).options.userOk, true);
  const retry = parseCommand('retry', [ID, '--feedback', 'feedback.md', '--resume', '--user-ok']);
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
  const first = lines.findIndex(line => line.includes('--concurrency'));
  assert.ok(first >= 0);
  const descriptionColumn = lines[first].indexOf('Maximum concurrent');
  assert.ok(descriptionColumn > 0);
  assert.match(lines[first], /--concurrency <N>\s+\S/);
  assert.ok(lines[first + 1].startsWith(' '.repeat(descriptionColumn)));
  assert.notEqual(lines[first + 1][descriptionColumn], ' ');
});

function cliRuntime(report) {
  return `
import readline from 'node:readline';
const write = (m, done) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n', done);
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
  else if (m.method === 'shutdown') { write({ id: m.id, result: {} }, () => process.exit(0)); }
});`;
}

async function runCli(t, report) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-dsb-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'runtime', 'lib'), { recursive: true });
  const entry = path.join(root, 'runtime', 'lib', 'bin.mjs');
  fs.writeFileSync(entry, cliRuntime(report));
  fs.writeFileSync(path.join(root, 'runtime', 'package.json'), JSON.stringify({ version: dshVersion }));
  const brief = path.join(root, 'brief.md'); fs.writeFileSync(brief, 'cli exit code');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [dsbBin, 'run', '--brief', brief, '--dsh-entry', entry, '--cwd', root, '--time-limit', '20'], {
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
