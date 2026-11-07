import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

import semver from 'semver';

import { tokenKeys, collectUsage, readEvents } from './sessions.mjs';
import { runSdk, appendEvent, queueInput, eventsPage, sdkTimeouts } from './live.mjs';
import { acquireSlot, acquireStartGate, releaseReservation } from './scheduler.mjs';
import { currentOwner, ownedBy, ownerAlive } from './owner.mjs';
import {
  bridgeHome,
  liveProcessState,
  processExists,
  supervisorLive,
  touchHeartbeat,
  HEARTBEAT_INTERVAL_MS,
  TERMINAL_STATES as terminal,
  QUESTION_LIMIT,
  REWORK_LIMIT,
  DEFAULT_CONTEXT_LIMIT,
} from './job-state.mjs';

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

// The minimum dsh version lives in package.json so the installer and tests read the same value.
const minimumDshVersion = (() => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (typeof pkg.dshVersion !== 'string' || !semver.valid(pkg.dshVersion)) {
    throw new Error('package.json dshVersion must be a valid semantic version');
  }
  return pkg.dshVersion;
})();

const unsupportedJob = 'Unsupported job format; start a new job with the current bridge';

// Job records
function atomicJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function jobRecord(id, home) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Use the complete job ID returned by dsb run');
  return JSON.parse(fs.readFileSync(path.join(home, 'jobs', id, 'job.json'), 'utf8'));
}

export function readJob(id, home = bridgeHome()) {
  const job = jobRecord(id, home);
  if (job.version !== 2) throw new Error(unsupportedJob);
  return job;
}

export function status(job) {
  return {
    id: job.id,
    parentId: job.parentId,
    processState: liveProcessState(job),
    acceptance: job.review?.verdict || 'unreviewed',
    exitCode: job.exitCode ?? null,
    reportedResult: job.reportedResult ?? null,
    cwd: job.cwd,
    workspace: job.workspace ?? job.cwd,
    workspaceKind: job.workspaceKind ?? 'unrecorded',
    owner: job.owner?.label ?? null,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? null,
    reportFile: job.reportFile,
    stderrFile: job.stderrFile,
    sessionId: job.sdkSessionId,
    provider: job.provider,
    model: job.model,
    retryKind: job.retryKind || null,
    answeredQuestions: job.answeredQuestions || 0,
    questionLimit: QUESTION_LIMIT,
    questionCapLifted: !!job.questionCapLifted,
    context: job.context || null,
    contextLimit: job.contextLimit ?? DEFAULT_CONTEXT_LIMIT,
    contextReminder: job.contextReminder || null,
    pendingRequests: job.pendingRequests || [],
    eventsFile: job.eventsFile,
  };
}

// Tracks delivered answers from the event log without re-reading it each poll.
function eventTracker(file) {
  const handled = new Set();
  let offset = 0,
    carry = Buffer.alloc(0);

  return () => {
    let size;
    try {
      size = fs.statSync(file).size;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      size = 0;
    }

    if (size < offset) {
      offset = 0;
      carry = Buffer.alloc(0);
      handled.clear();
    }
    if (size === offset) return handled;

    const fd = fs.openSync(file, 'r');
    try {
      while (offset < size) {
        const buf = Buffer.alloc(Math.min(1024 * 1024, size - offset));
        const bytes = fs.readSync(fd, buf, 0, buf.length, offset);
        if (!bytes) break;
        offset += bytes;
        carry = Buffer.concat([carry, buf.subarray(0, bytes)]);

        let end;
        while ((end = carry.indexOf(10)) !== -1) {
          let event;
          try {
            event = JSON.parse(carry.subarray(0, end).toString('utf8'));
          } catch {}
          carry = carry.subarray(end + 1);
          if (event?.requestId && event.event === 'input_delivered') handled.add(event.requestId);
          else if (event?.requestId && event.event === 'input_rejected')
            handled.delete(event.requestId);
        }
      }
    } finally {
      fs.closeSync(fd);
    }

    return handled;
  };
}

function queuedAnswers(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return new Set();
    throw error;
  }

  const answers = new Set();
  for (const name of names)
    if (name.endsWith('.json')) {
      try {
        const input = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (input.kind === 'answer' && input.data?.requestId) answers.add(input.data.requestId);
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
    }

  return answers;
}

// Queued answers still target requests in pendingRequests; delivered answers are gone from both.
function queuedQuestionAnswers(job, home) {
  const dir = path.join(home, 'jobs', job.id, 'inbox');
  const questionIds = new Set(
    (job.pendingRequests || [])
      .filter((r) => r.method === 'user-question/ask')
      .map((r) => r.requestId),
  );
  if (!questionIds.size) return 0;

  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }

  const queued = new Set();
  for (const name of names)
    if (name.endsWith('.json')) {
      try {
        const input = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (input.kind === 'answer' && questionIds.has(input.data?.requestId))
          queued.add(input.data.requestId);
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
    }

  return queued.size;
}

