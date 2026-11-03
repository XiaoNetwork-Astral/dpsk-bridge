// Declarative command table for dsb. This module only parses argument arrays and
// renders help strings; it never reads process.argv or writes to stdout.

export const COMMANDS = [
  {
    name: 'run',
    summary: 'Start a job and stay attached until it ends',
    usage: 'dsb run --brief <FILE> [OPTIONS]',
    positionals: [],
    options: [
      { long: '--cwd', value: 'DIR', description: 'Project directory', default: 'current directory' },
      { long: '--brief', value: 'FILE', description: 'Task brief (UTF-8)', required: true },
      { long: '--patch', value: 'FILE', description: 'Load an MCP patch; repeatable', repeatable: true },
      { long: '--image', value: 'FILE', description: 'Attach an image; repeatable (max 20, 8 MiB total)', repeatable: true },
      { long: '--timeout', value: 'SECONDS', description: 'Job time limit (max 86400)', default: '2700' },
      { long: '--context-limit', value: 'TOKENS', description: 'Context reminder threshold (DPSK_CONTEXT_LIMIT when unset)', default: '200000' },
      { long: '--provider', value: 'ROUTE', description: 'Model route (DPSK_PROVIDER when unset)', default: 'deepseek-official' },
      { long: '--model', value: 'NAME', description: 'Model name (DPSK_MODEL when unset)', default: 'deepseek-flash' },
      { long: '--max-concurrent', value: 'N', description: 'Maximum concurrent jobs (DPSK_CONCURRENCY is used when unset; range 1..256)', default: '8' },
      { long: '--scope', value: 'PATH', description: 'Cooperative write scope, not a sandbox; repeatable (default: whole workspace)', repeatable: true },
      { long: '--read-only', description: 'Declare a read-only task; read-only tasks run in parallel' },
      { long: '--resource', value: 'NAME', description: 'Shared resource lock; repeatable', repeatable: true },
      { long: '--notify-cmd', value: 'COMMAND', description: 'Experimental: run a local command after the job ends or a new request appears' },
      { long: '--dsh-entry', value: 'FILE', description: 'Advanced/debug: override local dsh lib/bin.js discovery' },
    ],
  },
  {
    name: 'wait',
    summary: 'Block until a job finishes, needs an answer, or times out',
    usage: 'dsb wait <ID> [OPTIONS]',
    positionals: [{ name: 'id', description: 'Job ID returned by dsb run', required: true }],
    options: [
      { long: '--timeout', value: 'SECONDS', description: 'Wait timeout (1..3600)', default: '600' },
    ],
  },
  {
    name: 'status',
    summary: "Show a job's process, acceptance, and pending requests",
    usage: 'dsb status <ID>',
    positionals: [{ name: 'id', description: 'Job ID returned by dsb run', required: true }],
    options: [],
  },
  {
    name: 'result',
    summary: "Read a job's short report and usage",
    usage: 'dsb result <ID>',
    positionals: [{ name: 'id', description: 'Job ID returned by dsb run', required: true }],
    options: [],
  },
  {
    name: 'events',
    summary: 'Read job events after a byte cursor',
    usage: 'dsb events <ID> [OPTIONS]',
    positionals: [{ name: 'id', description: 'Job ID returned by dsb run', required: true }],
    options: [
      { long: '--after', value: 'BYTE_CURSOR', description: 'Byte cursor from a previous events response', default: '0' },
      { long: '--limit', value: 'N', description: 'Maximum events to return (1..200)', default: '20' },
    ],
  },
  {
    name: 'send',
    summary: 'Queue a follow-up message for a running job',
    usage: 'dsb send <ID> --message-file <FILE>',
    positionals: [{ name: 'id', description: 'Job ID returned by dsb run', required: true }],
    options: [
      { long: '--message-file', value: 'FILE', description: 'UTF-8 message file', required: true },
    ],
  },
  {
    name: 'answer',
    summary: 'Answer a pending request',
    usage: 'dsb answer <ID> --request <REQUEST_ID> --answer <JSON_FILE>',
    positionals: [{ name: 'id', description: 'Job ID returned by dsb run', required: true }],
    options: [
      { long: '--request', value: 'REQUEST_ID', description: 'Pending request ID from status/events', required: true },
      { long: '--answer', value: 'JSON_FILE', description: 'UTF-8 JSON answer file', required: true },
      { long: '--user-ok', description: 'Answer past the 3-question job cap after the user agrees' },
    ],
  },
  {
    name: 'retry',
    summary: 'Start a linked rework job and stay attached',
    usage: 'dsb retry <ID> --feedback <FILE> [OPTIONS]',
    positionals: [{ name: 'id', description: 'Job ID returned by dsb run', required: true }],
    options: [
      { long: '--feedback', value: 'FILE', description: 'UTF-8 rework feedback file', required: true },
      { long: '--resume', description: 'Retry only work interrupted by a timeout or unanswered question; not counted as a rework' },
      { long: '--user-ok', description: 'Retry past the one-rework task cap after the user agrees' },
      { long: '--notify-cmd', value: 'COMMAND', description: 'Experimental: override the notify command inherited from the original job' },
    ],
  },
  {
    name: 'review',
    summary: 'Record acceptance as accepted, rework, or blocked',
    usage: 'dsb review <ID> --verdict <VERDICT> --note <EVIDENCE> [OPTIONS]',
    positionals: [{ name: 'id', description: 'Job ID returned by dsb run', required: true }],
    options: [
      { long: '--verdict', value: 'VERDICT', description: 'accepted, rework, or blocked', required: true },
      { long: '--note', value: 'EVIDENCE', description: 'Verification evidence', required: true },
      { long: '--accounting', value: 'JSON', description: 'Accounting JSON: {"currency":"CNY","source":"...","deepseekCost":0.12}; every key ending in Cost is recorded, omit unknown costs' },
    ],
  },
  {
    name: 'cancel',
    summary: 'Ask a job to stop',
    usage: 'dsb cancel <ID>',
    positionals: [{ name: 'id', description: 'Job ID returned by dsb run', required: true }],
    options: [],
  },
  {
    name: 'unlock',
    summary: 'Release a retained reservation after processes stopped',
    usage: 'dsb unlock <ID> --confirmed-stopped',
    positionals: [{ name: 'id', description: 'Job ID returned by dsb run', required: true }],
    options: [
      { long: '--confirmed-stopped', description: 'Confirm the old task and its child processes stopped', required: true },
    ],
  },
  {
    name: 'stats',
    summary: 'Summarize local jobs, reviews, usage, and costs',
    usage: 'dsb stats',
    positionals: [],
    options: [],
  },
];

