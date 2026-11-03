/**
 * Session discovery, incremental loading and render caching for the TUI.
 *
 * Discovery is deliberately two-track:
 *   - the first scan uses fs.promises (never blocks the loop);
 *   - a small tree is rescanned synchronously from the 1 s tick (a full walk
 *     is cheap there), while a large tree is rescanned asynchronously.
 * Summaries and rendered blocks are cached by file + mtime + size (and data
 * version); a file that did not change is never read or projected again.
 */
import fs from 'node:fs';

import {
  createEventReader,
  createAsyncEventReader,
  listSessionFiles,
  listSessionFilesAsync,
  sessionState,
  collectUsage,
} from '../sessions.mjs';
import { flattenBlocks, buildBlocks, eventStats, shortTitle } from './blocks.mjs';
import { safeText, styler } from './text.mjs';
import { bridgeHome, sessionInterrupted } from '../job-state.mjs';

const MAX_SESSIONS = 60;
const CACHE_BYTES = 64 * 1024 * 1024;
const SYNC_BYTES = 256 * 1024;
const MAX_EVENTS = 30_000;
const MAX_BYTES = 16 * 1024 * 1024;
const PRELOAD_COUNT = 8;
const BACKGROUND_LOADS = 4;
const RETRY_MS = 5000;
const RETRYABLE = new Set(['ENOENT', 'EPERM', 'EACCES', 'EBUSY']);

const INTERRUPT_CHECK_MS = 3000;

const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .map((part) => (part?.type === 'text' ? part.text : ''))
    .join('');

/**
 * The log alone says "active" or "quiet" while a turn is open. When the
 * session belongs to a bridge job that is no longer running, it was
 * interrupted (for example its launcher was killed) and will never continue.
 */
export function bridgeAwareState(state, sessionId, bridgeDir = bridgeHome()) {
  return (state === 'active' || state === 'quiet') && sessionInterrupted(sessionId, bridgeDir)
    ? 'interrupted'
    : state;
}

/** Derive the sidebar/header summary from one transcript. */
export function summarizeSession(
  meta,
  events,
  { complete = true, error = null, bridgeDir = bridgeHome() } = {},
) {
  let cwd = '',
    title = '',
    prompt = '',
    created = meta.mtime;
  const { tools, errors, openTurns: open, lastEnd } = eventStats(events);

  for (const event of events) {
    if (event.type === 'session') {
      if (typeof event.cwd === 'string') cwd = event.cwd;
      if (Number.isFinite(event.createdAt)) created = event.createdAt;
    } else if (event.type === 'session/title' && typeof event.data?.title === 'string')
      title = event.data.title;
    else if (event.type === 'user/message' && !prompt && event.data?.source?.kind === 'user')
      prompt = textOf(event.data.content);
  }

  const state = bridgeAwareState(sessionState(open, lastEnd, meta.mtime), meta.id, bridgeDir);
  const summary = {
    ...meta,
    cwd,
    title: shortTitle(title || prompt || ''),
    prompt: prompt ? shortTitle(prompt) : '',
    created,
    state,
    openTurns: open,
    lastEnd,
    tools,
    errors,
    usage: collectUsage(events),
    logComplete: complete,
    readError: error || null,
  };
  return summary;
}

const metaKey = (meta) => `${meta.mtime}:${meta.size}`;