export async function waitJob(job, timeoutSeconds = 600, home = bridgeHome()) {
  const timeout = Number(timeoutSeconds);
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 3600)
    throw new Error('timeout must be between 1 and 3600 seconds');

  const dir = path.join(home, 'jobs', job.id),
    scan = eventTracker(path.join(dir, 'events.jsonl')),
    deadline = Date.now() + timeout * 1000;
  for (;;) {
    // Scan first: an answer delivered just before the status read is then
    // absent from the later snapshot instead of waking wait for a dead request.
    const handled = scan(),
      answered = queuedAnswers(path.join(dir, 'inbox'));
    const current = status(readJob(job.id, home));

    // An answer already queued or delivered is not a new request to handle.
    // Once finishing, admission is closed: replies would be rejected, so keep waiting instead.
    const actionable =
      current.processState === 'finishing'
        ? []
        : current.pendingRequests.filter(
            (request) => !answered.has(request.requestId) && !handled.has(request.requestId),
          );
    const actionableRequests = actionable.map((request) => request.requestId);
    const capped = current.answeredQuestions >= current.questionLimit && !current.questionCapLifted;

    const contextFile = path.join(dir, 'context.reported'),
      contextPending = current.contextReminder && !fs.existsSync(contextFile);
    const finished =
      terminal.has(current.processState) || current.processState === 'cleanup_failed';

    // A context reminder only matters while the job can still be steered.
    const reason = finished
      ? 'finished'
      : actionable.length
        ? capped && actionable.every((request) => request.method === 'user-question/ask')
          ? 'escalate'
          : 'request'
        : contextPending
          ? 'context'
          : current.processState === 'unknown'
            ? 'unknown'
            : null;
    if (reason === 'context') fs.writeFileSync(contextFile, `${Date.now()}\n`, { mode: 0o600 });
    if (reason) return { event: 'wait', reason, ...current, actionableRequests };

    const remaining = deadline - Date.now();
    if (remaining <= 0) return { event: 'wait', reason: 'timeout', ...current, actionableRequests };
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, remaining)));
  }
}

// Briefs and reports
export function briefText(file, label = 'Brief') {
  if (fs.statSync(file).size > 48000)
    throw new Error(
      label === 'Brief'
        ? 'Brief is too long: use concise goals and references instead of pasted source/history'
        : `${label} file is too long (limit 48000 bytes)`,
    );
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  if (!text.trim())
    throw new Error(label === 'Brief' ? 'Brief must not be blank' : `${label} must not be blank`);
  return text;
}

// The verdict is a line of its own among the first 10 lines of the final
// reply, outside fenced code blocks, so a short preamble does not hide it.
function reportState(report) {
  let fenced = false;

  for (const line of report.split(/\r?\n/).slice(0, 10)) {
    const text = line.trim();
    if (text.startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    const match = !fenced && /^\**RESULT:\s*(OK|FAIL|BLOCKED)\**(?=\s|$)/.exec(text);
    if (match) return match[1];
  }
  return 'UNKNOWN';
}

// Launch helpers
function git(cwd, args) {
  return spawnSync('git', ['-c', `safe.directory=${cwd}`, ...args], {
    cwd,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

/**
 * The root that `--scope` is relative to and that concurrent writers exclude
 * each other within.
 *
 * A Git repository gives one root for the whole project, so jobs in different
 * subdirectories of it coordinate with each other. Without a repository the
 * working directory is the root, which keeps separate working directories
 * under a shared parent independent of each other. `kind` records which rule
 * applied, so callers never have to guess whether Git was involved.
 */
function workspaceRoot(cwd) {
  const result = git(cwd, ['rev-parse', '--show-toplevel']);
  const root = result.status === 0 ? result.stdout.trim() : '';
  return root ? { root: fs.realpathSync(root), kind: 'git' } : { root: cwd, kind: 'directory' };
}

function baseline(cwd) {
  const result = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  return {
    capturedAt: Date.now(),
    available: result.status === 0,
    status: result.status === 0 ? result.stdout : null,
    note: 'Inventory only, not a backup or attribution of pre-existing changes.',
  };
}

/**
 * An optional millisecond setting. `undefined` means the job states nothing and
 * keeps the default; `lib/live.mjs` treats a present field as stated, so a
 * blank or missing value must not reach the record.
 */
function statedMilliseconds(value, name) {
  if (value === undefined || value === null || value === '') return undefined;

  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms < 1)
    throw new Error(`${name} must be a positive whole number of milliseconds`);
  return ms;
}

function resolveDsh(entry) {
  const candidates = entry
    ? [path.resolve(entry)]
    : (process.env.PATH || '')
        .split(path.delimiter)
        .filter(Boolean)
        .flatMap((dir) => [
          path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
          path.join(dir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
        ]);

  for (const file of candidates) {
    try {
      if (fs.statSync(file).isFile()) return fs.realpathSync(file);
    } catch {}
  }

  throw new Error(
    'Cannot locate dsh. Install @deepseek-ai/dsh or pass --dsh-entry /path/to/dsh/lib/bin.js',
  );
}

// Section headings appended to every brief. lib/viewer-model.mjs strips them
// from the transcript view (together with the legacy Chinese headings).
export const PROMPT_MARKERS = {
  contract: '[dpsk-bridge report contract]',
  scope: '[dpsk-bridge work scope]',
  images: '[dpsk-bridge attached images]',
  rework: '[dpsk-bridge rework]',
};

const reportContract = `\n\n${PROMPT_MARKERS.contract}
Work toward the goal, scope, and acceptance criteria above, within the authorization the brief describes. Points the brief settles are fixed; everything it leaves open is yours to decide, including which code to read, how to implement, and how to investigate problems you meet along the way.
Ask the host with the available question tool, and wait for the answer, when the settled points do not fit the code you find, when two reasonable approaches would give results the user would notice as different, or when the work needs a wider scope than the brief allows. Keep each question short: the options you see and the one you recommend.
Use standard English for your reports, progress updates, and questions to the host, even when the brief or the code uses another language. Files you create or edit follow the project's own language and conventions.
Your final reply is the report the host reads, also when the brief asks you to write a report file as well. Start that reply with the line RESULT: OK|FAIL|BLOCKED. Then, in about 15 lines: the conclusion; changed files or evidence locations; verification commands with exit codes; a "Decisions I made" list of the choices you made where the brief left room and a reviewer should check; and every criterion you did not verify, named as unverified.
Keep the report to that summary and give file paths for detailed logs, long output, and code.`;

// Matches the JSON-RPC line limit enforced by SdkPeer.send in lib/sdk.mjs.
const sdkMessageLimit = 8 * 1024 * 1024;

function imageMimeType(buffer) {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return 'image/jpeg';

  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('latin1')))
    return 'image/gif';

  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';

  return null;
}

// The first session/prompt is the second request on the transport, so its JSON-RPC id is 2.
function encodedPromptSize(sessionId, prompt, images) {
  const blocks = images.map((image) => ({ type: 'image', mimeType: image.mimeType, data: '' }));
  const line =
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId, contentBlocks: [{ type: 'text', text: prompt }, ...blocks] },
    }) + '\n';
  return Buffer.byteLength(line) + images.reduce((total, image) => total + image.base64Length, 0);
}