const byName = new Map(COMMANDS.map(command => [command.name, command]));
const optionsByName = new Map(COMMANDS.map(command => [command.name, new Map(command.options.map(option => [option.long, option]))]));

const ROOT_ENVIRONMENT = [
  { left: 'DPSK_PROVIDER', description: 'Default model route (default: deepseek-official)' },
  { left: 'DPSK_MODEL', description: 'Default model name (default: deepseek-flash)' },
  { left: 'DPSK_CONCURRENCY', description: 'Concurrent job limit shared by all launchers (default: 8, range 1..256)' },
  { left: 'DPSK_CONTEXT_LIMIT', description: 'Default context reminder threshold in tokens (default: 200000)' },
  { left: 'DSH_HOME', description: 'dsh home directory; bridge jobs live in $DSH_HOME/bridge (default: ~/.dsh)' },
];

function widthOf(columns) {
  const value = Number(columns);
  if (!Number.isFinite(value)) return 100;
  return Math.max(40, Math.floor(value));
}

function keyOf(long) {
  return long.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

function wrapWords(text, width) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!line) { line = word; continue; }
    if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function renderList(items, columns) {
  const indent = 2;
  const gap = 2;
  const leftWidth = Math.max(...items.map(item => item.left.length));
  const descriptionColumn = indent + leftWidth + gap;
  const descriptionWidth = Math.max(20, columns - descriptionColumn);
  const lines = [];
  for (const item of items) {
    const wrapped = wrapWords(item.description, descriptionWidth);
    lines.push(`${' '.repeat(indent)}${item.left}${' '.repeat(leftWidth - item.left.length + gap)}${wrapped[0]}`);
    for (const continuation of wrapped.slice(1)) lines.push(`${' '.repeat(descriptionColumn)}${continuation}`);
  }
  return lines;
}

function optionLeft(option, short = null) {
  const prefix = short ? `${short}, ` : '    ';
  return `${prefix}${option.long}${option.value ? ` <${option.value}>` : ''}`;
}

function optionDescription(option) {
  const parts = [option.description];
  if (option.required) parts.push('[required]');
  if (option.default !== undefined) parts.push(`[default: ${option.default}]`);
  return parts.join(' ');
}

function renderOptions(command, columns) {
  const items = command.options.map(option => ({ left: optionLeft(option), description: optionDescription(option) }));
  items.push({ left: '-h, --help', description: 'Print help' });
  return renderList(items, columns);
}

