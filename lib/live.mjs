import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { SdkPeer } from './sdk.mjs';
import { DEFAULT_CONTEXT_LIMIT } from './job-state.mjs';

export function appendEvent(dir, event) {
  const file = path.join(dir, 'events.jsonl');
  const line = JSON.stringify({ time: Date.now(), ...event }) + '\n';
  if (
    (fs.existsSync(file) ? fs.statSync(file).size : 0) + Buffer.byteLength(line) >
    256 * 1024 * 1024
  )
    throw new Error('Job events exceed 256 MiB; inspect the saved log');
  fs.appendFileSync(file, line, { mode: 0o600 });
}

// Queue acceptance is distinct from delivery recorded in events.jsonl.
export function queueInput(job, kind, data, home) {
  if (!['running', 'starting', 'queued'].includes(job.processState))
    throw new Error('Job is no longer accepting input');

  const dir = path.join(home, 'jobs', job.id, 'inbox');
  fs.mkdirSync(dir, { recursive: true });
  if (fs.readdirSync(dir).filter((name) => name.endsWith('.json')).length >= 256)
    throw new Error('Job inbox is full');

  const id = crypto.randomUUID();
  const record = JSON.stringify({ id, kind, data });
  if (Buffer.byteLength(record) > 64 * 1024) throw new Error('Input exceeds 64 KiB');
  const file = path.join(dir, `${Date.now()}-${id}.json`),
    tmp = file + '.tmp';
  fs.writeFileSync(tmp, record, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);

  // The supervisor may have ended between the caller's status check and enqueue.
  const latest = JSON.parse(fs.readFileSync(path.join(home, 'jobs', job.id, 'job.json'), 'utf8'));
  if (!['running', 'starting', 'queued'].includes(latest.processState)) {
    try {
      fs.unlinkSync(file);
    } catch {}
    throw new Error('Job finished before input was accepted');
  }

  return {
    id: job.id,
    inputId: id,
    state: 'queued',
    note: 'Read events for input_delivered or input_rejected; queued is not delivery.',
  };
}

export function eventsPage(job, after = 0, limit = 20) {
  after = Number(after);
  limit = Number(limit);
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 200
  )
    throw new Error('Use a nonnegative byte cursor and limit 1..200');

  const file = job.eventsFile;
  if (!file || !fs.existsSync(file)) return { id: job.id, events: [], cursor: 0, more: false };
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (after > size) throw new Error('Cursor exceeds event log size');
    if (after) {
      const b = Buffer.alloc(1);
      fs.readSync(fd, b, 0, 1, after - 1);
      if (b[0] !== 10) throw new Error('Cursor must be returned by events');
    }

    const events = [];
    let cursor = after,
      at = after,
      carry = Buffer.alloc(0);
    while (at < size && events.length < limit) {
      const buf = Buffer.alloc(Math.min(65536, size - at));
      const bytes = fs.readSync(fd, buf, 0, buf.length, at);
      if (!bytes) break;
      at += bytes;
      carry = Buffer.concat([carry, buf.subarray(0, bytes)]);

      let end;
      while (events.length < limit && (end = carry.indexOf(10)) !== -1) {
        events.push(JSON.parse(carry.subarray(0, end).toString('utf8')));
        cursor += end + 1;
        carry = carry.subarray(end + 1);
      }

      if (carry.length > 8 * 1024 * 1024 + 4096)
        throw new Error('Event record exceeds reader limit');
      if (cursor - after >= 512 * 1024) break;
    }

    // A killed writer can leave a partial record without its newline. It is not
    // an event, and paging past it would spin forever; only a complete record
    // after the cursor counts as more.
    let more = false;
    if (cursor < size) {
      if (carry.indexOf(10) !== -1) more = true;
      else {
        const probe = Buffer.alloc(65536);
        let pos = at;
        while (pos < size && !more) {
          const bytes = fs.readSync(fd, probe, 0, Math.min(probe.length, size - pos), pos);
          if (!bytes) break;
          pos += bytes;
          more = probe.subarray(0, bytes).indexOf(10) !== -1;
        }
      }
    }

    return { id: job.id, events, cursor, more };
  } finally {
    fs.closeSync(fd);
  }
}