// Job execution
export async function runJob(options, emit = () => {}, home = bridgeHome()) {
  const cwd = fs.realpathSync(options.cwd || process.cwd());
  if (!fs.statSync(cwd).isDirectory()) throw new Error('cwd must be a directory');

  const originalBrief = options.originalBrief ?? briefText(options.brief);
  const patches = (options.patch || []).map((file) => fs.realpathSync(file));
  const patchHashes = patches.map((file) => sha(fs.readFileSync(file)));
  const imageFiles = options.image || [];
  if (imageFiles.length > 20) throw new Error('At most 20 images per job');
  const images = imageFiles.map((file) => {
    const real = fs.realpathSync(file);
    if (!fs.statSync(real).isFile()) throw new Error(`Image is not a regular file: ${real}`);

    const buffer = fs.readFileSync(real);
    const mimeType = imageMimeType(buffer);
    if (!mimeType)
      throw new Error(`Unsupported image format (JPEG, PNG, GIF and WebP only): ${real}`);
    return {
      path: real,
      sha256: sha(buffer),
      mimeType,
      base64Length: 4 * Math.ceil(buffer.length / 3),
    };
  });

  const timeout = Number(options.timeout ?? 2700);
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 86400)
    throw new Error('time-limit must be greater than 0 and at most 86400 seconds');

  const heartbeatIntervalMs = Number(options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
  if (!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs < 1)
    throw new Error('heartbeat-interval must be a positive number of milliseconds');

  const contextLimit = Number(
    options.contextLimit ?? process.env.DPSK_CONTEXT_LIMIT ?? DEFAULT_CONTEXT_LIMIT,
  );
  if (!Number.isSafeInteger(contextLimit) || contextLimit < 1)
    throw new Error('context-limit must be a positive integer');

  const maxConcurrent = Number(options.maxConcurrent ?? process.env.DPSK_CONCURRENCY ?? 8);
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 256)
    throw new Error('concurrency must be 1..256');

  // dsh has no startup lock of its own and repeats its whole cold start in
  // every process, so simultaneous starts multiply that work until they all
  // exceed the SDK request budget. Jobs still run concurrently; they just take
  // turns coming up.
  const startConcurrency = Number(
    options.startConcurrency ?? process.env.DPSK_START_CONCURRENCY ?? 1,
  );
  if (!Number.isInteger(startConcurrency) || startConcurrency < 1 || startConcurrency > 64)
    throw new Error('start-concurrency must be 1..64');

  const initializeTimeoutMs = statedMilliseconds(
    options.initializeTimeoutMs ?? process.env.DPSK_INITIALIZE_TIMEOUT,
    'DPSK_INITIALIZE_TIMEOUT',
  );
  const promptTimeoutMs = statedMilliseconds(
    options.promptTimeoutMs ?? process.env.DPSK_PROMPT_TIMEOUT,
    'DPSK_PROMPT_TIMEOUT',
  );

  const entry = resolveDsh(options.dshEntry);
  let dshVersion = null;
  try {
    dshVersion = JSON.parse(
      fs.readFileSync(path.join(path.dirname(entry), '..', 'package.json'), 'utf8'),
    ).version;
  } catch {}

  if (!semver.valid(dshVersion) || semver.lt(dshVersion, minimumDshVersion))
    throw new Error(
      `dsh ${dshVersion || 'unknown'} is unsupported. Update @deepseek-ai/dsh to >=${minimumDshVersion}.`,
    );

  const id = crypto.randomUUID(),
    marker = `[bridge-task:${id}]`,
    { root: workspace, kind: workspaceKind } = workspaceRoot(cwd);
  const scopeNote = `\n\n${PROMPT_MARKERS.scope}\nWorkspace root: ${workspace}\n${
    options.readOnly
      ? 'This task is read-only: read files and run commands that leave files and external state unchanged.'
      : `You may modify only these paths (relative to the workspace root): ${(options.scope?.length ? options.scope : ['.']).join(', ')}`
  }\nScopes coordinate concurrent jobs; your authorization is still what the brief describes.`;

  const imageNote = images.length
    ? `\n\n${PROMPT_MARKERS.images}\nThis task includes ${images.length} image${images.length === 1 ? '' : 's'}, in order: ${images.map((image) => path.basename(image.path)).join(', ')}`
    : '';

  const prompt =
    originalBrief +
    imageNote +
    reportContract +
    scopeNote +
    (options.feedback ? `\n\n${PROMPT_MARKERS.rework}\n${options.feedback}` : '') +
    '\n\n' +
    marker +
    '\n';

  if (images.length) {
    const encoded = encodedPromptSize(id, prompt, images);
    if (encoded > sdkMessageLimit)
      throw new Error(
        `Images are too large for one SDK message (${encoded} > ${sdkMessageLimit}); downscale or split them`,
      );
  }

  const dir = path.join(home, 'jobs', id),
    file = path.join(dir, 'job.json');
  const heartbeatFile = path.join(dir, 'heartbeat');
  const launchArgs = [entry, '--profile', 'sdk', ...patches.flatMap((file) => ['--patch', file])];

  if (
    process.platform === 'win32' &&
    JSON.stringify([process.execPath, ...launchArgs]).length > 28000
  )
    throw new Error(
      'Windows command line would be too long. Shorten paths/brief or use the SDK transport.',
    );

  const job = {
    version: 2,
    id,
    parentId: options.parentId || null,
    rootId: options.rootId || id,
    cwd,
    workspace,
    workspaceKind,
    owner: options.owner ?? currentOwner(),
    entry,
    patches,
    patchHashes,
    timeout,
    images: images.map((image) => ({
      path: image.path,
      sha256: image.sha256,
      mimeType: image.mimeType,
    })),
    dshVersion,
    provider: options.provider || process.env.DPSK_PROVIDER || 'deepseek-official',
    model: options.model || process.env.DPSK_MODEL || 'deepseek-flash',
    sdkSessionId: id,
    scopes: options.scope || [],
    readOnly: !!options.readOnly,
    resources: options.resource || [],
    maxConcurrent,
    startConcurrency,
    ...(initializeTimeoutMs === undefined ? {} : { initializeTimeoutMs }),
    ...(promptTimeoutMs === undefined ? {} : { promptTimeoutMs }),
    retryKind: options.retryKind || null,
    contextLimit,
    answeredQuestions: 0,
    questionCapLifted: false,
    context: null,
    contextReminder: null,
    supervisorPid: process.pid,
    childPid: null,
    processState: 'queued',
    startedAt: Date.now(),
    heartbeatFile,
    heartbeatIntervalMs,
    reportFile: path.join(dir, 'report.txt'),
    stderrFile: path.join(dir, 'stderr.log'),
    eventsFile: path.join(dir, 'events.jsonl'),
    briefHash: sha(originalBrief),
    originalBriefFile: path.join(dir, 'brief.md'),
    review: null,
    usage: null,
    exitCode: null,
  };

  const save = () => atomicJson(file, job),
    queueAbort = new AbortController();

  const recordFailure = (label, error) => {
    const message = `${label}: ${error.message}`;
    job.error = job.error ? `${job.error}; ${message}` : message;
    try {
      appendEvent(dir, { event: 'bookkeeping_failed', error: message });
    } catch {}
  };

  const persist = (label) => {
    try {
      save();
    } catch (error) {
      recordFailure(label, error);
    }
  };

  let child,
    reservation,
    startGate,
    timeoutTimer,
    pollTimer,
    heartbeatTimer,
    stopReason = null,
    stopping,
    cleanupError = null;

  const fds = [];

  const stop = (reason) => {
    stopReason ||= reason;
    queueAbort.abort(new Error(reason));
    if (stopping || !child?.pid) return stopping;
    stopping = new Promise((resolve) => {
      const failed = (message) => {
        cleanupError = message;
        resolve();
      };

      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        const deadline = setTimeout(() => {
          killer.kill();
          failed('Process-tree cleanup timed out; reservation retained.');
        }, 10000);

        killer.once('error', (error) => {
          clearTimeout(deadline);
          failed(`Process-tree cleanup failed: ${error.message}`);
        });

        killer.once('close', (code) => {
          clearTimeout(deadline);
          if (code !== 0 && processExists(child.pid))
            failed('Process-tree cleanup failed; reservation retained.');
          else resolve();
        });
      } else {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {}

        const timer = setTimeout(() => {
          if (!processExists(child.pid)) {
            resolve();
            return;
          }

          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {}

          if (processExists(child.pid))
            failed('Process-tree cleanup failed; reservation retained.');
          else resolve();
        }, 1500);
        child.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      }
    });
    return stopping;
  };

  // The gate is released the moment dsh reports it is up. A job that never
  // reaches that point releases it during cleanup instead, so one failed start
  // cannot hold back every queued job.
  const releaseStartGate = () => {
    const gate = startGate;
    startGate = null;
    return gate ? gate.release() : Promise.resolve();
  };

  const onSignal = () => {
    void stop('cancelled');
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
    fs.writeFileSync(job.originalBriefFile, originalBrief, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'prompt.txt'), prompt, { mode: 0o600 });
    fs.writeFileSync(job.reportFile, '', { mode: 0o600 });
    fs.writeFileSync(job.eventsFile, '', { mode: 0o600 });
    fs.writeFileSync(heartbeatFile, '', { mode: 0o600 });
    if (options.feedback)
      fs.writeFileSync(path.join(dir, 'feedback.md'), options.feedback, { mode: 0o600 });

    save();
    emit({ event: 'queued', ...status(job) });

    // Keep refreshing while queued and running: the recorded PID alone stops
    // proving ownership once Windows reuses it.
    heartbeatTimer = setInterval(() => {
      touchHeartbeat(heartbeatFile);
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
    timeoutTimer = setTimeout(() => {
      void stop('timed_out');
    }, timeout * 1000);
    pollTimer = setInterval(() => {
      if (fs.existsSync(path.join(dir, 'cancel.request'))) void stop('cancelled');
    }, 100);

    reservation = await acquireSlot({
      home,
      id,
      workspace,
      scopes: job.scopes,
      heartbeatFile,
      readOnly: job.readOnly,
      resources: job.resources,
      maxConcurrent,
      signal: queueAbort.signal,
    });

    job.processState = 'starting';
    save();
    if (stopReason) throw new Error(stopReason);

    atomicJson(path.join(dir, 'baseline.json'), baseline(cwd));

    // Held from just before the spawn until dsh reports it is up, so cold
    // starts take turns instead of competing for the same disk and network.
    startGate = await acquireStartGate({
      home,
      id,
      heartbeatFile,
      limit: startConcurrency,
      signal: queueAbort.signal,
    });

    const stderr = fs.openSync(job.stderrFile, 'w', 0o600);
    fds.push(stderr);
    child = spawn(process.execPath, launchArgs, {
      cwd,
      stdio: ['pipe', 'pipe', stderr],
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: process.env,
    });

    const outcomePromise = new Promise((resolve) => {
      child.once('error', (error) => resolve({ code: null, error: error.message }));
      child.once('close', (code, signal) => resolve({ code, signal }));
    });

    job.childPid = child.pid ?? null;
    job.processState = 'running';
    save();
    if (child.pid) await reservation.setChildPid(child.pid);
    emit({ event: 'started', ...status(job) });

    let sdkError = null;
    try {
      await runSdk(child, {
        job,
        dir,
        prompt,
        save,
        emit,
        signal: queueAbort.signal,
        images: images.map((image) => ({ path: image.path, mimeType: image.mimeType })),
        onReady: releaseStartGate,
      });
    } catch (error) {
      sdkError = error;
      await stop(stopReason || 'failed');
    }

    // Bound a runtime that acknowledges shutdown but keeps handles alive.
    let shutdownDeadline;
    if (!stopping)
      shutdownDeadline = setTimeout(() => {
        void stop('failed');
      }, 10000);

    const outcome = await Promise.race([
      outcomePromise,
      new Promise((resolve) => {
        const check = setInterval(() => {
          if (cleanupError) {
            clearInterval(check);
            resolve({ code: null, error: cleanupError });
          }
        }, 100);

        outcomePromise.finally(() => clearInterval(check));
      }),
    ]);
    clearTimeout(shutdownDeadline);
    if (stopping) await stopping;

    job.exitCode = outcome.code;
    job.signal = outcome.signal || null;
    job.processState = cleanupError
      ? 'cleanup_failed'
      : stopReason ||
        (outcome.error ? 'launch_failed' : outcome.code === 0 ? 'completed' : 'failed');
    if (sdkError || outcome.error) job.error = sdkError?.message || outcome.error;
    job.finishedAt = Date.now();
    job.reportedResult = reportState(readPrefix(job.reportFile, 8192));
    job.pendingRequests = [];

    // The run result is decided above; bookkeeping below must not rewrite it.
    persist('saving the result');

    try {
      job.usage = collectUsage(readEvents(path.join(dir, 'root.session.jsonl')).events);
    } catch (error) {
      job.usage = { available: false, reason: error.message };
    }

    try {
      atomicJson(path.join(dir, 'after.json'), baseline(cwd));
    } catch (error) {
      recordFailure('writing after.json', error);
    }
    persist('saving bookkeeping');
  } catch (error) {
    if (child?.pid && processExists(child.pid)) await stop(stopReason || 'failed');

    job.processState = cleanupError ? 'cleanup_failed' : stopReason || 'failed';
    job.error = error.message;
    job.finishedAt = Date.now();
    job.reportedResult = 'UNKNOWN';
    save();
  } finally {
    clearTimeout(timeoutTimer);
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);

    try {
      await releaseStartGate();
    } catch (error) {
      recordFailure('releasing the start gate', error);
    }
    fds.forEach((fd) => {
      try {
        fs.closeSync(fd);
      } catch {}
    });

    if (reservation && !cleanupError && (!child?.pid || !processExists(child.pid))) {
      try {
        await reservation.release();
      } catch (error) {
        job.processState = 'cleanup_failed';
        job.error = job.error
          ? `${job.error}; Reservation release failed: ${error.message}`
          : `Reservation release failed: ${error.message}`;
        persist('saving the cleanup state');
      }
    }

    if (cleanupError) {
      child?.stdin?.destroy();
      child?.stdout?.destroy();
      child?.unref();
    }

    // Every accepted-but-undelivered input gets an explicit terminal disposition.
    const dispositionFailures = [];
    try {
      const inbox = path.join(dir, 'inbox');
      if (fs.existsSync(inbox))
        for (const name of fs.readdirSync(inbox).filter((n) => n.endsWith('.json'))) {
          const inputFile = path.join(inbox, name);
          let input;
          try {
            input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
          } catch (error) {
            if (error.code === 'ENOENT') continue;
            dispositionFailures.push(`${name}: ${error.message}`);
            continue;
          }

          try {
            appendEvent(dir, {
              event: 'input_rejected',
              inputId: input.id,
              error: 'Job ended before delivery',
            });
            fs.unlinkSync(inputFile);
          } catch (error) {
            if (error.code === 'ENOENT') continue;
            dispositionFailures.push(`${input.id || name}: ${error.message}`);
          }
        }
    } catch (error) {
      dispositionFailures.push(error.message);
    }

    if (dispositionFailures.length) {
      const message = `Inbox disposition failed: ${dispositionFailures.join('; ')}`;
      job.error = job.error ? `${job.error}; ${message}` : message;
      try {
        fs.appendFileSync(job.stderrFile, message + '\n', { mode: 0o600 });
      } catch {}
      persist('saving the result');
    }
  }

  return job;
}