function renderArguments(command, columns) {
  return renderList(command.positionals.map(positional => ({
    left: `<${positional.name.toUpperCase()}>`,
    description: positional.description,
  })), columns);
}

/** Render the top-level help. */
export function rootHelp({ columns = 100 } = {}) {
  const width = widthOf(columns);
  const lines = [
    'dsb — delegate tasks to DeepSeek Harness with bidirectional sessions',
    '',
    'Usage: dsb <COMMAND> [OPTIONS]',
    '',
    'Commands:',
    ...renderList(COMMANDS.map(command => ({ left: command.name, description: command.summary })), width),
    '',
    'Options:',
    ...renderList([
      { left: '-h, --help', description: "Print help (see 'dsb <COMMAND> --help' for details)" },
      { left: '-V, --version', description: 'Print version' },
    ], width),
    '',
    'Environment:',
    ...renderList(ROOT_ENVIRONMENT, width),
  ];
  return lines.join('\n');
}

/** Render help for one command. */
export function commandHelp(name, { columns = 100 } = {}) {
  const command = byName.get(name);
  if (!command) throw new Error(`Unknown command: ${name}. Run 'dsb --help' to list commands`);
  const width = widthOf(columns);
  const lines = [
    command.summary,
    '',
    `Usage: ${command.usage}`,
    '',
  ];
  if (command.positionals.length) lines.push('Arguments:', ...renderArguments(command, width), '');
  lines.push('Options:', ...renderOptions(command, width));
  return lines.join('\n');
}

function parseCommandArgs(command, args) {
  const options = { patch: [], scope: [], resource: [], image: [] };
  const positionals = {};
  const provided = new Set();
  const seenValues = new Set();
  const optionMap = optionsByName.get(command.name);
  let positionalIndex = 0;

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '-h' || token === '--help') return { action: 'help', command: command.name };
    if (token.startsWith('--')) {
      const option = optionMap.get(token);
      if (!option) throw new Error(`Unknown option: ${token}. Run 'dsb ${command.name} --help' for usage`);
      if (!option.value) {
        // Flags are idempotent; this matches the previous parser.
        options[keyOf(option.long)] = true;
        provided.add(option.long);
        continue;
      }
      if (seenValues.has(option.long) && !option.repeatable)
        throw new Error(`Duplicate option: ${option.long}. Run 'dsb ${command.name} --help' for usage`);
      seenValues.add(option.long);
      const value = args[++i];
      if (!value || value.startsWith('--'))
        throw new Error(`Missing value for ${option.long}. Run 'dsb ${command.name} --help' for usage`);
      const key = keyOf(option.long);
      if (option.repeatable) options[key].push(value);
      else options[key] = value;
      provided.add(option.long);
      continue;
    }
    if (positionalIndex < command.positionals.length) {
      positionals[command.positionals[positionalIndex++].name] = token;
      continue;
    }
    throw new Error(`Unexpected argument: ${token}. Run 'dsb ${command.name} --help' for usage`);
  }

  for (const option of command.options) {
    if (option.required && !provided.has(option.long))
      throw new Error(`Missing required option: ${option.long}. Run 'dsb ${command.name} --help' for usage`);
  }
  for (const positional of command.positionals) {
    if (positional.required && positionals[positional.name] === undefined)
      throw new Error(`Missing required argument: <${positional.name.toUpperCase()}>. Run 'dsb ${command.name} --help' for usage`);
  }
  return { action: 'command', command: command.name, options, positionals };
}

/** Parse the arguments after a command name. */
export function parseCommand(name, args) {
  const command = byName.get(name);
  if (!command) throw new Error(`Unknown command: ${name}. Run 'dsb --help' to list commands`);
  return parseCommandArgs(command, args);
}

/** Parse a full argv array (without the node and script paths). */
export function parse(argv) {
  if (!Array.isArray(argv)) throw new TypeError('parse expects an array of arguments');
  if (argv.length === 0) return { action: 'help', command: null };
  const [first, ...rest] = argv;
  if (first === '-h' || first === '--help') return { action: 'help', command: null };
  if (first === '-V' || first === '--version') return { action: 'version' };
  if (first === 'help') {
    if (rest.length === 0 || rest[0] === '-h' || rest[0] === '--help') return { action: 'help', command: null };
    if (!byName.has(rest[0])) throw new Error(`Unknown command: ${rest[0]}. Run 'dsb --help' to list commands`);
    return { action: 'help', command: rest[0] };
  }
  return parseCommand(first, rest);
}
