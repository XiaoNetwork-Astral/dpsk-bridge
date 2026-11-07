/**
 * Interactive viewer state machine. Keys and mouse events only mutate state;
 * one synchronous draw per input chunk keeps held-down navigation responsive,
 * while asynchronous updates are coalesced through scheduleDraw().
 */
import { checkForUpdate, applyUpdate, readUpdateSettings } from '../updater.mjs';
import { listSessionFiles } from '../sessions.mjs';
import { createSessionStore } from './store.mjs';
import {
  LINGER_MS,
  geometry,
  helpView,
  listItems,
  renderFrame,
  sessionGroups,
  statusInfo,
} from './layout.mjs';
import { createScreen } from './screen.mjs';
import { blockKeyAt, anchoredScroll, moveBlockKey } from './blocks.mjs';
import { safeText, styler } from './text.mjs';

const ESCAPE_RE =
  /\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[[0-9;]*[~A-Za-z]|\x1bO[A-Za-z]|\x1b|[\s\S]/gu;
const ESCAPE_FLUSH_MS = 50;

/** Trailing bytes that may still become one escape sequence in the next chunk. */
function incompleteEscape(text) {
  const at = text.lastIndexOf('\x1b');
  if (at < 0) return '';
  const tail = text.slice(at);
  return tail === '\x1b' ||
    tail === '\x1bO' ||
    /^\x1b\[<[0-9;]*$/u.test(tail) ||
    /^\x1b\[[0-9;]*$/u.test(tail)
    ? tail
    : '';
}

function tokenize(text) {
  const tokens = [];
  ESCAPE_RE.lastIndex = 0;
  let match;

  while ((match = ESCAPE_RE.exec(text))) {
    if (match[1] !== undefined) {
      tokens.push({
        type: 'mouse',
        button: Number(match[1]),
        x: Number(match[2]),
        y: Number(match[3]),
        press: match[4] === 'M',
      });
      continue;
    }

    const value = match[0];
    const table = {
      '\x1b[A': 'up',
      '\x1b[B': 'down',
      '\x1b[C': 'right',
      '\x1b[D': 'left',
      '\x1bOA': 'up',
      '\x1bOB': 'down',
      '\x1bOC': 'right',
      '\x1bOD': 'left',
      '\x1b[H': 'home',
      '\x1b[F': 'end',
      '\x1b[1~': 'home',
      '\x1b[4~': 'end',
      '\x1b[5~': 'pageup',
      '\x1b[6~': 'pagedown',
      '\x1b[3~': 'delete',
      '\r': 'enter',
      '\n': 'enter',
      '\t': 'tab',
      ' ': 'space',
      '\x1b': 'escape',
      '\x03': 'ctrl-c',
      '\x0c': 'ctrl-l',
      '\x04': 'ctrl-d',
      '\x15': 'ctrl-u',
      '\x7f': 'backspace',
      '\x1b[Z': 'shift-tab',
    };

    tokens.push({ type: 'key', key: table[value] || value, raw: value });
  }

  return tokens;
}

const defaultInput = { pending: '' };

export function parseInput(text, state = defaultInput) {
  const source = state.pending + String(text);
  state.pending = incompleteEscape(source);
  return tokenize(state.pending ? source.slice(0, -state.pending.length) : source);
}

/** Emit a lone Escape held back for a possible continuation. */
export function flushInput(state = defaultInput) {
  const value = state.pending;
  state.pending = '';
  return value ? tokenize(value) : [];
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const lastKey = (starts) => [...starts.keys()].at(-1) || null;
const firstKey = (starts) => starts.keys().next().value || null;

// `free` means the user scrolled the view (wheel/page) away from the cursor:
// the highlighted block stays where it is instead of snapping into view.
function defaultDetail() {
  return { scroll: 0, cursorKey: null, expanded: new Set(), follow: false, free: false };
}

/**
 * Next owner filter for `o`: toggle on the selected session's owner. Pure, and
 * null for a session without an owner, so the key never changes the selection.
 */
export function toggleOwnerFilter(current, selected) {
  const ownerId = selected?.owner?.id;
  if (!ownerId) return current;
  return current === ownerId ? null : ownerId;
}

/** Keys of the blocks that have at least one line inside the viewport. */
const visibleKeys = (keys, scroll, height) =>
  new Set(keys.slice(scroll, scroll + height).filter(Boolean));

/**
 * Toggle set that opens every group containing the session, so a selected
 * session is never hidden inside a collapsed day group.
 */
function revealSession(toggled, sessions, id, now, held) {
  const groups = sessionGroups(sessions, now, { held });
  for (const group of groups) {
    for (const child of group.children) {
      if (!child.sessions.some((session) => session.id === id)) continue;
      for (const key of [group.key, child.key]) toggled.set(key, false);
    }
  }
  return toggled;
}

/** Render a single frame without entering the alternate screen. */
export async function runSnapshot({
  root,
  columns = 120,
  rows = 30,
  focus = 'list',
  select = null,
  details = false,
  version = '',
  now = Date.now(),
  out = process.stdout,
  createStore = createSessionStore,
}) {
  const store = createStore({ root, now: () => now });
  try {
    await store.init();
    store.dispose();

    let selected = null;
    if (select) {
      const prefix = String(select).replace(/^session-/, '');
      const hits = listSessionFiles(root).filter((meta) => meta.id.startsWith(prefix));
      if (hits.length !== 1) {
        console.error(
          hits.length
            ? `Prefix ${select} matches several sessions; use a longer one`
            : `No session matches ${select}`,
        );
        return 1;
      }

      const entry = await store.load(hits[0]);
      selected = entry?.summary
        ? store.sessions(now).find((session) => session.id === hits[0].id) || {
            ...entry.summary,
            ...hits[0],
            state: entry.summary.state,
          }
        : null;
    } else {
      selected =
        store.sessions(now).find((session) => session.id === store.selectedId) ||
        store.sessions(now)[0] ||
        null;
      if (selected) {
        const meta = store.findMeta(selected.file);
        if (meta) {
          await store.load(meta);
          selected = store.sessions(now).find((session) => session.id === selected.id) || selected;
        }
      }
    }

    // One frame only paints the first screenful of list titles; the remaining
    // sessions stay as "Loading…" placeholders instead of being decoded.
    const visible = store.sessions(now).slice(0, Math.ceil(rows / 2));

    await Promise.all(
      visible.map((session) => {
        const meta = store.findMeta(session.file);
        return meta ? store.load(meta) : null;
      }),
    );

    const sessions = store.sessions(now);
    const toggledGroups = selected
      ? revealSession(new Map(), sessions, selected.id, now, new Set())
      : new Map();

    const geo = geometry(columns);
    const detailState = defaultDetail();

    const render = selected
      ? store.getRender(selected, {
          view: details ? 'process' : 'reading',
          columns: geo.detailWidth,
          st: styler(false),
          expanded: detailState.expanded,
          allExpanded: false,
        })
      : null;
    if (render) detailState.cursorKey = firstKey(render.starts);

    const frame = renderFrame({
      columns,
      rows,
      view: details ? 'process' : 'reading',
      focus,
      sessions,
      selectedId: selected?.id ?? null,
      selected,
      toggledGroups,
      listCursor: selected ? `session:${selected.id}` : null,
      detail: render
        ? {
            lines: render.lines,
            keys: render.keys,
            starts: render.starts,
            scroll: 0,
            cursorKey: detailState.cursorKey,
          }
        : null,
      now,
      version,
      st: styler(false),
    });

    out.write(frame.lines.join('\n') + '\n');
    return 0;
  } finally {
    store.dispose();
  }
}

/** Full-screen interactive TUI. */
export async function runTui({ root, version = '', noUpdateCheck = false, initial = {} }) {
  const out = process.stdout,
    inp = process.stdin;
  const st = styler(true);
  const screen = createScreen({ out });
  const state = {
    focus: 'list',
    view: initial.view || 'reading',
    selectedId: null,
    listCursor: null,

    // View-only list filter: the owner id whose sessions are shown, or null.
    ownerFilter: null,

    // Group keys mapped to explicit open/closed state; absent keys keep the default.
    toggledGroups: new Map(),

    // Sessions kept in the running group past their natural time: Infinity
    // while selected, then until a fresh LINGER_MS after the user moves away.
    hold: new Map(),
    reasoning: !!initial.reasoning,
    system: !!initial.system,
    allExpanded: !!initial.allExpanded,
    autoFollow: false,
    bell: false,
    info: !!initial.info,
    help: false,
    detail: defaultDetail(),
    sessionStates: new Map(),
    flash: null,
    update: { info: null, message: '', task: null },
    prevStates: new Map(),
    listTop: 0,
    helpScroll: 0,
  };
  let store = null,
    lastHits = null,
    quitting = false,
    drawScheduled = false,
    updateApplied = false;
  let timers = [];

  const columnsOf = () => out.columns || 100;
  const rowsOf = () => Math.max(6, out.rows || 30);
  const detailHeight = () => Math.max(1, rowsOf() - 4);
  const scheduleDraw = () => {
    if (quitting || drawScheduled) return;
    drawScheduled = true;
    setImmediate(() => {
      drawScheduled = false;
      draw();
    });
  };

  store = createSessionStore({ root, onChange: scheduleDraw });

  // ── sessions ─────────────────────────────────────────────────────────────
  function currentSession() {
    const sessions = store.sessions(Date.now());
    let selected = sessions.find((session) => session.id === state.selectedId) || null;

    if (!selected && sessions.length) {
      state.selectedId = sessions[0].id;
      store.select(state.selectedId);
      state.detail = state.sessionStates.get(state.selectedId) || defaultDetail();
      state.sessionStates.set(state.selectedId, state.detail);
      selected = sessions[0];
    }
    if (selected && !state.sessionStates.has(selected.id)) {
      state.sessionStates.set(selected.id, state.detail);
    }

    return { sessions, selected };
  }

  function renderFor(selected) {
    if (!selected) return null;

    const geo = geometry(columnsOf());
    return store.getRender(selected, {
      view: state.view,
      columns: geo.detailWidth,
      reasoning: state.reasoning,
      system: state.system,
      allExpanded: state.allExpanded,
      expanded: state.detail.expanded,
      st,
    });
  }

  /** Ids held in the running group at `now`; expired holds are dropped. */
  function heldIds(now) {
    const ids = new Set();
    for (const [id, until] of state.hold) {
      if (until > now) ids.add(id);
      else state.hold.delete(id);
    }
    return ids;
  }

  // While a session in the running group is being viewed it stays there; once
  // the user moves to another session the linger delay starts again.
  function updateHold(sessions, now) {
    const selected = sessions.find((session) => session.id === state.selectedId);
    if (!selected) return;
    const groups = sessionGroups(sessions, now, { held: heldIds(now) });
    if (groups[0].sessions.some((session) => session.id === selected.id))
      state.hold.set(selected.id, Infinity);
  }

  function select(id) {
    if (!id) return;

    if (state.selectedId === id) {
      state.detail = state.sessionStates.get(id) || state.detail;
      return;
    }

    if (state.hold.get(state.selectedId) === Infinity)
      state.hold.set(state.selectedId, Date.now() + LINGER_MS);
    if (state.selectedId) state.sessionStates.set(state.selectedId, state.detail);
    state.selectedId = id;
    state.detail = state.sessionStates.get(id) || defaultDetail();
    state.sessionStates.set(id, state.detail);
    state.listCursor = `session:${id}`;

    ensureLoaded(id);
  }

  // The store protects only its selected session from cache eviction and stats
  // only that one each tick, so it must always know what is on screen.
  function ensureLoaded(id) {
    store.select(id);
    const meta = store.findMeta(id);
    if (meta)
      void store
        .load(meta)
        .then(() => scheduleDraw())
        .catch(() => {});
  }

  function detectEnds(sessions, now) {
    for (const session of sessions) {
      const before = state.prevStates.get(session.id);

      if (
        before &&
        ['active', 'quiet'].includes(before) &&
        !['active', 'quiet', 'empty', 'loading'].includes(session.state)
      ) {
        const info = statusInfo(session.state);
        const project = safeText(
          session.cwd ? session.cwd.split(/[\\/]/).filter(Boolean).at(-1) : '?',
        );
        state.flash = {
          until: now + 8000,
          text: `${info.icon} ${safeText(session.id.slice(0, 8))} ${project} ${session.state === 'done' ? 'ended' : info.label.toLowerCase()}`,
        };

        if (state.bell) {
          try {
            out.write('\x07');
          } catch {}
        }
      }

      state.prevStates.set(session.id, session.state);
    }
  }

  // ── detail ───────────────────────────────────────────────────────────────
  function buildDetail(columns, now) {
    const { sessions, selected } = currentSession();
    const render = renderFor(selected);
    const height = detailHeight();

    if (!render) {
      if (selected && store.needsLoad(selected.file)) ensureLoaded(selected.id);
      return { sessions, selected, render: null, detail: null };
    }

    let cursorKey = state.detail.cursorKey;
    if (!cursorKey || !render.starts.has(cursorKey)) cursorKey = firstKey(render.starts);
    const maxScroll = Math.max(0, render.lines.length - height);

    if (state.detail.follow) {
      state.detail.scroll = maxScroll;
      cursorKey = lastKey(render.starts) || cursorKey;
    } else {
      state.detail.scroll = clamp(state.detail.scroll, 0, maxScroll);
      const line = cursorKey ? render.starts.get(cursorKey) : undefined;
      if (line !== undefined && !state.detail.free) {
        if (line < state.detail.scroll) state.detail.scroll = line;
        else if (line >= state.detail.scroll + height) state.detail.scroll = line - height + 1;
      }
    }

    state.detail.cursorKey = cursorKey;
    return {
      sessions,
      selected,
      render,
      detail: {
        lines: render.lines,
        keys: render.keys,
        starts: render.starts,
        scroll: state.detail.scroll,
        cursorKey: state.detail.cursorKey,
        follow: state.detail.follow,
      },
    };
  }

  let drawnSize = '';

  function draw() {
    if (quitting) return;
    const columns = columnsOf(),
      rows = rowsOf(),
      now = Date.now();

    // Any size change invalidates the whole screen: terminals may reflow or
    // keep stale cells that the line diff cannot know about.
    if (drawnSize !== `${columns}x${rows}`) {
      drawnSize = `${columns}x${rows}`;
      screen.clear();
    }

    const built = buildDetail(columns, now);
    updateHold(built.sessions, now);
    detectEnds(built.sessions, now);
    if (state.flash && now >= state.flash.until) state.flash = null;

    const frame = renderFrame({
      columns,
      rows,
      view: state.view,
      focus: state.focus,
      sessions: built.sessions,
      selectedId: built.selected?.id ?? null,
      selected: built.selected,
      toggledGroups: state.toggledGroups,
      held: heldIds(now),
      listCursor: state.listCursor,
      ownerFilter: state.ownerFilter,
      detail: built.detail,
      help: state.help,
      helpScroll: state.helpScroll,
      info: state.info,
      flash: state.flash,
      update: { info: state.update.info, message: state.update.message, task: state.update.task },
      now,
      version,
      st,
      autoFollow: state.autoFollow,
      reasoning: state.reasoning,
      allExpanded: state.allExpanded,
      system: state.system,
      bell: state.bell,
      listTop: state.listTop,
    });

    state.listTop = frame.listTop;
    lastHits = frame.hits;
    screen.draw(frame.lines);
  }

  function visibleItems() {
    const { sessions } = currentSession();
    const now = Date.now();
    return listItems({
      sessions,
      toggledGroups: state.toggledGroups,
      held: heldIds(now),
      selectedId: state.selectedId,
      listCursor: state.listCursor,
      ownerFilter: state.ownerFilter,
      now,
    });
  }

  function moveList(delta) {
    const { items } = visibleItems();
    if (!items.length) return;
    let index = items.findIndex((item) => item.key === state.listCursor);
    if (index < 0)
      index = items.findIndex(
        (item) => item.type === 'session' && item.session.id === state.selectedId,
      );
    if (index < 0) index = 0;

    const next = items[clamp(index + delta, 0, items.length - 1)];
    if (!next) return;

    state.autoFollow = false;
    state.listCursor = next.key;
    if (next.type === 'session' && next.session.id !== state.selectedId) select(next.session.id);
  }

  function toggleGroup(item, mode = 'toggle') {
    if (!item?.group) return;
    const key = item.group.key;

    // A session row's group is visible, so it is open.
    const collapsed = item.type === 'group' ? item.collapsed : false;
    const flip =
      mode === 'toggle' || (mode === 'open' && collapsed) || (mode === 'collapse' && !collapsed);
    if (flip) state.toggledGroups.set(key, !collapsed);
    state.listCursor = `group:${key}`;
    state.autoFollow = false;
  }

  function cursorItem() {
    const { items } = visibleItems();
    return (
      items.find((item) => item.key === state.listCursor) ||
      items.find((item) => item.type === 'session' && item.session.id === state.selectedId) ||
      null
    );
  }

  function activateItem() {
    const item = cursorItem();
    if (!item) return;
    if (item.type === 'group') {
      toggleGroup(item, 'toggle');
      return;
    }
    openSession(item.session.id);
  }

  function setView(next) {
    if (state.view === next) return;
    state.view = next;
    state.detail.scroll = 0;
    state.detail.cursorKey = null;
    state.detail.follow = false;
  }

  function changeExpansion(mutate) {
    const selected = currentSession().selected;
    const render = renderFor(selected);
    if (!render) return;
    const key = state.detail.cursorKey || firstKey(render.starts);
    const oldStart = render.starts.get(key) ?? 0;
    const oldScroll = state.detail.scroll;

    mutate();
    const next = renderFor(selected);
    if (!next) return;
    const newStart = next.starts.get(key) ?? 0;
    const max = Math.max(0, next.lines.length - detailHeight());
    state.detail.scroll = anchoredScroll(oldStart, oldScroll, newStart, max);

    if (!next.starts.has(key)) state.detail.cursorKey = firstKey(next.starts);
  }

  function toggleCurrent({ explain = false } = {}) {
    const selected = currentSession().selected;
    const render = renderFor(selected);
    if (!render) return;

    if (state.detail.free) {
      // Scrolled away from the highlight: act on what is actually on screen.
      const shown = visibleKeys(render.keys, state.detail.scroll, detailHeight());
      if (!shown.has(state.detail.cursorKey) && shown.size) state.detail.cursorKey = [...shown][0];
    }

    const key = state.detail.cursorKey;
    const block = render.blocks.find((item) => item.key === key);

    if (!block?.expandable) {
      if (explain && block) flash('Nothing more to expand in this block');
      return;
    }

    changeExpansion(() => {
      if (state.allExpanded) {
        // Leave the global override but keep the other blocks open, so this
        // click means "collapse just this one".
        state.allExpanded = false;
        for (const item of render.blocks)
          if (item.expandable && item.key !== key) state.detail.expanded.add(item.key);
        state.detail.expanded.delete(key);
      } else if (state.detail.expanded.has(key)) state.detail.expanded.delete(key);
      else state.detail.expanded.add(key);
    });

    state.detail.follow = false;
  }

  function expandAll() {
    const selected = currentSession().selected;
    const render = renderFor(selected);
    if (!render) return;
    changeExpansion(() => {
      for (const block of render.blocks) if (block.expandable) state.detail.expanded.add(block.key);
    });
    state.detail.follow = false;
  }

  function collapseAll() {
    const selected = currentSession().selected;
    const render = renderFor(selected);
    if (!render) return;
    changeExpansion(() => {
      state.detail.expanded.clear();
      state.allExpanded = false;
    });
    state.detail.follow = false;
  }

  function toggleAllExpanded() {
    changeExpansion(() => {
      state.allExpanded = !state.allExpanded;
    });
  }

  function moveCursor(delta) {
    const render = renderFor(currentSession().selected);
    if (!render) return;
    const height = detailHeight();
    const shown = visibleKeys(render.keys, state.detail.scroll, height);

    if (state.detail.free && !shown.has(state.detail.cursorKey) && shown.size) {
      // After scrolling away, the first key press picks up from what is on
      // screen instead of jumping back to the old cursor position.
      const ordered = [...shown];
      state.detail.cursorKey = delta > 0 ? ordered[0] : ordered.at(-1);
    } else {
      const next = moveBlockKey(render.starts, state.detail.cursorKey, delta);
      if (next) state.detail.cursorKey = next;
    }

    state.detail.free = false;

    // Moving down onto the newest block resumes following, like G.
    state.detail.follow = delta > 0 && state.detail.cursorKey === lastKey(render.starts);
  }

  function goTop() {
    const render = renderFor(currentSession().selected);
    if (!render) return;
    state.detail.scroll = 0;
    state.detail.cursorKey = firstKey(render.starts);
    state.detail.follow = false;
    state.detail.free = false;
  }

  function goBottom() {
    state.detail.follow = true;
    state.detail.free = false;
  }

  /**
   * Scroll the view without touching the highlighted block (wheel). Keyboard
   * paging passes `moveCursor` so the highlight lands on the new page when it
   * would otherwise be left off screen.
   */
  function scrollDetailBy(delta, { moveCursor = false } = {}) {
    const render = renderFor(currentSession().selected);
    if (!render) return;

    const height = detailHeight();
    const max = Math.max(0, render.lines.length - height);
    state.detail.scroll = clamp(state.detail.scroll + delta, 0, max);
    const onScreen = visibleKeys(render.keys, state.detail.scroll, height).has(
      state.detail.cursorKey,
    );

    if (moveCursor && !onScreen) {
      state.detail.cursorKey =
        blockKeyAt(render.keys, state.detail.scroll) || state.detail.cursorKey;
      state.detail.free = false;
    } else state.detail.free = true;

    // Scrolling down to the bottom resumes following new output; any upward
    // scroll, or stopping short of the bottom, leaves it.
    state.detail.follow = delta > 0 && state.detail.scroll >= max;

    if (state.detail.follow) state.detail.free = false;
  }

  // ── update flow ──────────────────────────────────────────────────────────
  async function installUpdate() {
    if (state.update.task || updateApplied) return;
    state.update.task = (async () => {
      try {
        const info = await checkForUpdate({ force: true });
        state.update.info = info;

        if (!info.available) {
          state.update.message = info.error
            ? `Update check failed: ${info.error}`
            : 'Already on the latest release';
          scheduleDraw();
          return;
        }

        const applied = await applyUpdate(info, {
          onProgress: (message) => {
            state.update.message = message;
            scheduleDraw();
          },
        });

        updateApplied = true;
        state.update.message = `Updated to ${applied.version}; restart dsv to use it`;
        scheduleDraw();
      } catch (error) {
        state.update.message = `Update paused: ${error.message}`;
        scheduleDraw();
      } finally {
        state.update.task = null;
        scheduleDraw();
      }
    })();

    return state.update.task;
  }

  async function refreshUpdate() {
    if (noUpdateCheck || updateApplied || process.env.CI || process.env.NO_UPDATE_NOTIFIER) return;
    try {
      const info = await checkForUpdate();
      state.update.info = info;
      scheduleDraw();

      if (info.available && !info.error && readUpdateSettings().autoUpdate) void installUpdate();
    } catch (error) {
      state.update.message = `Update check failed: ${error.message}`;
      scheduleDraw();
    }
  }

  // ── keys ─────────────────────────────────────────────────────────────────
  const flash = (text, ms = 3000) => {
    state.flash = { until: Date.now() + ms, text };
  };

  function scrollHelp(delta) {
    const lines = helpView(geometry(columnsOf()).detailWidth);
    const max = Math.max(0, lines.length - detailHeight());
    state.helpScroll = clamp(state.helpScroll + delta, 0, max);
  }

  /** z / Z: fold or unfold every group, keeping the selected session's group in reach. */
  function setAllGroups(collapsed) {
    const now = Date.now();
    const groups = sessionGroups(store.sessions(now), now, { held: heldIds(now) });

    state.toggledGroups.clear();
    for (const group of groups) {
      for (const key of [group.key, ...group.children.map((child) => child.key)])
        state.toggledGroups.set(key, collapsed);
    }

    const home =
      groups.find((group) => group.sessions.some((session) => session.id === state.selectedId)) ||
      groups[0];
    state.listCursor = collapsed
      ? `group:${home.key}`
      : state.selectedId
        ? `session:${state.selectedId}`
        : state.listCursor;

    state.autoFollow = false;
  }

  /** n: select the next session of the running group, cycling. */
  function nextRunning() {
    const now = Date.now();
    const running = sessionGroups(store.sessions(now), now, {
      held: heldIds(now),
    })[0].children.flatMap((child) => child.sessions);

    if (!running.length) {
      flash('No running sessions');
      return;
    }

    const index = running.findIndex((session) => session.id === state.selectedId);
    const next = running[(index + 1) % running.length];

    state.autoFollow = false;
    select(next.id);
    revealSession(state.toggledGroups, store.sessions(now), next.id, now, heldIds(now));
  }

  /** Explicit choice of a session (Enter, →, click): stops auto-follow, like j/k. */
  function openSession(id, { enter = true } = {}) {
    state.autoFollow = false;
    select(id);
    if (enter) state.focus = 'detail';
  }

  function handleKey(key) {
    if (key === 'q' || key === 'ctrl-c') return quit();
    if (key === 'ctrl-l') {
      drawnSize = '';
      return;
    } // the draw after input repaints everything
    if (key === 'u') {
      void installUpdate();
      return;
    }
    if (key === '?') {
      state.help = !state.help;
      state.helpScroll = 0;
      return;
    }

    if (state.help) {
      // Help is modal: only scrolling and closing work while it is open.
      if (key === 'escape') state.help = false;
      else if (key === 'up' || key === 'k') scrollHelp(-1);
      else if (key === 'down' || key === 'j') scrollHelp(1);
      else if (key === 'pageup' || key === 'ctrl-u') scrollHelp(-detailHeight());
      else if (key === 'pagedown' || key === 'ctrl-d') scrollHelp(detailHeight());
      return;
    }
    if (key === 'escape') {
      if (state.focus === 'detail') state.focus = 'list';
      return;
    }
    if (key === 'tab' || key === 'shift-tab') {
      state.focus = state.focus === 'list' ? 'detail' : 'list';
      return;
    }
    if (key === 'i') {
      state.info = !state.info;
      if (state.info) state.detail.scroll = 0;
      return;
    }
    if (key === 'o') {
      const selected = store
        .sessions(Date.now())
        .find((session) => session.id === state.selectedId);
      state.ownerFilter = toggleOwnerFilter(state.ownerFilter, selected);
      return;
    }
    if (key === 'd') {
      setView(state.view === 'reading' ? 'process' : 'reading');
      return;
    }
    if (key === 'r') {
      state.reasoning = !state.reasoning;
      return;
    }
    if (key === 'f') {
      toggleAllExpanded();
      return;
    }
    if (key === 's') {
      state.system = !state.system;
      if (state.system) setView('process');
      return;
    }
    if (key === 'z') {
      setAllGroups(true);
      return;
    }
    if (key === 'Z') {
      setAllGroups(false);
      return;
    }
    if (key === 'n') {
      nextRunning();
      return;
    }
    if (key === 'a') {
      state.autoFollow = !state.autoFollow;
      if (state.autoFollow) {
        const { sessions, selected } = currentSession();
        const active = sessions.find((session) => session.state === 'active');
        if (active && active.id !== selected?.id) select(active.id);
      }
      return;
    }
    if (key === 'b') {
      state.bell = !state.bell;
      return;
    }

    if (state.focus === 'list') {
      if (key === 'up' || key === 'k') moveList(-1);
      else if (key === 'down' || key === 'j') moveList(1);
      else if (key === 'pageup') moveList(-5);
      else if (key === 'pagedown') moveList(5);
      else if (key === 'g' || key === 'home') moveList(-1e9);
      else if (key === 'G' || key === 'end') moveList(1e9);
      else if (key === 'enter' || key === 'space') activateItem();
      else if (key === 'right') {
        const item = cursorItem();
        if (item?.type === 'group') toggleGroup(item, 'open');
        else if (item?.type === 'session') openSession(item.session.id);
      } else if (key === 'left') {
        const item = cursorItem();
        if (item) toggleGroup(item, 'collapse');
      }
      return;
    }

    if (key === 'up' || key === 'k') moveCursor(-1);
    else if (key === 'down' || key === 'j') moveCursor(1);
    else if (key === 'pageup') scrollDetailBy(-detailHeight(), { moveCursor: true });
    else if (key === 'pagedown') scrollDetailBy(detailHeight(), { moveCursor: true });
    // Half-page scrolling that leaves the highlight in place: the keyboard
    // counterpart of the mouse wheel.
    else if (key === 'ctrl-u') scrollDetailBy(-Math.max(1, Math.floor(detailHeight() / 2)));
    else if (key === 'ctrl-d') scrollDetailBy(Math.max(1, Math.floor(detailHeight() / 2)));
    else if (key === 'g' || key === 'home') goTop();
    else if (key === 'G' || key === 'end') goBottom();
    else if (key === 'enter' || key === 'space') toggleCurrent({ explain: true });
    else if (key === 'e') expandAll();
    else if (key === 'E') collapseAll();
    else if (key === 'left') state.focus = 'list';
  }

  function handleMouse(event) {
    const hits = lastHits;
    if (!hits) return;
    const { button, x, y, press } = event;
    const inside = (box) => box && x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;

    if (button === 64 || button === 65) {
      const delta = button === 64 ? -3 : 3;

      // The wheel scrolls the panel under the pointer and nothing else.
      if (state.help) {
        if (inside(hits.detailPanel)) scrollHelp(delta);
      } else if (inside(hits.listPanel)) moveList(delta);
      else if (inside(hits.detailPanel)) scrollDetailBy(delta);
      return;
    }

    if (button !== 0 || !press) return;

    if (y === hits.footerY) {
      const buttonHit = hits.footer.find((item) => x >= item.x0 && x <= item.x1);
      if (buttonHit) handleKey(buttonHit.key);
      return;
    }

    if (state.help) return; // help is modal for the mouse too

    for (const [view, tab] of Object.entries(hits.viewTabs || {})) {
      if (y !== tab.y || x < tab.x0 || x > tab.x1) continue;
      setView(view === 'toggle' ? (state.view === 'reading' ? 'process' : 'reading') : view);
      return;
    }

    if (inside(hits.listPanel)) {
      const hit = hits.list.find((item) => item.y === y);
      if (!hit) return;
      state.focus = 'list';
      state.listCursor = hit.key;
      if (hit.item.type === 'group') toggleGroup(hit.item, 'toggle');
      // In a narrow window only one panel shows, so a click opens the transcript.
      else openSession(hit.item.session.id, { enter: !geometry(columnsOf()).wide });
      return;
    }

    if (inside(hits.detailPanel)) {
      state.focus = 'detail';
      const hit = hits.detail.find((item) => item.y === y);
      if (hit) {
        state.detail.cursorKey = hit.key;
        state.detail.free = false;
        toggleCurrent({ explain: true });
      }
    }
  }

  function quit() {
    if (state.update.task) {
      state.flash = { until: Date.now() + 5000, text: 'Finishing the update, please wait' };
      draw();
      return;
    }

    if (quitting) return;
    quitting = true;

    for (const timer of timers) clearInterval(timer);
    screen.restore();

    try {
      inp.setRawMode(false);
    } catch {}
    process.exit(0);
  }

  function fail(error) {
    quitting = true;
    for (const timer of timers) clearInterval(timer);
    screen.restore();
    try {
      inp.setRawMode(false);
    } catch {}
    console.error(error);
    process.exit(1);
  }

  const inputState = { pending: '' };
  let escapeTimer = null;

  function dispatch(tokens) {
    for (const token of tokens) {
      if (token.type === 'mouse') handleMouse(token);
      else handleKey(token.key);
    }
  }

  function onData(buffer) {
    if (escapeTimer) {
      clearTimeout(escapeTimer);
      escapeTimer = null;
    }

    dispatch(parseInput(buffer.toString('utf8'), inputState));

    // A lone Escape is indistinguishable from the start of a split sequence
    // until a short pause proves that nothing follows it in this keypress.
    if (inputState.pending === '\x1b') {
      escapeTimer = setTimeout(() => {
        escapeTimer = null;
        dispatch(flushInput(inputState));
        draw();
      }, ESCAPE_FLUSH_MS);
    }

    draw();
  }

  function tick() {
    const now = Date.now();
    store.tickSync(now);
    if (state.autoFollow) {
      const { sessions, selected } = currentSession();
      const active = sessions.find((session) => session.state === 'active');
      if (active && active.id !== selected?.id && active.mtime > (selected?.mtime ?? 0))
        select(active.id);
    }
    draw();
  }

  screen.enter();
  inp.setRawMode(true);
  inp.resume();
  inp.on('data', onData);

  // Dragging or maximizing fires a burst of resize events, and Windows consoles
  // may repaint their own reflowed copy a moment later. Like btop, wait for the
  // size to settle, then clear and repaint everything, and once more shortly
  // after to win against a late console repaint. Ctrl+L forces the same.
  const redrawAll = () => {
    drawnSize = '';
    draw();
  };

  let resizeTimers = [];
  out.on('resize', () => {
    for (const timer of resizeTimers) clearTimeout(timer);
    resizeTimers = [setTimeout(redrawAll, 60), setTimeout(redrawAll, 400)];
  });
  process.on('SIGINT', quit);
  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);
  process.on('exit', () => screen.restore());

  await store.init();
  const first =
    store.sessions(Date.now()).find((session) => session.id === store.selectedId) ||
    store.sessions(Date.now())[0] ||
    null;
  state.selectedId = first?.id ?? null;
  state.detail = defaultDetail();

  if (state.selectedId) {
    state.sessionStates.set(state.selectedId, state.detail);
    state.listCursor = `session:${state.selectedId}`;
    revealSession(
      state.toggledGroups,
      store.sessions(Date.now()),
      state.selectedId,
      Date.now(),
      new Set(),
    );
  }

  draw();

  void refreshUpdate();
  timers = [
    setInterval(tick, 1000),
    setInterval(
      () => {
        void refreshUpdate();
      },
      60 * 60 * 1000,
    ),
  ];

  return { state, store, quit };
}