function readPrefix(file, bytes = 6000) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    return buf.subarray(0, fs.readSync(fd, buf, 0, bytes, 0)).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export function result(job) {
  return {
    ...status(job),
    error: job.error || null,
    report: readPrefix(job.reportFile),
    reportTruncated: fs.statSync(job.reportFile).size > 6000,
    usage: job.usage,
    verificationRequired: job.review?.verdict !== 'accepted',
  };
}

function taskReworkCount(parent, home) {
  const rootId = parent.rootId || parent.id;
  let ids;
  try {
    ids = fs.readdirSync(path.join(home, 'jobs'));
  } catch {
    ids = [];
  }

  const seen = new Set();
  let count = 0;

  for (const id of ids) {
    if (!/^[a-f0-9-]{36}$/.test(id)) continue;

    let record;
    try {
      record = jobRecord(id, home);
    } catch {
      continue;
    }

    if (record.version !== 2 || (record.rootId || record.id) !== rootId || !record.parentId)
      continue;
    seen.add(id);
    if ((record.retryKind || 'rework') === 'rework') count++;
  }

  if (parent.parentId && (parent.retryKind || 'rework') === 'rework' && !seen.has(parent.id))
    count++;

  return count;
}

// Commands
export async function retryJob(
  parent,
  feedback,
  emit,
  home = bridgeHome(),
  { userOk = false, resume = false } = {},
) {
  assertOwned(parent);
  if (parent.processState === 'cleanup_failed')
    throw new Error(
      `Cleanup failed for this job; run dsb unlock ${parent.id} --confirm-stopped, then start a new task with dsb run. This job cannot be retried or reviewed.`,
    );
  if (!terminal.has(parent.processState))
    throw new Error('Previous run has no confirmed terminal state; inspect/cancel it first');
  if (parent.review?.verdict === 'accepted')
    throw new Error('Accepted jobs should not be retried; create a new task');

  for (let i = 0; i < parent.patches.length; i++) {
    if (sha(fs.readFileSync(parent.patches[i])) !== parent.patchHashes[i])
      throw new Error(
        'MCP patch changed since the previous run; review configuration and create a new job',
      );
  }

  const images = parent.images || [];
  for (const image of images) {
    let buffer;
    try {
      buffer = fs.readFileSync(image.path);
    } catch {
      throw new Error('Image changed since the previous run; create a new job');
    }
    if (sha(buffer) !== image.sha256)
      throw new Error('Image changed since the previous run; create a new job');
  }

  const originalBrief = briefText(parent.originalBriefFile);
  if (sha(originalBrief) !== parent.briefHash)
    throw new Error('Original brief changed; create a new job with reviewed requirements');

  // Inputs are checked first, so the user is only asked about a rework that can actually run.
  const retryKind = resume ? 'resume' : 'rework';
  if (retryKind === 'rework' && !userOk && taskReworkCount(parent, home) >= REWORK_LIMIT)
    throw new Error(
      'This task already used its one rework. Tell the user the current state, what was tried, and the failure evidence; if the user decides to continue, repeat the command with --user-ok.',
    );

  return runJob(
    {
      cwd: parent.cwd,
      originalBrief,
      patch: parent.patches,
      image: images.map((image) => image.path),
      timeout: parent.timeout,
      dshEntry: parent.entry,
      provider: parent.provider,
      model: parent.model,
      scope: parent.scopes,
      resource: parent.resources,
      readOnly: parent.readOnly,
      maxConcurrent: parent.maxConcurrent,
      contextLimit: parent.contextLimit ?? DEFAULT_CONTEXT_LIMIT,
      retryKind,
      feedback: `The previous job ${parent.id} has ended. Check the current state of the workspace first, keep existing user changes and completed work, fix only what remains, and treat external actions that already succeeded as done.\n${feedback}`,
      parentId: parent.id,
      rootId: parent.rootId,
    },
    emit,
    home,
  );
}

