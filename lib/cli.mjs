// Declarative command table for dsb. This module only parses argument arrays and
// renders help strings; it never reads process.argv or writes to stdout.

export const COMMANDS = [
  {
    name: 'run',
    summary: 'Start a job and stay attached until it ends',
    usage: 'dsb run --brief <FILE> [OPTIONS]',
    positionals: [],

    options: [
      {
        long: '--cwd',
        short: '-C',
        value: 'DIR',
        description: 'Project directory',
        default: 'current directory',
      },
      {
        long: '--brief',
        short: '-b',
        value: 'FILE',
        description: 'Task brief (UTF-8)',
        required: true,
      },
      {
        long: '--patch',
        short: '-p',
        value: 'FILE',
        description: 'Load an MCP patch; repeatable',
        repeatable: true,
      },
      {
        long: '--image',
        short: '-i',
        value: 'FILE',
        description: 'Attach an image; repeatable (max 20, 8 MiB total)',
        repeatable: true,
      },
      {
        long: '--time-limit',
        key: 'timeout',
        value: 'SECONDS',
        description: 'Job time limit (max 86400)',
        default: '2700',
      },
      {
        long: '--context-limit',
        value: 'TOKENS',
        description: 'Context reminder threshold (DPSK_CONTEXT_LIMIT when unset)',
        default: '200000',
      },
      {
        long: '--provider',
        value: 'ROUTE',
        description: 'Model route (DPSK_PROVIDER when unset)',
        default: 'deepseek-official',
      },
      {
        long: '--model',
        value: 'NAME',
        description: 'Model name (DPSK_MODEL when unset)',
        default: 'deepseek-flash',
      },
      {
        long: '--concurrency',
        key: 'maxConcurrent',
        value: 'N',
        description: 'Maximum concurrent jobs, 1..256 (DPSK_CONCURRENCY when unset)',
        default: '8',
      },
      {
        long: '--scope',
        short: '-s',
        value: 'PATH',
        description:
          'Cooperative write scope, not a sandbox; repeatable (default: whole workspace)',
        repeatable: true,
      },
      {
        long: '--read-only',
        description: 'Declare a read-only task; read-only tasks run in parallel',
      },
      {
        long: '--resource',
        value: 'NAME',
        description: 'Shared resource lock; repeatable',
        repeatable: true,
      },
      {
        long: '--dsh-entry',
        value: 'FILE',
        description: 'Advanced/debug: override local dsh lib/bin.js discovery',
      },
    ],
  },

  {
    name: 'wait',
    summary: 'Block until a job finishes, needs an answer, or times out',
    usage: 'dsb wait <ID> [OPTIONS]',
    positionals: [{ name: 'id', description: 'Job ID returned by dsb run', required: true }],

    options: [
      {
        long: '--timeout',
        short: '-t',
        value: 'SECONDS',
        description: 'Wait timeout (1..3600)',
        default: '600',
      },
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
      {
        long: '--cursor',
        key: 'cursor',
        value: 'BYTES',
        description: 'Byte cursor from a previous events response',
        default: '0',
      },
      {
        long: '--limit',
        value: 'N',
        description: 'Maximum events to return (1..200)',
        default: '20',
      },
    ],
  },

  {
    name: 'send',
    summary: 'Queue a follow-up message for a running job',
    usage: 'dsb send <ID> --message <FILE>',
    positionals: [{ name: 'id', description: 'Job ID returned by dsb run', required: true }],

    options: [
      {
        long: '--message',
        short: '-m',
        value: 'FILE',
        description: 'UTF-8 message file',
        required: true,
      },
    ],
  },

  {
    name: 'answer',
    summary: 'Answer a pending request',
    usage: 'dsb answer <ID> --request <REQUEST_ID> --answer <FILE>',
    positionals: [{ name: 'id', description: 'Job ID returned by dsb run', required: true }],

    options: [
      {
        long: '--request',
        short: '-r',
        value: 'REQUEST_ID',
        description: 'Pending request ID from status/events',
        required: true,
      },
      {
        long: '--answer',
        short: '-a',
        value: 'FILE',
        description: 'UTF-8 JSON answer file',
        required: true,
      },
      {
        long: '--user-ok',
        short: '-u',
        description: 'Answer past the 3-question job cap after the user agrees',
      },
    ],
  },

  {
    name: 'retry',
    summary: 'Start a linked rework job and stay attached',
    usage: 'dsb retry <ID> --feedback <FILE> [OPTIONS]',
    positionals: [{ name: 'id', description: 'Job ID returned by dsb run', required: true }],

    options: [
      {
        long: '--feedback',
        short: '-f',
        value: 'FILE',
        description: 'UTF-8 rework feedback file',
        required: true,
      },
      {
        long: '--resume',
        description:
          'Retry only work interrupted by a timeout or unanswered question; not counted as a rework',
      },
      {
        long: '--user-ok',
        short: '-u',
        description: 'Retry past the one-rework task cap after the user agrees',
      },
    ],
  },

  {
    name: 'review',
    summary: 'Record acceptance as accepted, rework, or blocked',
    usage: 'dsb review <ID> --verdict <VERDICT> --note <EVIDENCE> [OPTIONS]',
    positionals: [{ name: 'id', description: 'Job ID returned by dsb run', required: true }],

    options: [
      {
        long: '--verdict',
        value: 'VERDICT',
        description: 'accepted, rework, or blocked',
        required: true,
      },
      { long: '--note', value: 'EVIDENCE', description: 'Verification evidence', required: true },
      {
        long: '--accounting',
        value: 'FILE',
        description:
          'Accounting JSON: {"currency":"CNY","source":"...","deepseekCost":0.12}; every key ending in Cost is recorded, omit unknown costs',
      },
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
    usage: 'dsb unlock <ID> --confirm-stopped',
    positionals: [{ name: 'id', description: 'Job ID returned by dsb run', required: true }],

    options: [
      {
        long: '--confirm-stopped',
        key: 'confirmStopped',
        description: 'Confirm the old task and its child processes stopped',
        required: true,
      },
    ],
  },

  {
    name: 'adopt',
    summary: 'Take over a job started by another session',
    usage: 'dsb adopt <ID> [--user-ok]',
    positionals: [{ name: 'id', description: 'Job ID returned by dsb run', required: true }],

    options: [
      {
        long: '--user-ok',
        short: '-u',
        description: 'Take over even though the other session is still running (user decided)',
      },
    ],
  },

  {
    name: 'stats',
    summary: 'Summarize local jobs, reviews, usage, and costs',
    usage: 'dsb stats [--all]',
    positionals: [],

    options: [
      {
        long: '--all',
        description: 'Count jobs from every session sharing this DSH_HOME',
      },
    ],
  },
];

const byName = new Map(COMMANDS.map((command) => [command.name, command]));

const optionsByName = new Map(
  COMMANDS.map((command) => [
    command.name,
    new Map(command.options.map((option) => [option.long, option])),
  ]),
);

const shortOptionsByName = new Map(
  COMMANDS.map((command) => [
    command.name,
    new Map(
      command.options.filter((option) => option.short).map((option) => [option.short, option]),
    ),
  ]),
);

// Removed option names, with the replacement to name in the error. A removed
// name only hints within the command that used to accept it.
const REMOVED_OPTIONS = new Map([
  [
    'run',
    new Map([
      ['--timeout', "'dsb run' now uses --time-limit <SECONDS>"],
      ['--max-concurrent', "'dsb run' now uses --concurrency <N>"],
    ]),
  ],
  ['send', new Map([['--message-file', "'dsb send' now uses --message <FILE>"]])],
  ['events', new Map([['--after', "'dsb events' now uses --cursor <BYTES>"]])],
  ['unlock', new Map([['--confirmed-stopped', "'dsb unlock' now uses --confirm-stopped"]])],
]);

const ROOT_ENVIRONMENT = [
  { left: 'DPSK_PROVIDER', description: 'Default model route (default: deepseek-official)' },
  { left: 'DPSK_MODEL', description: 'Default model name (default: deepseek-flash)' },
  {
    left: 'DPSK_CONCURRENCY',
    description: 'Concurrent job limit shared by all launchers (default: 8, range 1..256)',
  },
  {
    left: 'DPSK_START_CONCURRENCY',
    description:
      'How many jobs may start at once, shared by all launchers (default: 1, range 1..64)',
  },
  {
    left: 'DPSK_INITIALIZE_TIMEOUT',
    description: 'Milliseconds to wait for dsh to start (default: 120000, plus 60000 per --patch)',
  },
  {
    left: 'DPSK_PROMPT_TIMEOUT',
    description: 'Milliseconds to wait for session creation (default: 90000)',
  },
  {
    left: 'DPSK_OWNER',
    description: 'Identify this host session explicitly instead of deriving it from the processes',
  },
  {
    left: 'DPSK_CONTEXT_LIMIT',
    description: 'Default context reminder threshold in tokens (default: 200000)',
  },
  {
    left: 'DSH_HOME',
    description: 'dsh home directory; bridge jobs live in $DSH_HOME/bridge (default: ~/.dsh)',
  },
];

// Help rendering
function widthOf(columns) {
  const value = Number(columns);
  if (!Number.isFinite(value)) return 100;
  return Math.max(40, Math.floor(value));
}

function keyOf(option) {
  if (option.key) return option.key;
  return option.long.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

function unknownOption(command, token) {
  const hint =
    REMOVED_OPTIONS.get(command.name)?.get(token) ??
    (token === '--notify-cmd' ? 'This experimental option was removed' : null);
  return new Error(
    `Unknown option: ${token}.${hint ? ` ${hint}.` : ''} Run 'dsb ${command.name} --help' for usage`,
  );
}

function wrapWords(text, width) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';

  for (const word of words) {
    if (!line) {
      line = word;
      continue;
    }
    if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);

  return lines.length ? lines : [''];
}

function renderList(items, columns) {
  const indent = 2;
  const gap = 2;
  const leftWidth = Math.max(...items.map((item) => item.left.length));
  const descriptionColumn = indent + leftWidth + gap;
  const descriptionWidth = Math.max(20, columns - descriptionColumn);
  const lines = [];

  for (const item of items) {
    const wrapped = wrapWords(item.description, descriptionWidth);
    lines.push(
      `${' '.repeat(indent)}${item.left}${' '.repeat(leftWidth - item.left.length + gap)}${wrapped[0]}`,
    );
    for (const continuation of wrapped.slice(1))
      lines.push(`${' '.repeat(descriptionColumn)}${continuation}`);
  }

  return lines;
}

function optionLeft(option) {
  const prefix = option.short ? `${option.short}, ` : '    ';
  return `${prefix}${option.long}${option.value ? ` <${option.value}>` : ''}`;
}

function optionDescription(option) {
  const parts = [option.description];
  if (option.required) parts.push('[required]');
  if (option.default !== undefined) parts.push(`[default: ${option.default}]`);
  return parts.join(' ');
}

function renderOptions(command, columns) {
  const items = command.options.map((option) => ({
    left: optionLeft(option),
    description: optionDescription(option),
  }));
  items.push({ left: '-h, --help', description: 'Print help' });
  return renderList(items, columns);
}

function renderArguments(command, columns) {
  return renderList(
    command.positionals.map((positional) => ({
      left: `<${positional.name.toUpperCase()}>`,
      description: positional.description,
    })),
    columns,
  );
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
    ...renderList(
      COMMANDS.map((command) => ({ left: command.name, description: command.summary })),
      width,
    ),
    '',
    'Options:',
    ...renderList(
      [
        { left: '-h, --help', description: "Print help (see 'dsb <COMMAND> --help' for details)" },
        { left: '-V, --version', description: 'Print version' },
      ],
      width,
    ),
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
  const lines = [command.summary, '', `Usage: ${command.usage}`, ''];
  if (command.positionals.length) lines.push('Arguments:', ...renderArguments(command, width), '');
  lines.push('Options:', ...renderOptions(command, width));
  return lines.join('\n');
}

// Argument parsing
function parseCommandArgs(command, args) {
  const options = { patch: [], scope: [], resource: [], image: [] };
  const positionals = {};
  const provided = new Set();
  const seenValues = new Set();
  const optionMap = optionsByName.get(command.name);
  const shortMap = shortOptionsByName.get(command.name);
  let positionalIndex = 0;

  const storeValue = (option, value) => {
    if (seenValues.has(option.long) && !option.repeatable)
      throw new Error(
        `Duplicate option: ${option.long}. Run 'dsb ${command.name} --help' for usage`,
      );
    seenValues.add(option.long);
    const key = keyOf(option);
    if (option.repeatable) options[key].push(value);
    else options[key] = value;
    provided.add(option.long);
  };

  for (let i = 0; i < args.length; i++) {
    const token = args[i];

    if (token === '-h' || token === '--help') return { action: 'help', command: command.name };

    if (token.startsWith('--')) {
      const equals = token.indexOf('=');
      const name = equals === -1 ? token : token.slice(0, equals);
      const inlineValue = equals === -1 ? undefined : token.slice(equals + 1);
      const option = optionMap.get(name);
      if (!option) throw unknownOption(command, name);

      if (!option.value) {
        if (inlineValue !== undefined)
          throw new Error(
            `Option ${name} does not take a value. Run 'dsb ${command.name} --help' for usage`,
          );

        // Flags are idempotent; this matches the previous parser.
        options[keyOf(option)] = true;
        provided.add(option.long);
        continue;
      }

      let value = inlineValue;
      if (value === undefined) {
        value = args[++i];
        if (!value || value.startsWith('--'))
          throw new Error(
            `Missing value for ${option.long}. Run 'dsb ${command.name} --help' for usage`,
          );
      } else if (value === '') {
        throw new Error(
          `Missing value for ${option.long}. Run 'dsb ${command.name} --help' for usage`,
        );
      }

      storeValue(option, value);
      continue;
    }

    if (token.length === 2 && token.startsWith('-') && token !== '-') {
      const option = shortMap.get(token);
      if (!option) throw unknownOption(command, token);

      if (!option.value) {
        options[keyOf(option)] = true;
        provided.add(option.long);
        continue;
      }

      const value = args[++i];
      if (!value || value.startsWith('--'))
        throw new Error(
          `Missing value for ${option.long}. Run 'dsb ${command.name} --help' for usage`,
        );
      storeValue(option, value);
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
      throw new Error(
        `Missing required option: ${option.long}. Run 'dsb ${command.name} --help' for usage`,
      );
  }

  for (const positional of command.positionals) {
    if (positional.required && positionals[positional.name] === undefined)
      throw new Error(
        `Missing required argument: <${positional.name.toUpperCase()}>. Run 'dsb ${command.name} --help' for usage`,
      );
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
    if (rest.length === 0 || rest[0] === '-h' || rest[0] === '--help')
      return { action: 'help', command: null };
    if (!byName.has(rest[0]))
      throw new Error(`Unknown command: ${rest[0]}. Run 'dsb --help' to list commands`);
    return { action: 'help', command: rest[0] };
  }

  return parseCommand(first, rest);
}
