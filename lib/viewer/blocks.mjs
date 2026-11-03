/**
 * Turn projected transcript nodes into foldable content blocks. Reading mode
 * keeps the answer-first ordering; process mode is strictly chronological.
 * Blocks are plain data: `lines` is the collapsed form, `full` the expanded
 * form, and every line is ANSI-styled by the supplied styler.
 */
import { projectTranscript } from '../viewer-model.mjs';
import { bodyColumns, cut as cutText, displayWidth, safeText, styler, wrapText } from './text.mjs';

// Headings that start the bridge's appended instructions: the current English
// one and the Chinese one used by sessions recorded by earlier versions.
const STOPS = ['[dpsk-bridge report contract]', '【桥接报告约定】'];

// Block labels are padded to one width so the text after them lines up.
const TAG_WIDTH = 8;
const tag = (paint, text) => paint(text) + ' '.repeat(Math.max(0, TAG_WIDTH - displayWidth(text)));

/** Attach an expandable body that is only wrapped when the block is opened. */
function withLazyFull(block, make) {
  let ready = false, value = null;
  Object.defineProperty(block, 'full', {
    enumerable: true, configurable: true,
    get() { if (!ready) { value = make(); ready = true; } return value; },
  });
  return block;
}

export function shortTitle(value) {
  const text = safeText(value || 'Untitled task');
  const cut = Math.min(text.length, ...STOPS.map(stop => text.indexOf(stop)).filter(at => at >= 0));
  // `[dpsk-bridge]` labels host background tasks; it is noise in a dsh title.
  return text.slice(0, cut).trim().replace(/^\[dpsk-bridge\]\s*/i, '').trim() || 'Untitled task';
}

export function toolLabel(name) {
  const text = safeText(name || 'tool');
  const match = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(text);
  return match ? `${match[1]}·${match[2]}` : text;
}

export function toolResult(message) {
  return message?.role === 'tool' ? message : undefined;
}

/** Count and describe tools/errors using the same event shapes as the model. */
export function eventStats(events) {
  let tools = 0, errors = 0, openTurns = 0, lastEnd = null;
  for (const event of events) {
    if (event.type === 'turn/start') openTurns++;
    else if (event.type === 'turn/end') { openTurns = Math.max(0, openTurns - 1); lastEnd = event.data?.reason?.kind ?? null; }
    else if (event.type === 'tool/call') tools++;
    else if (event.type === 'tool/result' && (toolResult(event.data?.message)?.isError || event.data?.error)) errors++;
  }
  return { tools, errors, openTurns, lastEnd };
}

function finalHeading(node, details, st) {
  const text = safeText(node.text);
  const state = /^RESULT:\s*(OK|FAIL|BLOCKED)\s*(?:\r?\n|$)/u.exec(text);
  if (state?.[1] === 'BLOCKED') return { heading: st.yellow(st.bold('Blocked')), body: text.slice(state[0].length).trimStart() };
  if (state?.[1] === 'FAIL' || node.tone === 'error') return { heading: st.red(st.bold('Not finished')), body: state ? text.slice(state[0].length).trimStart() : text };
  if (Number.isInteger(node.turn) && Number.isInteger(details.currentTurn) && details.currentTurn > node.turn) {
    return { heading: st.gray(st.bold('Previous result')), body: state ? text.slice(state[0].length).trimStart() : text };
  }
  return { heading: st.green(st.bold('Result')), body: state ? text.slice(state[0].length).trimStart() : text };
}