export function reviewJob(job, verdict, note, home = bridgeHome(), accounting = null) {
  assertOwned(job);
  if (!['accepted', 'rework', 'blocked'].includes(verdict) || !note?.trim())
    throw new Error('review requires --verdict accepted|rework|blocked and a verification --note');
  if (job.processState === 'cleanup_failed')
    throw new Error(
      `Cleanup failed for this job; run dsb unlock ${job.id} --confirm-stopped, then start a new task with dsb run. This job cannot be retried or reviewed.`,
    );
  if (!terminal.has(job.processState)) throw new Error('Cannot review an active or unknown job');
  if (verdict === 'accepted' && (job.exitCode !== 0 || job.reportedResult !== 'OK'))
    throw new Error(
      'Failed, incomplete, or non-OK runs cannot be marked accepted. Record rework/blocked and verify a new run.',
    );

  if (accounting) {
    for (const key of Object.keys(accounting))
      if (
        /^[a-z][A-Za-z0-9]*Cost$/.test(key) &&
        accounting[key] != null &&
        (typeof accounting[key] !== 'number' ||
          !Number.isFinite(accounting[key]) ||
          accounting[key] < 0)
      )
        throw new Error('Costs must be nonnegative numbers');

    if (
      typeof accounting.currency !== 'string' ||
      !accounting.currency ||
      typeof accounting.source !== 'string' ||
      !accounting.source
    )
      throw new Error(
        'Accounting requires currency and source; omit unknown costs rather than using zero',
      );
  }

  job.review = { verdict, note, at: Date.now() };
  if (accounting) job.accounting = accounting;
  atomicJson(path.join(home, 'jobs', job.id, 'job.json'), job);

  return status(job);
}