function validateAnswer(request, answer) {
  if (request.method === 'approval/request') {
    if (!['allowed-once', 'rejected', 'cancelled'].includes(answer?.outcome))
      throw new Error('Approval answer requires outcome allowed-once|rejected|cancelled');
    return;
  }

  const ids = request.params.questions.map((q) => q.id);
  if (
    !Array.isArray(answer?.answers) ||
    answer.answers.length !== ids.length ||
    new Set(answer.answers.map((a) => a.id)).size !== ids.length ||
    !answer.answers.every(
      (a) =>
        ids.includes(a.id) &&
        Array.isArray(a.selected) &&
        a.selected.every((v) => typeof v === 'string') &&
        (a.custom === undefined || typeof a.custom === 'string'),
    )
  )
    throw new Error(
      'Answer each original question id exactly once with selected labels and optional custom text',
    );
}

// Reads replies independently while session/wait is pending. It never treats idle as completion.
export async function runSdk(
  child,
  { job, dir, prompt, save, emit, signal, images = [], notify = null },
) {
  const pending = new Map(),
    notifiedRequests = new Set();
  let finalText = '',
    finalReason = null,
    generation = 0,
    draining = Promise.resolve(),
    accepting = true,
    finished = false,
    peer;
  const failure = Promise.withResolvers();
  const record = (event) => appendEvent(dir, event);

  const updatePending = () => {
    job.pendingRequests = [...pending].map(([requestId, req]) => ({
      requestId,
      method: req.method,
      params: req.params,
    }));
    save();
  };

  // Only answered questions count; a user-approved answer lifts the cap for the rest of the job.
  const countQuestionAnswer = (request, input) => {
    if (request?.method !== 'user-question/ask') return;
    job.answeredQuestions = (job.answeredQuestions || 0) + 1;
    if (input?.userOk) job.questionCapLifted = true;
  };

  const notifyRequest = (requestId) => {
    if (!notify || notifiedRequests.has(requestId)) return;
    notifiedRequests.add(requestId);
    notify(requestId);
  };

  // A cancelled question is no longer answerable. A matching answer still in
  // the inbox is rejected by the next drain because its request is gone.
  const cancelRequest = (params) => {
    const requestId = params?.requestId;
    if (typeof requestId !== 'string' || !requestId) return;
    if (pending.delete(requestId)) updatePending();
    record({ event: 'request_cancelled', requestId });
  };

  peer = new SdkPeer(
    child,
    (message) => {
      if (message.id !== undefined) {
        if (!['user-question/ask', 'approval/request'].includes(message.method)) {
          peer.reject(message.id, 'Unsupported host request');
          return;
        }

        // Approval requests carry no request id on the wire; give each one a
        // stable bridge-side id so dsb answer --request works for both kinds.
        const supplied = message.params?.requestId;
        const requestId = typeof supplied === 'string' && supplied ? supplied : crypto.randomUUID();
        if (requestId !== supplied) message.params = { ...(message.params || {}), requestId };

        pending.set(requestId, message);
        updatePending();
        record({ event: 'request', requestId, method: message.method, params: message.params });
        emit({
          event: 'request',
          id: job.id,
          requestId,
          method: message.method,
          params: message.params,
        });
        notifyRequest(requestId);
      } else {
        record({ event: 'notification', method: message.method, params: message.params });

        if (message.method === 'user-question.cancelled') cancelRequest(message.params);
        else if (
          message.method === 'session.event' &&
          message.params.sessionId === job.sdkSessionId
        ) {
          const event = message.params.event;
          fs.appendFileSync(path.join(dir, 'root.session.jsonl'), JSON.stringify(event) + '\n', {
            mode: 0o600,
          });

          if (event.type === 'assistant/message') {
            const usage = event.data?.usage;
            if (usage) {
              const tokens =
                (usage.inputTokens || 0) +
                (usage.cacheReadTokens || 0) +
                (usage.cacheWriteTokens || 0);
              if (Number.isSafeInteger(tokens) && tokens >= 0) {
                const threshold = Number(job.contextLimit ?? DEFAULT_CONTEXT_LIMIT);
                job.context = { tokens, at: Date.now() };
                if (!job.contextReminder && tokens >= threshold) {
                  job.contextReminder = { tokens, threshold, at: Date.now() };
                  record({ event: 'context_reminder', tokens, threshold });
                }
                save();
              }
            }

            const text = (event.data?.message?.content || [])
              .filter((p) => p.type === 'text')
              .map((p) => p.text)
              .join('');
            if (text.trim()) finalText = text;
            if (Buffer.byteLength(finalText) > 1024 * 1024)
              throw new Error('Assistant report exceeds 1 MiB');
          }
          if (event.type === 'turn/start') finalReason = null;
          if (event.type === 'turn/end') {
            finalReason = event.data?.reason?.kind;
            record({ event: 'turn_finished', reason: finalReason });
          }
        }
      }
    },
    (error) => failure.reject(error),
  );

  const abort = () => peer.fail(signal.reason || new Error('Job cancelled'));
  signal?.addEventListener('abort', abort, { once: true });

  // AbortSignal does not replay an abort that happened before this listener.
  if (signal?.aborted) abort();

  // Attach the rejection handler before starting any RPC.
  const execute = async () => {
    const initialized = await peer.request(
      'initialize',
      {
        cwd: job.cwd,
        provider: job.provider,
        model: job.model,
        capabilities: { userQuestions: true },
        approvalRequests: true,
      },
      30000,
    );
    if (initialized?.serverInfo?.name !== 'deepseek-harness-sdk-runtime')
      throw new Error('Profile is not a dsh SDK runtime');

    const contentBlocks = [{ type: 'text', text: prompt }];
    if (images.length) {
      // Read at send time; the recorded hashes prove the files still match the job.
      const recorded = new Map((job.images || []).map((image) => [image.path, image.sha256]));

      for (const image of images) {
        let data;
        try {
          data = fs.readFileSync(image.path);
        } catch {
          throw new Error(`Image changed since launch: ${image.path}`);
        }

        if (crypto.createHash('sha256').update(data).digest('hex') !== recorded.get(image.path))
          throw new Error(`Image changed since launch: ${image.path}`);

        contentBlocks.push({
          type: 'image',
          data: data.toString('base64'),
          mimeType: image.mimeType,
        });
      }
    }
    await peer.request('session/prompt', { sessionId: job.sdkSessionId, contentBlocks }, 30000);

    const drain = () =>
      (draining = draining.then(async () => {
        if (finished) return 0;

        const inbox = path.join(dir, 'inbox');
        if (!fs.existsSync(inbox)) return 0;
        let delivered = 0;

        for (const name of fs
          .readdirSync(inbox)
          .filter((n) => /^\d+-[a-f0-9-]+\.json$/.test(n))
          .sort()) {
          const file = path.join(inbox, name);
          let input;
          try {
            input = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (!accepting) throw new Error('Job has finished accepting input');

            if (input.kind === 'message') {
              const receipt = await peer.request(
                'session/prompt',
                {
                  sessionId: job.sdkSessionId,
                  contentBlocks: [{ type: 'text', text: input.data.text }],
                },
                30000,
              );
              generation++;
              record({ event: 'input_delivered', inputId: input.id, receipt });
              delivered++;
            } else if (input.kind === 'answer') {
              const request = pending.get(input.data.requestId);
              if (!request) throw new Error('Request is no longer pending');

              validateAnswer(request, input.data.answer);
              peer.respond(request.id, input.data.answer);
              pending.delete(input.data.requestId);
              countQuestionAnswer(request, input.data);
              updatePending();
              record({
                event: 'input_delivered',
                inputId: input.id,
                requestId: input.data.requestId,
              });
              delivered++;
            } else throw new Error('Unknown input kind');
          } catch (error) {
            record({
              event: 'input_rejected',
              inputId: input?.id,
              error: error.message,
              ...(input?.kind === 'answer' && input.data?.requestId
                ? { requestId: input.data.requestId }
                : {}),
            });
          }

          fs.unlinkSync(file);
        }
        return delivered;
      }));

    const timer = setInterval(() => {
      void drain().catch((error) => failure.reject(error));
    }, 100);

    try {
      for (;;) {
        await drain();
        const waitingGeneration = generation;
        await peer.request('session/wait', { sessionId: job.sdkSessionId });
        await drain();
        if (generation !== waitingGeneration) continue;

        // Close admission before shutdown. Concurrent producers receive a terminal rejection or a durable rejected event.
        accepting = false;
        job.processState = 'finishing';
        save();
        await drain();
        break;
      }

      if (finalReason !== 'completed')
        throw new Error(`Session ended with ${finalReason || 'no committed completion'}`);
      fs.writeFileSync(job.reportFile, finalText, { mode: 0o600 });
      await peer.request('shutdown', undefined, 10000);
      child.stdin.end();
    } finally {
      clearInterval(timer);
    }
  };
  try {
    await Promise.race([execute(), failure.promise]);
  } finally {
    accepting = false;
    finished = true;
    signal?.removeEventListener('abort', abort);
    pending.clear();
    updatePending();
  }
}