function readingBlock(node, details, st) {
  const max = details.max, summary = safeText(node.summary || node.title || '');
  if (node.kind === 'final') {
    const { heading, body } = finalHeading(node, details, st);
    const lines = ['', heading, '', ...wrapText(body, max).map(line => '  ' + line), ''];
    return { key: node.key, kind: 'final', label: 'Result', lines, full: null, expandable: false, tone: 'final' };
  }
  if (node.kind === 'question' && node.state === 'pending') {
    const preview = wrapText(summary, max - 4).slice(0, 6);
    const block = {
      key: node.key, kind: 'question', label: 'Needs reply',
      lines: [st.yellow(st.bold('Needs reply')), ...preview.map(line => '  ' + line), ''],
      expandable: true, tone: 'warning',
    };
    return withLazyFull(block, () => [st.yellow(st.bold('Needs reply')),
      ...wrapText(safeText(node.text) || summary, max).map(line => '  ' + line)]);
  }
  const label = node.kind === 'question' ? tag(text => st.yellow(st.bold(text)), node.state === 'success' ? 'Q&A' : 'Question')
    : node.kind === 'task' ? tag(st.cyan, 'Task')
      : node.kind === 'error' ? tag(st.red, 'Error')
        : node.kind === 'assistant' ? tag(st.bold, 'Progress')
          : tag(st.gray, safeText(node.title || 'Process'));
  const count = node.kind === 'error' ? 2 : node.kind === 'question' ? 3 : 1;
  const preview = wrapText(summary, max - 4).slice(0, count);
  const lines = [`${label}  ${node.kind === 'error' ? st.red(preview[0] || '') : preview[0] || ''}`,
    ...preview.slice(1).map(line => '  ' + line)];
  const expandable = node.expandable !== false;
  const block = {
    key: node.key, kind: node.kind, label: safeText(node.title || 'Process'), lines,
    expandable, tone: node.tone || 'neutral',
  };
  if (!expandable) return { ...block, full: null };
  return withLazyFull(block, () => [`${label}  ${preview[0] || ''}`,
    ...wrapText(safeText(node.text) || summary, max).map(line => '  ' + line)]);
}

function processBlock(node, details, st) {
  const max = details.max, summary = safeText(node.summary || node.title || '');
  if (node.kind === 'final') {
    const { heading, body } = finalHeading(node, details, st);
    return { key: node.key, kind: 'final', label: 'Result', lines: ['', heading, '', ...wrapText(body, max).map(line => '  ' + line), ''],
      full: null, expandable: false, tone: 'final' };
  }
  if (node.kind === 'tool' || node.kind === 'question') {
    const pending = node.state === 'pending', failed = node.state === 'error';
    const mark = failed ? st.red('✗ ') : pending ? st.yellow('… ') : st.gray('✓ ');
    const name = node.kind === 'question' ? 'Question' : toolLabel(node.toolLabel || node.summary);
    const label = failed ? st.red(name) : node.kind === 'question' ? st.yellow(name) : st.blue(name);
    // Only a real summary follows the tool name; the generic node title would just repeat "Tool".
    const detail = safeText(node.summary || '');
    const line = mark + label + (detail ? ' ' + (failed ? st.red(cutText(detail, max - 8)) : st.gray(cutText(detail, max - 8))) : '');
    const block = {
      key: node.key, kind: node.kind, label: safeText(node.title || name), lines: [line],
      expandable: true, tone: node.tone || 'neutral',
    };
    return withLazyFull(block, () => [mark + label,
      ...wrapText(safeText(node.text) || summary, max).map(value => '  ' + value)]);
  }
  const label = node.kind === 'task' ? tag(st.cyan, 'Task')
    : node.kind === 'error' ? tag(st.red, 'Error')
      : node.kind === 'question' ? tag(st.yellow, 'Q&A')
        : node.kind === 'assistant' ? tag(st.bold, 'Progress')
          : tag(st.gray, safeText(node.title || 'Process'));
  const preview = wrapText(summary, max - 4).slice(0, node.kind === 'error' ? 2 : 1);
  const expandable = node.expandable !== false;
  const block = {
    key: node.key, kind: node.kind, label: safeText(node.title || 'Process'),
    lines: [`${label}  ${node.kind === 'error' ? st.red(preview[0] || '') : preview[0] || ''}`,
      ...preview.slice(1).map(line => '  ' + line)],
    expandable, tone: node.tone || 'neutral',
  };
  if (!expandable) return { ...block, full: null };
  return withLazyFull(block, () => [label,
    ...wrapText(safeText(node.text) || summary, max).map(line => '  ' + line)]);
}