/**
 * Jobs from every workspace share one DSH_HOME, so a session can reach a job it
 * did not start. Reading one stays open — that is how an orphaned job gets
 * inspected before it is adopted — but changing one does not, because an agent
 * that mistakes another session's job for its own would otherwise cancel it.
 *
 * Records written before ownership existed carry no owner and stay open to
 * every session, so an upgrade does not strand work that is already running.
 */
function assertOwned(job) {
  if (!job.owner?.id || ownedBy(job, currentOwner())) return;

  const who = job.owner.label || 'another session';
  throw new Error(
    ownerAlive(job.owner) === false
      ? `Job ${job.id} was started by ${who}, which is gone. Adopt it first: dsb adopt ${job.id}`
      : `Job ${job.id} belongs to ${who}, not to this session. Leave it alone unless the user asked you to take it over; then: dsb adopt ${job.id} --user-ok`,
  );
}

/**
 * Take over a job started by another session, so its remaining work can be
 * finished after that session ended. An owner that is still live is only
 * replaced with the user's explicit decision.
 */
export function adoptJob(job, { userOk = false } = {}, home = bridgeHome()) {
  const owner = currentOwner();
  if (ownedBy(job, owner))
    return {
      id: job.id,
      adopted: false,
      owner: owner.label,
      note: 'Already owned by this session',
    };

  const previous = job.owner?.label ?? 'unrecorded';
  if (job.owner?.id && ownerAlive(job.owner) === true && !userOk)
    throw new Error(
      `Job ${job.id} is still held by ${previous}, which is running. Take it over only when the user asked for it: dsb adopt ${job.id} --user-ok`,
    );

  const dir = path.join(home, 'jobs', job.id);
  job.owner = owner;
  atomicJson(path.join(dir, 'job.json'), job);
  try {
    appendEvent(dir, { event: 'owner_adopted', from: previous, to: owner.label });
  } catch {}

  return {
    id: job.id,
    adopted: true,
    previousOwner: previous,
    owner: owner.label,
    note: 'Inspect the job state before continuing; an adopted job is not automatically resumed.',
  };
}

