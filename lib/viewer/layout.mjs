/**
 * Pure frame layout. Given a fully prepared viewer state and a terminal size,
 * return one string per screen row plus absolute mouse hit boxes. No I/O and
 * no clock reads beyond the supplied `now`.
 */
import { shortTitle } from './blocks.mjs';
import { ago, cut, displayWidth, fitAnsi, safeText, styler, truncate, when, wrapText } from './text.mjs';

const STATUS = {
  active: { icon: '●', label: 'Running', color: 'cyan' },
  quiet: { icon: '◌', label: 'No updates', color: 'yellow' },
  done: { icon: '✓', label: 'Ended', color: 'green' },
  loading: { icon: '…', label: 'Loading', color: 'gray' },
  unreadable: { icon: '✗', label: 'Unreadable', color: 'red' },
  error: { icon: '✗', label: 'Failed', color: 'red' },
  aborted: { icon: '✗', label: 'Aborted', color: 'red' },
  // A bridge job whose process is gone while its log still has an open turn.
  interrupted: { icon: '■', label: 'Interrupted', color: 'red' },
};

export function statusInfo(state) {
  return STATUS[state] || { icon: '✗', label: String(state || 'error'), color: 'red' };
}

export function helpLines() {
  return [
    'Sessions    ↑↓ or j/k select   PgUp/PgDn jump 5   g/G or Home/End first/last',
    '            Enter/Space open a session or fold a group   → unfold or open   ← fold the group',
    '            z fold all   Z unfold all   n next running session',
    'Transcript  ↑↓ or j/k move by block   Enter/Space expand or collapse the block',
    '            PgUp/PgDn page, the highlight follows   Ctrl+D/Ctrl+U half page, the highlight stays',
    '            g top   G/End follows new output   e/E expand/collapse every block   Esc/← back to sessions',
    '            After the wheel or Ctrl+D/U, j/k and Enter continue from what is on screen',
    'Anywhere    Tab/Shift+Tab switch panel   d reading/process   r thinking   i path, ID and usage',
    '            f expand everything (toggle)   s system messages   a auto-follow   b bell when a session ends',
    '            u check for and install updates   Ctrl+L redraw   ? help   q/Ctrl+C quit',
    'Mouse       Click a session to select it (in a narrow window it opens)   click a group to fold it',
    '            Click a block to expand it   click d, Reading or Process at the bottom right to switch views',
    '            The wheel scrolls the panel under the pointer, or this help while it is open',
    'Note        Log state does not prove a process is alive, and Ended does not mean accepted',
    '            Interrupted: the bridge job stopped before the session finished; it will not continue',
    '            Check bridge jobs with dsb status',
    'In help     ↑↓, PgUp/PgDn or the wheel scroll   ? or Esc closes',
  ];
}

const HELP_INDENT = '            ';

/** Help text wrapped to `width`; continuation lines keep the hanging indent. */
export function helpView(width) {
  const out = [];
  for (const line of helpLines()) {
    if (displayWidth(line) <= width || width <= HELP_INDENT.length + 10) { out.push(...wrapText(line, Math.max(1, width))); continue; }
    const [first] = wrapText(line, width);
    const rest = line.slice(first.length).trim();
    out.push(first, ...wrapText(rest, width - HELP_INDENT.length).map(part => HELP_INDENT + part));
  }
  return out;
}

const isWide = columns => columns >= 100;

/** Shared pane geometry so the app builds blocks at exactly the painted width. */
export function geometry(columns) {
  const wide = isWide(columns);
  const leftWidth = wide ? Math.max(26, Math.min(36, Math.round(columns * 0.26))) : columns;
  return { wide, leftWidth, rightWidth: columns - leftWidth, detailWidth: (wide ? columns - leftWidth : columns) - 2 };
}

// A finished session stays in the running group this long after its last
// update, so the user notices it ending (the app also holds the session being
// viewed there and restarts this delay when the user moves away from it).
export const LINGER_MS = 2 * 60_000;
// A turn that is still open but silent this long is almost always abandoned;
// it is listed under Finished (still marked No updates) instead of crowding Running.
export const STALE_MS = 30 * 60_000;