/** Build reading or process blocks for one transcript. */
export function buildBlocks(events, {
  view = 'reading', columns = 100, reasoning = false, system = false, interactive = true, st = styler(true),
  currentTurn,
} = {}) {
  const nodes = projectTranscript(events, { reasoning, system });
  const max = bodyColumns(columns);
  const turn = currentTurn ?? events.findLast(event => event.type === 'turn/start')?.data?.turn;
  const details = { max, currentTurn: turn };
  if (view === 'process') {
    return nodes.filter(node => node.kind !== 'title').map(node => processBlock(node, details, st));
  }
  const final = nodes.findLast(node => node.kind === 'final');
  const pending = nodes.filter(node => node.kind === 'question' && node.state === 'pending');
  const task = nodes.findLast(node => node.kind === 'task');
  const progress = nodes.slice(final ? nodes.lastIndexOf(final) + 1 : 0).findLast(node => node.kind === 'assistant');
  let visible = [
    ...pending,
    ...(final ? [final] : []),
    ...(progress ? [progress] : []),
    ...(task ? [task] : []),
    ...nodes.filter(node => node.kind === 'error' || (node.kind === 'question' && node.state === 'error')).slice(-2),
    ...nodes.filter(node => node.title === 'Attachment').slice(-3),
    ...(reasoning ? nodes.filter(node => node.key.startsWith('reasoning:')).slice(-1) : []),
  ];
  visible = [...new Map(visible.map(node => [node.key, node])).values()];
  const blocks = visible.map(node => readingBlock(node, details, st));
  const hidden = nodes.filter(node => node.kind !== 'title' && !visible.includes(node));
  if (hidden.length || !blocks.length) {
    const tools = nodes.filter(node => ['tool', 'error', 'question'].includes(node.kind)).length;
    const overview = {
      key: 'process-overview', kind: 'overview', label: 'Process',
      lines: ['', st.gray(`${tag(text => text, 'Process')}  ${tools} tool call${tools === 1 ? '' : 's'}   ${interactive ? 'd for the full process' : '--details for the full process'}`)],
      expandable: true, tone: 'neutral',
    };
    blocks.push(withLazyFull(overview, () => ['', st.bold('Process summary'),
      ...hidden.map(node => '  ' + cutText(safeText(node.summary || node.title || ''), max)),
      st.gray('d opens the full process   Enter collapses this')]));
  }
  return blocks;
}

/** Flatten blocks honoring per-session and global expansion. */
export function flattenBlocks(blocks, { expanded = new Set(), allExpanded = false } = {}) {
  const lines = [], keys = [], starts = new Map(), ends = new Map();
  for (const block of blocks) {
    // Ask for the lazy expanded body only when this block is actually open.
    const wantsFull = allExpanded || expanded.has(block.key);
    const body = (wantsFull && block.full) ? block.full : block.lines;
    if (!starts.has(block.key)) starts.set(block.key, lines.length);
    for (const line of body) { lines.push(line); keys.push(block.key); }
    ends.set(block.key, lines.length - 1);
  }
  return { lines, keys, starts, ends };
}

/** Keep the block's first line on the same screen row after expanding it. */
export function anchoredScroll(oldStart, oldScroll, newStart, maxScroll) {
  const anchor = oldStart - oldScroll;
  return Math.max(0, Math.min(Math.max(0, maxScroll), newStart - anchor));
}

/** Block key at a flattened line (or the closest preceding block). */
export function blockKeyAt(keys, line) {
  if (!keys.length) return null;
  const index = Math.max(0, Math.min(keys.length - 1, line));
  return keys[index] || null;
}

/** Move the cursor between content blocks, clamped to the first/last block. */
export function moveBlockKey(starts, current, delta) {
  const keys = [...starts.entries()].sort((a, b) => a[1] - b[1]).map(([key]) => key);
  if (!keys.length) return null;
  let index = keys.indexOf(current);
  if (index < 0) index = 0;
  return keys[Math.max(0, Math.min(keys.length - 1, index + delta))];
}