export function cancelJob(job, home = bridgeHome()) {
  assertOwned(job);
  if (terminal.has(job.processState)) return { ...status(job), cancelRequested: false };
  if (job.processState === 'cleanup_failed')
    throw new Error('Cleanup already failed; inspect recorded processes before recovery');
  if (!supervisorLive(job))
    throw new Error(
      'Supervisor is gone or its heartbeat is stale; inspect the recorded child process and workspace before recovery',
    );

  fs.writeFileSync(path.join(home, 'jobs', job.id, 'cancel.request'), 'cancel\n', { mode: 0o600 });

  return {
    ...status(job),
    cancelRequested: true,
    note: 'Request queued; wait for a terminal state before retrying.',
  };
}

export async function unlockJob(job, confirmStopped, home = bridgeHome()) {
  assertOwned(job);
  if (!confirmStopped)
    throw new Error(
      'Confirm the old task and its child processes stopped, then use --confirm-stopped',
    );
  if (supervisorLive(job)) throw new Error('A recorded process is still present; do not unlock');

  const supervisorPresent = processExists(job.supervisorPid),
    childPresent = processExists(job.childPid);
  await releaseReservation(home, job.id, { confirmedStopped: true, ignoreChild: true });

  const present = [];
  if (supervisorPresent) present.push(`supervisor ${job.supervisorPid}`);
  if (childPresent) present.push(`child ${job.childPid}`);

  return {
    id: job.id,
    unlocked: true,
    ...(present.length
      ? {
          warning: `Supervisor is not live, but these recorded PIDs still exist: ${present.join(', ')}. Confirm before reusing the workspace.`,
        }
      : {}),
    note: 'Inspect partial changes before creating a new run; unknown runs are not automatically retried.',
  };
}