const dayKey = time => {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
/** Day group label, e.g. 2026-11-2 (no zero padding, no weekday). */
const dayLabel = time => {
  const date = new Date(time);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
};

/** Whether a session belongs in the running group right now. */
export function isRunning(session, now = Date.now(), held = new Set()) {
  if (held.has(session.id) || session.state === 'active') return true;
  const age = now - session.mtime;
  if (session.state === 'quiet') return age < STALE_MS;
  return session.state !== 'loading' && age < LINGER_MS;
}

/**
 * Two top-level groups. Running is split by state (Active / No updates / Just ended);
 * Finished is split by calendar day, newest first. Empty sub-groups are omitted;
 * the two top-level groups are always shown.
 */
export function sessionGroups(sessions, now = Date.now(), { held = new Set() } = {}) {
  const byTime = (a, b) => b.mtime - a.mtime;
  const running = [], finished = [];
  for (const session of sessions) (isRunning(session, now, held) ? running : finished).push(session);
  const states = [['active', 'Active', s => s.state === 'active'], ['quiet', 'No updates', s => s.state === 'quiet'],
    ['ended', 'Just ended', s => s.state !== 'active' && s.state !== 'quiet']];
  const runningChildren = states.map(([key, label, test]) => ({ key: `running:${key}`, label, sessions: running.filter(test).sort(byTime) }))
    .filter(group => group.sessions.length);
  const days = new Map();
  for (const session of [...finished].sort(byTime)) {
    const key = `day:${dayKey(session.mtime)}`;
    if (!days.has(key)) days.set(key, { key, label: dayLabel(session.mtime), sessions: [] });
    days.get(key).sessions.push(session);
  }
  return [
    { key: 'running', label: 'Running', sessions: running, children: runningChildren },
    { key: 'done', label: 'Finished', sessions: finished, children: [...days.values()] },
  ];
}

/** Day groups other than the newest start collapsed; everything else starts open. */
export function defaultCollapsed(groupKey, groups) {
  if (!groupKey.startsWith('day:')) return false;
  const newest = groups.find(group => group.key === 'done')?.children[0]?.key;
  return groupKey !== newest;
}

/**
 * Visible list rows in display order. `toggledGroups` maps a group key to an
 * explicit collapsed flag; keys without an entry keep the current default.
 */
export function listItems({ sessions, toggledGroups = new Map(), held = new Set(), selectedId = null, listCursor = null, now = Date.now() }) {
  const groups = sessionGroups(sessions, now, { held });
  const collapsedOf = key => toggledGroups.has(key) ? toggledGroups.get(key) : defaultCollapsed(key, groups);
  const items = [];
  for (const group of groups) {
    const collapsed = collapsedOf(group.key);
    items.push({ key: `group:${group.key}`, type: 'group', group, collapsed, depth: 0 });
    if (collapsed) continue;
    for (const child of group.children) {
      const childCollapsed = collapsedOf(child.key);
      items.push({ key: `group:${child.key}`, type: 'group', group: child, collapsed: childCollapsed, depth: 1 });
      if (!childCollapsed) for (const session of child.sessions) items.push({ key: `session:${session.id}`, type: 'session', session, group: child, depth: 2 });
    }
  }
  let cursor = listCursor;
  if (!items.some(item => item.key === cursor)) {
    cursor = items.find(item => item.type === 'session' && item.session.id === selectedId)?.key || items[0]?.key || null;
  }
  return { groups, items, cursor, collapsedOf };
}

function accent(st, focused) { return focused ? st.cyan : st.gray; }

/**
 * Top border with a title. A plain title is sanitized and cut here; a styled
 * title (from detailTitle) must already fit in width - 4 columns. Border
 * pieces are colored separately so the title's own styles cannot leak.
 */
function boxTop(width, title, st, focused) {
  const color = accent(st, focused);
  const room = Math.max(0, width - 4);
  const text = String(title).includes('\x1b') ? title : color(truncate(safeText(title), room));
  const rest = Math.max(0, width - 4 - displayWidth(text));
  return color('╭ ') + text + color(' ' + '─'.repeat(rest) + '╮');
}

function boxBottom(width, st, focused) {
  return accent(st, focused)('╰' + '─'.repeat(Math.max(0, width - 2)) + '╯');
}

/**
 * Bottom border of the detail box with the reading/process switch embedded
 * at the right corner: ╰────── d  Reading │ Process ─╯. The `d` chip is the same
 * key chip as in the footer and names the keyboard shortcut. Hit x ranges
 * are 1-based; clicking the chip toggles, clicking a tab selects it.
 */
function viewSwitch({ width, view, st, focused, x0 = 0 }) {
  const color = accent(st, focused);
  const chip = ' d ';
  const tabs = [['reading', 'Reading'], ['process', 'Process']].map(([key, label]) => ({ key, text: ` ${label} ` }));
  const inner = displayWidth(chip) + 1 + tabs.map(tab => displayWidth(tab.text)).reduce((sum, w) => sum + w, 0) + 1;
  if (width < inner + 6) return { line: boxBottom(width, st, focused), hits: {} };
  const dashes = width - 2 - inner - 2;
  let line = color('╰' + '─'.repeat(dashes) + ' ');
  let x = x0 + 1 + dashes + 1 + 1; // 1-based column of the chip
  const hits = { toggle: { x0: x, x1: x + displayWidth(chip) - 1 } };
  line += st.key(chip) + ' ';
  x += displayWidth(chip) + 1;
  tabs.forEach((tab, index) => {
    if (index) { line += color('│'); x += 1; }
    const w = displayWidth(tab.text);
    hits[tab.key] = { x0: x, x1: x + w - 1 };
    line += view === tab.key ? st.tabActive(tab.text) : st.gray(tab.text);
    x += w;
  });
  line += color(' ╯');
  return { line, hits };
}

function boxLine(content, width, st, focused) {
  const color = accent(st, focused);
  return color('│') + fitAnsi(content, Math.max(0, width - 2)) + color('│');
}

const listModel = ({ sessions, toggledGroups, held, selectedId, listCursor, now }) =>
  listItems({ sessions, toggledGroups, held, selectedId, listCursor, now });

function itemHeight(item) { return item.type === 'session' ? 2 : 1; }

/**
 * `height` is the number of content rows inside the box. `previousTop` keeps
 * the scroll position stable: the list only scrolls when the cursor would
 * leave the visible area, like a normal list widget.
 */
function listRows({ width, height, items, cursor, selectedId, focus, st, now, previousTop = 0 }) {
  const inner = Math.max(0, width - 2), rows = [];
  const area = Math.max(0, height);
  const cursorIndex = Math.max(0, items.findIndex(item => item.key === cursor));
  let top = 0;
  if (items.length) {
    let offset = 0;
    for (let index = 0; index < cursorIndex; index++) offset += itemHeight(items[index]);
    const extra = itemHeight(items[cursorIndex]);
    top = Math.max(0, previousTop);
    if (offset < top) top = offset;
    else if (offset + extra > top + area) top = offset + extra - area;
    const total = items.reduce((sum, item) => sum + itemHeight(item), 0);
    top = Math.max(0, Math.min(top, Math.max(0, total - area)));
    // Never start the box in the middle of a two-line session: move down to
    // the next item boundary. The cursor item starts at `offset` >= top, so
    // it always stays in view.
    let start = 0;
    for (const item of items) {
      if (start >= top) break;
      start += itemHeight(item);
    }
    top = Math.min(start, offset);
  }
  const hits = [];
  let used = 0, itemRow = 0;
  for (const item of items) {
    const itemHeightValue = itemHeight(item);
    for (let line = 0; line < itemHeightValue; line++) {
      if (itemRow >= top && used < area) {
        const rowIndex = itemRow - top;
        rows[rowIndex] = renderListItem(item, line, { inner, cursor, selectedId, focus, st, now });
        hits.push({ y: 0, itemRow: rowIndex, key: item.key, item });
        used++;
      }
      itemRow++;
    }
  }
  while (rows.length < Math.max(1, height)) rows.push('');
  return { rows: rows.slice(0, Math.max(1, height)), hits, top };
}

const projectOf = session => safeText(session.cwd ? session.cwd.split(/[\\/]/).filter(Boolean).at(-1) : '') || '?';

function renderListItem(item, line, { inner, cursor, selectedId, focus, st, now }) {
  const focused = focus === 'list' && item.key === cursor;
  const marker = focused ? st.cyan('▌') : item.type === 'session' && item.session.id === selectedId ? st.gray('▌') : ' ';
  if (item.type === 'group') {
    const arrow = item.collapsed ? '▸' : '▾';
    const contains = item.group.sessions.some(session => session.id === selectedId);
    const text = `${arrow} ${item.group.label}`;
    const strong = item.depth === 0 || focused || contains;
    return fitAnsi(marker + ' '.repeat(1 + item.depth * 2) + (strong ? st.bold(text) : st.gray(text)), inner);
  }
  const indent = ' '.repeat(1 + item.depth * 2);
  const session = item.session, info = statusInfo(session.state);
  const icon = st[info.color] ? st[info.color](info.icon) : info.icon;
  const room = Math.max(4, inner - displayWidth(indent) - 3);
  if (line === 0) {
    const title = cut(shortTitle(session.title || (session.loading ? 'Loading…' : 'Untitled task')), room);
    return fitAnsi(`${marker}${indent}${icon} ${session.id === selectedId ? st.bold(title) : title}`, inner);
  }
  const error = session.errors ? '  ' + st.red('!') : '';
  const age = '  ' + ago(session.mtime, now);
  const project = truncate(projectOf(session), Math.max(4, room - displayWidth(age) - (session.errors ? 3 : 0)));
  return fitAnsi(`${marker}${indent}  ${st.gray(project + age)}${error}`, inner);
}

function detailInfoLines(session, width, st) {
  if (!session) return [];
  const lines = [];
  const usage = session.usage;
  const token = key => usage?.available && usage.tokens?.[key] !== null && usage.tokens?.[key] !== undefined ? usage.tokens[key] : '?';
  lines.push(st.gray(`Path     ${truncate(safeText(session.cwd || '?'), Math.max(4, width - 14))}`));
  lines.push(st.gray(`ID       ${safeText(session.id)}   format v${session.version ?? '?'}   started ${when(session.created)}`));
  lines.push(st.gray(usage?.available
    ? `Usage    input ${token('uncachedInputTokens')}   output ${token('outputTokens')}   cache read ${token('cacheReadTokens')}   cache write ${token('cacheWriteTokens')}${usage.missingSamples ? '   (incomplete samples)' : ''}`
    : 'Usage    unavailable (not the same as zero)'));
  if (session.version > 4) lines.push(st.yellow('This log format is not verified yet; only recognized records are shown'));
  if (session.logComplete === false) lines.push(st.yellow('The log ends with an unfinished or unreadable record; showing everything before it'));
  if (session.readError) lines.push(st.red(`Could not read the log: ${truncate(safeText(session.readError), Math.max(4, width - 24))}`));
  if (['active', 'quiet'].includes(session.state)) lines.push(st.gray('Log state does not prove the process is alive; check bridge jobs with dsb status'));
  return lines;
}

/**
 * Detail box title, fitted to `room` columns: status, project, then the task,
 * separated by two spaces. Only the task is shortened when space runs out.
 */
function detailTitle(session, st, room) {
  if (!session) return st.bold('Transcript');
  const info = statusInfo(session.state);
  const status = `${info.icon} ${info.label}`;
  const project = projectOf(session);
  const fixed = displayWidth(status) + 2 + displayWidth(project) + 2;
  const task = cut(shortTitle(session.title || (session.loading ? 'Loading…' : 'Untitled task')), Math.max(4, room - fixed));
  const paint = st[info.color] || (value => value);
  return truncateStyled([[paint, status], [st.gray, '  ' + project + '  '], [st.bold, task]], room);
}

/** Join styled segments, cutting the text (not the styles) to `room` columns. */
function truncateStyled(segments, room) {
  let out = '', left = room;
  for (const [paint, text] of segments) {
    if (left <= 0) break;
    const part = displayWidth(text) <= left ? text : truncate(text, left);
    out += paint(part); left -= displayWidth(part);
  }
  return out;
}

function scrollBar(contentH, total, scroll) {
  if (total <= contentH) return null;
  const max = total - contentH;
  const thumb = Math.max(1, Math.round(contentH * contentH / total));
  const top = Math.round((contentH - thumb) * (max ? Math.min(1, scroll / max) : 0));
  return { top, bottom: top + thumb };
}

/**
 * Bottom key bar. Every hint is a key chip plus a label with one fixed gap.
 * Hints are chosen by priority (panel navigation first, so a mouse user can
 * always get in and out of panels) and then shown in their natural order.
 * Help and quit are pinned to the right edge and never dropped. Labels follow
 * the context: Enter on a group folds it, and the bar changes while help is open.
 */
function footerModel({ width, focus, flags, st, help = false, cursorType = 'session' }) {
  // [key, label, action, on, priority]
  let left;
  if (help) left = [['↑↓', 'Scroll', null, false, 2], ['Esc', 'Close help', 'escape', false, 1]];
  else if (focus === 'list') {
    left = [['↑↓', 'Select', null, false, 3], ['Enter', cursorType === 'group' ? 'Fold' : 'Open', 'enter', false, 2],
      ['Tab', 'Panel', 'tab', false, 1], ['d', 'View', 'd', false, 4], ['r', 'Thinking', 'r', flags.reasoning, 6],
      ['a', 'Follow', 'a', flags.autoFollow, 7], ['n', 'Next running', 'n', false, 8], ['z', 'Fold all', 'z', false, 9]];
  } else {
    left = [['↑↓', 'Move', null, false, 3], ['Enter', 'Expand', 'enter', false, 2], ['Tab', 'Panel', 'tab', false, 1],
      ['d', 'View', 'd', false, 4], ['r', 'Thinking', 'r', flags.reasoning, 6], ['Ctrl+D/U', 'Scroll', null, false, 8],
      ['e', 'Expand all', 'e', false, 9], ['E', 'Collapse all', 'E', false, 10]];
    if (flags.autoFollow) left.push(['a', 'Follow', 'a', true, 5]);
  }
  // Toggles that are on come right after the essentials so their state shows.
  if (!help) {
    for (const [key, label, on] of [['f', 'Expanded', flags.allExpanded], ['s', 'System', flags.system], ['b', 'Bell', flags.bell], ['i', 'Info', flags.info]]) {
      if (on) left.push([key, label, key, true, 5]);
    }
  }
  const pinned = [['?', help ? 'Close' : 'Help', '?'], ['q', 'Quit', 'q']];
  const GAP = 2;
  const chipText = key => ` ${key} `;
  const itemWidth = ([key, label]) => displayWidth(chipText(key)) + 1 + displayWidth(label);
  const groupWidth = items => items.reduce((sum, item) => sum + itemWidth(item), 0) + GAP * Math.max(0, items.length - 1);
  const paint = ([key, label, action, on]) => {
    const chip = on ? st.keyOn(chipText(key)) : action ? st.key(chipText(key)) : st.keyIdle(chipText(key));
    return chip + ' ' + (on ? st.green(label) : st.gray(label));
  };
  const rightWidth = groupWidth(pinned);
  const room = width - 2 - rightWidth - GAP; // one column margin on each edge
  const chosen = new Set();
  for (const item of [...left].sort((a, b) => a[4] - b[4])) {
    if (groupWidth([...left.filter(other => chosen.has(other)), item]) <= room) chosen.add(item);
  }
  const ordered = left.filter(item => chosen.has(item));
  const hits = [];
  let text = ' ', x = 2;
  ordered.forEach((item, index) => {
    if (index) { text += ' '.repeat(GAP); x += GAP; }
    if (item[2]) hits.push({ x0: x, x1: x + itemWidth(item) - 1, key: item[2] });
    text += paint(item); x += itemWidth(item);
  });
  const rightStart = Math.max(x + GAP, width - rightWidth); // 1-based column
  text += ' '.repeat(Math.max(0, rightStart - x)); x = rightStart;
  pinned.forEach((item, index) => {
    if (index) { text += ' '.repeat(GAP); x += GAP; }
    hits.push({ x0: x, x1: x + itemWidth(item) - 1, key: item[2] });
    text += paint(item); x += itemWidth(item);
  });
  return { line: fitAnsi(text, width), hits };
}

/**
 * @param {object} model
 * @returns {{lines: string[], hits: object}}
 */
export function renderFrame(model) {
  const {
    columns: rawColumns = 100, rows: rawRows = 30, view = 'reading', focus = 'list',
    sessions = [], selectedId = null, selected = null, toggledGroups = new Map(), held = new Set(), listCursor = null,
    detail = null, help = false, helpScroll = 0, info = false, flash = null, update = {}, now = Date.now(),
    version = '', st = styler(false),
  } = model;
  const columns = Math.max(20, Math.floor(rawColumns));
  const rows = Math.max(6, Math.floor(rawRows));
  const wide = isWide(columns);
  const bodyTop = 1; // zero-based index of the panel top border (screen row 2)
  const panelH = rows - 2;
  const top = [];

  // ── top bar ──────────────────────────────────────────────────────────────
  // The view switch lives in the bottom-right corner of the detail box and
  // toggle states are shown in the key bar, so the top row is status only.
  const left = '';
  const running = sessions.filter(session => session.state === 'active').length;
  const rightParts = [];
  if (running) rightParts.push(st.cyan(`● ${running} running`));
  if (flash && (!flash.until || now < flash.until)) rightParts.push(st.bold(flash.text));
  if (update.message) rightParts.push(st.yellow(cut(update.message, Math.max(12, columns - 20))));
  else if (update.info?.available) rightParts.push(st.yellow(`Update ${update.info.latest} available  u to install`));
  if (version) rightParts.push(st.gray(`v${version}`));
  const right = rightParts.join('  ');
  const gap = Math.max(1, columns - displayWidth(left) - displayWidth(right));
  const topLine = left + ' '.repeat(gap) + right;
  top.push(fitAnsi(topLine, columns));

  // ── panes ────────────────────────────────────────────────────────────────
  const geo = geometry(columns);
  const leftWidth = geo.leftWidth, rightWidth = geo.rightWidth;
  const showList = wide || (!help && focus === 'list');
  const showDetail = wide || help || focus === 'detail';
  const list = showList ? listModel({ sessions, toggledGroups, held, selectedId, listCursor, now }) : null;
  const listPanel = showList ? listRows({
    width: wide ? leftWidth : columns, height: panelH - 2, items: list.items, cursor: list.cursor,
    selectedId, focus, st, now, previousTop: model.listTop ?? 0,
  }) : null;

  const helpText = help ? helpView((wide ? rightWidth : columns) - 2) : null;
  let detailLines = [], detailKeys = [], detailStarts = new Map();
  let displayScroll = 0;
  if (showDetail && !help) {
    let prefixLines = [];
    // The liveness caveat lives in the info panel (i) and help, not above
    // every running transcript.
    if (info && selected) prefixLines = [...detailInfoLines(selected, (wide ? rightWidth : columns) - 4, st), ''];
    if (!selected) {
      detailLines = ['', st.bold('Tasks and results appear here'), '', st.gray('Start a task with dsb run')];
      detailKeys = detailLines.map(() => null);
    } else if (!detail) {
      detailLines = ['', st.gray('Loading session…')];
      detailKeys = detailLines.map(() => null);
    } else {
      detailLines = detail.lines || [];
      detailKeys = detail.keys || [];
      detailStarts = detail.starts || new Map();
    }
    if (prefixLines.length) {
      detailLines = [...prefixLines, ...detailLines];
      detailKeys = [...prefixLines.map(() => null), ...detailKeys];
      for (const [key, value] of [...detailStarts]) detailStarts.set(key, value + prefixLines.length);
    }
    displayScroll = (detail?.scroll || 0) + prefixLines.length;
  }
  const detailWidth = (wide ? rightWidth : columns);
  const detailHeight = panelH - 2;
  const maxScroll = Math.max(0, detailLines.length - detailHeight);
  const scroll = Math.max(0, Math.min(maxScroll, displayScroll));
  const cursorKey = detail?.cursorKey ?? null;
  const cursorLine = cursorKey && detailStarts.has(cursorKey) ? detailStarts.get(cursorKey) : null;
  const bar = scrollBar(detailHeight, detailLines.length, scroll);
  // Help scrolls when it is taller than the box (rows - 4 lines of content).
  const helpOffset = helpText ? Math.max(0, Math.min(helpScroll, helpText.length - (panelH - 2))) : 0;
  const helpContent = helpText ? helpText.slice(helpOffset).map(line => st.gray(line)) : null;

  const titleText = help ? 'Help  ? to close' : detailTitle(selected, st, Math.max(0, detailWidth - 4));
  const effectivePanelH = panelH;
  const listTopBorder = showList ? boxTop(wide ? leftWidth : columns, 'Sessions', st, focus === 'list' && !help) : null;
  const listBottomBorder = showList ? boxBottom(wide ? leftWidth : columns, st, focus === 'list' && !help) : null;
  const detailTopBorder = showDetail ? boxTop(detailWidth, titleText, st, help || focus === 'detail') : null;
  const detailX = wide ? leftWidth : 0; // columns before the detail box
  const switcher = showDetail && !help ? viewSwitch({ width: detailWidth, view, st, focused: focus === 'detail', x0: detailX }) : null;
  const detailBottomBorder = showDetail ? (switcher ? switcher.line : boxBottom(detailWidth, st, help || focus === 'detail')) : null;
  const viewTabs = switcher ? Object.fromEntries(Object.entries(switcher.hits).map(([key, hit]) => [key, { ...hit, y: rows - 1 }])) : {};

  const bodyHits = { list: [], detail: [] };
  const body = [];
  for (let row = 0; row < effectivePanelH; row++) {
    let leftLine = '', rightLine = '';
    if (showList) {
      if (row === 0) leftLine = listTopBorder;
      else if (row === effectivePanelH - 1) leftLine = listBottomBorder;
      else {
        const content = listPanel.rows[row - 1] ?? '';
        leftLine = boxLine(content, wide ? leftWidth : columns, st, focus === 'list' && !help);
        const hit = listPanel.hits.find(item => item.itemRow === row - 1);
        if (hit) bodyHits.list.push({ y: bodyTop + row + 1, key: hit.key, item: hit.item });
      }
    }
    if (showDetail) {
      const dWidth = wide ? rightWidth : columns;
      if (row === 0) rightLine = detailTopBorder;
      else if (row === effectivePanelH - 1) rightLine = detailBottomBorder;
      else {
        const index = row - 1;
        let content;
        if (help) content = fitAnsi(helpContent?.[index] ?? '', dWidth - 2);
        else {
          const lineIndex = scroll + index;
          const key = detailKeys[lineIndex] ?? null;
          const highlighted = focus === 'detail' && !help && key && key === cursorKey;
          const lead = highlighted ? st.cyan('▌') : ' ';
          content = fitAnsi(lead + (detailLines[lineIndex] ?? ''), dWidth - 2, highlighted ? st.bgSelected : '');
          if (key) bodyHits.detail.push({ y: bodyTop + row + 1, key });
        }
        const thumb = bar && index >= bar.top && index < bar.bottom;
        const right = bar ? (thumb ? st.cyan('┃') : st.gray('│')) : accent(st, help || focus === 'detail')('│');
        rightLine = accent(st, help || focus === 'detail')('│') + content + right;
      }
    }
    body.push(wide ? leftLine + rightLine : (showList ? leftLine : rightLine));
  }
  while (body.length < effectivePanelH) body.push(' '.repeat(columns));
  while (body.length > effectivePanelH) body.pop();

  // ── footer ───────────────────────────────────────────────────────────────
  const footer = footerModel({
    width: columns, focus, st, help,
    cursorType: list?.items.find(item => item.key === list.cursor)?.type ?? 'session',
    flags: {
      reasoning: !!model.reasoning, autoFollow: !!model.autoFollow, allExpanded: !!model.allExpanded,
      system: !!model.system, bell: !!model.bell, info: !!model.info,
    },
  });
  const lines = [...top, ...body, footer.line].slice(0, rows);
  while (lines.length < rows) lines.push(' '.repeat(columns));
  return {
    lines,
    hits: {
      viewTabs,
      list: bodyHits.list,
      detail: bodyHits.detail,
      footer: footer.hits,
      footerY: rows,
      listPanel: showList ? { x0: 1, x1: wide ? leftWidth : columns, y0: bodyTop + 1, y1: bodyTop + panelH } : null,
      detailPanel: showDetail ? { x0: wide ? leftWidth + 1 : 1, x1: columns, y0: bodyTop + 1, y1: bodyTop + panelH } : null,
    },
    cursorKey,
    scroll,
    listTop: listPanel?.top ?? 0,
    maxScroll,
    detailHeight,
  };
}

export { isWide, STATUS };