export function createSessionStore({
  root,
  maxSessions = MAX_SESSIONS,
  cacheBytes = CACHE_BYTES,
  now = Date.now,
  onChange = () => {},
  bridgeDir = bridgeHome(),
  createReader = createEventReader,
  createAsyncReader = createAsyncEventReader,
} = {}) {
  const entries = new Map();

  // sessionView runs for every session on every frame; the bridge check reads
  // a job file and probes a PID, so its answer is reused for a few seconds.
  const interruptChecks = new Map();
  function interruptedNow(id, nowMs) {
    const cached = interruptChecks.get(id);
    if (cached && nowMs - cached.at < INTERRUPT_CHECK_MS) return cached.value;
    const value = sessionInterrupted(id, bridgeDir);
    interruptChecks.set(id, { at: nowMs, value });
    return value;
  }

  let files = [];
  let lastScanStart = -1e15;
  let largeTree = false;
  let asyncScanning = false;
  let selectedId = null;
  let backgroundQueue = [];
  let backgroundActive = 0;
  let disposed = false;
  let totalRetained = 0;
  let preloadMuted = false;

  // Entry cache
  function entryFor(meta) {
    let entry = entries.get(meta.file);

    if (!entry) {
      entry = {
        meta: { ...meta },
        reader: null,
        asyncReader: null,
        events: [],
        complete: false,
        error: null,
        version: 0,
        summary: null,
        reads: 0,
        retainedBytes: 0,
        loading: null,
        hydrated: false,
        retryable: false,
        failedAt: 0,
        blockCache: new Map(),
        flatCache: new Map(),
      };
      entries.set(meta.file, entry);
    }

    return entry;
  }

  // An entry is current when its events are in memory for the file's present
  // size/mtime. Evicted entries keep their summary for the list but must be
  // read again before their transcript can be shown.
  const current = (entry, meta) =>
    entry.summary && entry.hydrated && metaKey(entry.meta) === metaKey(meta);

  function dehydrate(entry) {
    entry.reader = null;
    entry.asyncReader = null;
    entry.events = [];
    entry.retainedBytes = 0;
    entry.hydrated = false;
    entry.blockCache.clear();
    entry.flatCache.clear();
  }

  function invalidate(entry) {
    entry.version++;
    entry.blockCache.clear();
    entry.flatCache.clear();
  }

  function applyResult(entry, meta, result) {
    entry.meta = { ...meta };
    entry.events = result.events;
    entry.complete = !!result.complete;
    entry.error = result.error || null;
    entry.reads++;
    entry.retainedBytes = result.retainedBytes ?? entry.retainedBytes;
    entry.hydrated = true;
    entry.retryable = false;
    entry.failedAt = 0;

    if (result.reset || result.added?.length) invalidate(entry);
    entry.summary = summarizeSession(meta, entry.events, {
      complete: entry.complete,
      error: entry.error,
      bridgeDir,
    });

    if (entry.error) {
      entry.summary.state = 'unreadable';
      entry.summary.readError = entry.error;
    }

    return entry;
  }

  function fail(entry, meta, error) {
    entry.reads++;
    entry.error = error?.message || String(error);
    entry.complete = false;
    entry.retryable = RETRYABLE.has(error?.code);
    entry.failedAt = now();

    // Retryable I/O failures are picked up again by a later tick; limit and
    // parse failures are terminal until the file itself changes.
    entry.hydrated = !entry.retryable;
    entry.summary = summarizeSession(meta, entry.events, {
      complete: false,
      error: entry.error,
      bridgeDir,
    });

    entry.summary.state = 'unreadable';
    entry.summary.readError = entry.error;
    invalidate(entry);

    return entry;
  }

  const retryDue = (entry, nowMs) =>
    entry?.retryable && !entry.loading && nowMs - entry.failedAt >= RETRY_MS;

  // Loading
  function loadSync(meta) {
    const entry = entryFor(meta);
    if (current(entry, meta)) return entry;
    entry.meta = { ...meta };
    try {
      entry.reader ??= createReader(meta.file, { maxBytes: MAX_BYTES, maxEvents: MAX_EVENTS });
      applyResult(entry, meta, entry.reader.read());
    } catch (error) {
      fail(entry, meta, error);
    }
    return entry;
  }

  async function loadAsyncReader(meta) {
    const entry = entryFor(meta);
    if (current(entry, meta)) return entry;
    if (entry.loading) return entry.loading;

    entry.loading = (async () => {
      entry.meta = { ...meta };
      try {
        entry.asyncReader ??= createAsyncReader(meta.file, {
          maxBytes: MAX_BYTES,
          maxEvents: MAX_EVENTS,
        });
        applyResult(entry, meta, await entry.asyncReader.read());
      } catch (error) {
        fail(entry, meta, error);
      } finally {
        entry.loading = null;
      }

      return entry;
    })();

    return entry.loading;
  }

  async function load(meta) {
    if (!meta) return null;
    return meta.size <= SYNC_BYTES ? loadSync(meta) : loadAsyncReader(meta);
  }

  // Discovery
  function applyFiles(nextFiles, { newSyncLimit = 2 } = {}) {
    const previous = new Map(files.map((meta) => [meta.file, meta]));
    const kept = [];
    const seen = new Set();

    for (const meta of [...nextFiles].sort((a, b) => b.mtime - a.mtime)) {
      if (kept.length >= maxSessions) break;
      if (seen.has(meta.file)) continue;
      seen.add(meta.file);
      kept.push(meta);
    }

    const sameFiles =
      kept.length === files.length &&
      kept.every(
        (meta, index) => meta.file === files[index].file && metaKey(meta) === metaKey(files[index]),
      );
    files = kept;
    let changed = !sameFiles;
    let syncBudget = newSyncLimit;
    const queued = new Set(backgroundQueue.map((meta) => meta.file));

    for (const meta of files) {
      const entry = entries.get(meta.file);
      const before = previous.get(meta.file);
      const metaChanged = !before || metaKey(before) !== metaKey(meta);
      if (!entry || !entry.summary) {
        if (meta.size <= SYNC_BYTES && syncBudget > 0) {
          syncBudget--;
          loadSync(meta);
          changed = true;
        } else if (!queued.has(meta.file)) {
          backgroundQueue.push(meta);
          queued.add(meta.file);
        }
      } else if (metaChanged) {
        if (meta.size <= SYNC_BYTES && syncBudget > 0) {
          syncBudget--;
          loadSync(meta);
          changed = true;
        } else if (!queued.has(meta.file)) {
          backgroundQueue.push(meta);
          queued.add(meta.file);
        }
      }
    }

    for (const file of [...entries.keys()]) {
      if (!seen.has(file)) {
        const entry = entries.get(file);
        totalRetained -= entry.retainedBytes || 0;
        entries.delete(file);
      }
    }

    evict();
    return changed;
  }

  function evict() {
    totalRetained = 0;
    for (const entry of entries.values()) totalRetained += entry.retainedBytes || 0;
    if (totalRetained <= cacheBytes) return;
    for (const entry of entries.values()) {
      if (totalRetained <= cacheBytes) break;
      if (!entry.hydrated || entry.loading || entry.summary?.id === selectedId) continue;
      totalRetained -= entry.retainedBytes || 0;
      dehydrate(entry);
    }
  }

  function sessionView(meta, nowMs) {
    const entry = entries.get(meta.file);
    if (!entry?.summary) {
      return {
        ...meta,
        title: '',
        prompt: '',
        cwd: '',
        created: meta.mtime,
        state: 'loading',
        tools: 0,
        errors: 0,
        usage: null,
        openTurns: 0,
        lastEnd: null,
        logComplete: false,
        readError: null,
        loading: true,
      };
    }

    const summary = entry.summary;
    let state = summary.readError
      ? 'unreadable'
      : sessionState(summary.openTurns, summary.lastEnd, meta.mtime, nowMs);

    if ((state === 'active' || state === 'quiet') && interruptedNow(meta.id, nowMs))
      state = 'interrupted';

    return { ...summary, ...meta, state, loading: false };
  }

  function sessions(nowMs = now()) {
    return files
      .map((meta) => sessionView(meta, nowMs))
      .filter((session) => session.state !== 'empty');
  }

  function findMeta(idOrFile) {
    if (!idOrFile) return null;
    return files.find((meta) => meta.file === idOrFile || meta.id === idOrFile) || null;
  }

  function select(id) {
    selectedId = id || null;
  }

  /** True when the file's transcript is not in memory and no read is under way. */
  function needsLoad(file) {
    const meta = findMeta(file);
    const entry = meta && entries.get(meta.file);
    if (!meta || entry?.loading || (entry && current(entry, meta))) return false;
    return !entry?.retryable || retryDue(entry, now());
  }

  // Rendering
  function getRender(
    session,
    {
      view = 'reading',
      columns = 100,
      reasoning = false,
      system = false,
      allExpanded = false,
      expanded = new Set(),
      st = styler(true),
    } = {},
  ) {
    const entry = entries.get(session.file);
    if (!entry?.summary || !entry.events.length) return null;

    const blockKey = `${entry.version}|${columns}|${view}|${reasoning ? 1 : 0}|${system ? 1 : 0}|${st.enabled ? 'c' : 'p'}`;
    let blocks = entry.blockCache.get(blockKey);
    if (!blocks) {
      blocks = buildBlocks(entry.events, {
        view,
        columns,
        reasoning,
        system,
        interactive: true,
        st,
      });
      entry.blockCache.set(blockKey, blocks);
      if (entry.blockCache.size > 6) entry.blockCache.delete(entry.blockCache.keys().next().value);
    }

    const flatKey = `${blockKey}|${allExpanded ? 1 : 0}|${[...expanded].sort().join(',')}`;
    let flat = entry.flatCache.get(flatKey);
    if (!flat) {
      flat = flattenBlocks(blocks, { expanded, allExpanded });
      entry.flatCache.set(flatKey, flat);
      if (entry.flatCache.size > 24) entry.flatCache.delete(entry.flatCache.keys().next().value);
    }

    return { ...flat, blocks, version: entry.version };
  }

  function queueBackground(metas) {
    const queued = new Set(backgroundQueue.map((meta) => meta.file));
    for (const meta of metas) {
      if (summarized(meta) || queued.has(meta.file)) continue;
      backgroundQueue.push(meta);
      queued.add(meta.file);
    }
    pump();
  }

  // The list only needs a summary that matches the file's current size/mtime.
  function summarized(meta) {
    const entry = entries.get(meta.file);
    return !!entry?.summary && metaKey(entry.meta) === metaKey(meta);
  }

  // Up to BACKGROUND_LOADS sessions load at once: large logs decode on the
  // libuv thread pool, so a few in flight fill titles much faster without
  // adding synchronous work to the event loop.
  function pump() {
    while (
      !disposed &&
      !preloadMuted &&
      backgroundActive < BACKGROUND_LOADS &&
      backgroundQueue.length
    ) {
      const meta = backgroundQueue.shift();
      if (summarized(meta)) continue;
      backgroundActive++;

      setImmediate(async () => {
        try {
          if (!disposed) await load(meta);
        } finally {
          backgroundActive--;
          if (!disposed) {
            evict();
            onChange();
            pump();
          }
        }
      });
    }
  }

  async function init() {
    let discovered = [];
    try {
      discovered = await listSessionFilesAsync(root);
    } catch {
      discovered = [];
    }

    largeTree = discovered.length > maxSessions;
    applyFiles(discovered, { newSyncLimit: 0 });

    const preferred =
      sessions().find((session) => session.state === 'active') || sessions()[0] || null;
    if (preferred) {
      selectedId = preferred.id;
      const meta = findMeta(preferred.file);
      if (meta) {
        const deadline = new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
        await Promise.race([load(meta), deadline]);
      }
    }

    // Fill the first screen's title column only when that is cheap (fixtures
    // and small trees). Large real histories stay as metadata placeholders and
    // are filled by the background pump after the first frame.
    const preload = sessions()
      .slice(0, PRELOAD_COUNT)
      .map((session) => findMeta(session.file))
      .filter(Boolean);
    const preloadBytes = preload.reduce((sum, meta) => sum + (meta.size || 0), 0);
    if (preload.length && preloadBytes <= 1_500_000)
      await Promise.all(preload.map((meta) => load(meta)));

    queueBackground(files);
    return { sessions: sessions(), selectedId };
  }

  function tickSync(nowMs = now()) {
    let changed = false;

    // The selected transcript is the one the user is reading: one cheap stat
    // per second keeps it live without touching the rest of the tree.
    const selectedMeta = selectedId && files.find((meta) => meta.id === selectedId);

    if (selectedMeta) {
      try {
        const stat = fs.statSync(selectedMeta.file);
        if (stat.mtimeMs !== selectedMeta.mtime || stat.size !== selectedMeta.size) {
          const next = { ...selectedMeta, mtime: stat.mtimeMs, size: stat.size };
          const index = files.findIndex((meta) => meta.file === selectedMeta.file);
          if (index >= 0) files[index] = next;
          if (next.size <= SYNC_BYTES) {
            loadSync(next);
            changed = true;
          } else void loadAsyncReader(next).then(() => onChange());
        }
      } catch {}
    }

    const retries = [];
    for (const meta of files) {
      const entry = entries.get(meta.file);
      if (!retryDue(entry, nowMs)) continue;
      if (meta.size <= SYNC_BYTES) {
        loadSync(meta);
        changed = true;
      } else retries.push(meta);
    }
    if (retries.length) queueBackground(retries);

    if (largeTree) {
      // Large real histories are rescanned asynchronously and throttled: the
      // event loop never performs a full directory walk in one turn.
      if (!asyncScanning && nowMs - lastScanStart >= 3000) {
        lastScanStart = nowMs;
        asyncScanning = true;
        listSessionFilesAsync(root)
          .then((next) => {
            if (disposed) return;
            applyFiles(next, { newSyncLimit: 2 });
            onChange();
          })
          .catch(() => {})
          .finally(() => {
            asyncScanning = false;
          });
      }
    } else {
      // A small tree is cheap to walk in one turn, and its discovery needs no
      // third implementation: listSessionFiles shares the canonical rules.
      if (nowMs - lastScanStart >= 2000) {
        lastScanStart = nowMs;
        changed = applyFiles(listSessionFiles(root)) || changed;
      }
    }

    pump();
    return changed;
  }

  function dispose() {
    disposed = true;
    backgroundQueue = [];
  }

  return {
    init,
    load,
    tickSync,
    sessions,
    findMeta,
    select,
    needsLoad,
    getRender,
    dispose,
    evict,

    get selectedId() {
      return selectedId;
    },

    get files() {
      return files;
    },

    stats(file) {
      const entry = entries.get(file);
      return entry
        ? {
            reads: entry.reads,
            version: entry.version,
            events: entry.events.length,
            retainedBytes: entry.retainedBytes,
            complete: entry.complete,
            error: entry.error,
            loaded: !!entry.summary,
          }
        : null;
    },
  };
}