export function sendMessage(job, text, home = bridgeHome()) {
  assertOwned(job);
  if (!text?.trim()) throw new Error('Message must not be blank');
  if (!supervisorLive(job))
    throw new Error(
      'Supervisor is gone or its heartbeat is stale; inspect this job before recovery',
    );
  return queueInput(job, 'message', { text }, home);
}

export function answerRequest(job, requestId, answer, home = bridgeHome(), userOk = false) {
  assertOwned(job);
  const request = job.pendingRequests?.find((r) => r.requestId === requestId);
  if (!requestId || !request) throw new Error('Use a pending requestId from status/events');
  if (!supervisorLive(job)) throw new Error('Supervisor is gone or its heartbeat is stale');
  if (
    !userOk &&
    !job.questionCapLifted &&
    request.method === 'user-question/ask' &&
    (job.answeredQuestions || 0) + queuedQuestionAnswers(job, home) >= QUESTION_LIMIT
  )
    throw new Error(
      `The job already had ${QUESTION_LIMIT} questions answered. Tell the user what is happening; if the user decides to continue, repeat the command with --user-ok.`,
    );

  return queueInput(
    job,
    'answer',
    { requestId, answer, ...(userOk ? { userOk: true } : {}) },
    home,
  );
}

export { eventsPage, reportState };

export function stats(home = bridgeHome(), { all = false } = {}) {
  let ids;
  try {
    ids = fs.readdirSync(path.join(home, 'jobs'));
  } catch {
    ids = [];
  }

  // Every workspace shares one DSH_HOME, so counting all of it would bill this
  // session for work other sessions did. Records from before ownership existed
  // have no owner to compare and stay counted.
  const owner = all ? null : currentOwner();

  const jobs = [];
  let unreadableJobs = 0,
    legacyJobs = 0,
    otherSessionJobs = 0;
  for (const id of ids) {
    let record;
    try {
      record = jobRecord(id, home);
    } catch {
      unreadableJobs++;
      continue;
    }

    if (record.version === 1) {
      legacyJobs++;
      continue;
    }
    if (record.version !== 2) {
      unreadableJobs++;
      continue;
    }
    if (owner && record.owner?.id && !ownedBy(record, owner)) {
      otherSessionJobs++;
      continue;
    }
    jobs.push(record);
  }

  const tokens = Object.fromEntries(tokenKeys.map((key) => [key, 0]));
  const tokenRecords = Object.fromEntries(tokenKeys.map((key) => [key, 0]));
  const costsByCurrency = Object.create(null);

  for (const job of jobs) {
    for (const key of tokenKeys) {
      const value = job.usage?.tokens?.[key];
      if (Number.isSafeInteger(value) && value >= 0) {
        tokens[key] += value;
        tokenRecords[key]++;
      }
    }

    const a = job.accounting;
    if (!a) continue;

    const group = (costsByCurrency[a.currency] ||= Object.assign(Object.create(null), {
      claudeCost: 0,
      codexCost: 0,
      deepseekCost: 0,
      claudeRecords: 0,
      codexRecords: 0,
      deepseekRecords: 0,
    }));

    for (const key of Object.keys(a)) {
      if (!/^[a-z][A-Za-z0-9]*Cost$/.test(key) || !Number.isFinite(a[key])) continue; // null means unknown, not zero
      const name = key.slice(0, -4);
      if (!Object.hasOwn(group, key)) {
        group[key] = 0;
        group[`${name}Records`] = 0;
      }
      group[key] += a[key];
      group[`${name}Records`]++;
    }
  }

  return {
    counts: all ? 'every session sharing this DSH_HOME' : 'jobs started by this session',
    jobs: jobs.length,
    otherSessionJobs,
    legacyJobs,
    unreadableJobs,
    tasks: new Set(jobs.map((j) => j.rootId)).size,
    retries: jobs.filter((j) => j.parentId).length,
    acceptedTasks: new Set(
      jobs.filter((j) => j.review?.verdict === 'accepted').map((j) => j.rootId),
    ).size,
    acceptedFirstAttempts: jobs.filter((j) => !j.parentId && j.review?.verdict === 'accepted')
      .length,
    usageRecords: jobs.filter((j) => j.usage?.available).length,
    missingUsageRecords: jobs.filter((j) => !j.usage?.available).length,
    observedSessionTokens: Object.fromEntries(
      tokenKeys.map((key) => [
        key,
        tokenRecords[key] && Number.isSafeInteger(tokens[key]) ? tokens[key] : null,
      ]),
    ),
    tokenRecords,
    missingTokenRecords: Object.fromEntries(
      tokenKeys.map((key) => [key, jobs.length - tokenRecords[key]]),
    ),
    costsByCurrency,
    note: 'Usage covers mirrored root session logs; missing samples/child sessions may be billed. Costs are supplied records, not inferred from tokens. Savings need a comparable baseline using the same host without delegation.',
  };
}
