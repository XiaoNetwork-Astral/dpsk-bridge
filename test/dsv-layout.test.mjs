import test from 'node:test';
import assert from 'node:assert/strict';

import {
  renderFrame,
  geometry,
  helpLines,
  helpView,
  listItems,
  statusInfo,
} from '../lib/viewer/layout.mjs';
import {
  buildBlocks,
  flattenBlocks,
  anchoredScroll,
  blockKeyAt,
  moveBlockKey,
  shortTitle,
} from '../lib/viewer/blocks.mjs';
import { charWidth, cut, displayWidth, styler, truncate, wrapText } from '../lib/viewer/text.mjs';

const now = new Date(2026, 0, 15, 12).getTime();

const session = (id, overrides = {}) => ({
  id,
  file: `/tmp/${id}/session.v4.jsonl`,
  version: 4,
  mtime: now,
  size: 100,
  created: now - 60_000,
  title: `任务${id}`,
  prompt: '',
  cwd: `/work/${id}`,
  last: now,
  state: 'done',
  openTurns: 0,
  lastEnd: 'completed',
  tools: 1,
  errors: 0,
  usage: {
    available: true,
    tokens: { uncachedInputTokens: 10, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
    missingSamples: 0,
  },
  logComplete: true,
  readError: null,
  ...overrides,
});

const detailFor = (lines) => ({
  lines,
  keys: lines.map(() => 'final'),
  starts: new Map([['final', 0]]),
  scroll: 0,
  cursorKey: 'final',
});

const framePlain = (frame) =>
  frame.lines.map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''));

/** Text painted in 1-based display columns x0..x1 of a plain line. */
function columnsOf(line, x0, x1) {
  let column = 1,
    out = '';
  for (const ch of line) {
    if (column >= x0 && column <= x1) out += ch;
    column += displayWidth(ch);
  }
  return out;
}

function model(overrides = {}) {
  const sessions = [
    session('b', { title: '优化会话查看器', state: 'active', tools: 80 }),
    session('a', { mtime: now - 86_400_000, title: '昨天的任务', state: 'done', errors: 1 }),
    session('c', { mtime: now - 3 * 86_400_000, title: '本周任务' }),
    session('d', { mtime: now - 12 * 86_400_000, title: '更早任务' }),
  ];

  return {
    columns: 120,
    rows: 30,
    view: 'reading',
    focus: 'list',
    sessions,
    selectedId: 'b',
    selected: sessions[0],
    listCursor: 'session:b',
    detail: detailFor(['', 'Result', '', '  已完成阅读界面调整。']),
    now,
    version: '0.4.1',
    st: styler(false),
    ...overrides,
  };
}

test('wide layout has a status bar, grouped two-line sessions, a result pane and keyboard footer', () => {
  const frame = renderFrame(model());
  const plain = framePlain(frame);
  assert.equal(plain.length, 30);
  assert.doesNotMatch(plain[0], /dsv|Reading|Process/);
  assert.match(plain[0], /● 1 running/);
  assert.match(plain[0], /v0\.4\.1/);

  // Detail title: status, project, task; two-space separated, no dots.
  assert.match(plain[1], /╭ Sessions/);
  assert.match(plain[1], /╭ ● Running  b  优化会话查看器 ─+╮$/);

  const text = plain.join('\n');

  // 运行中 / 已完成 at the top level; running split by state, finished by day.
  assert.match(text, /^│ {2}▾ Running +│/m);
  assert.match(text, /^│ {4}▾ Active +│/m);
  assert.match(text, /^│ {2}▾ Finished +│/m);
  assert.doesNotMatch(text, /[▸▾] \S+ +\d+ +│/, 'group headers carry no counts');
  assert.match(text, /▾ 2026-1-14 +│/);
  assert.match(text, /▸ 2026-1-12 +│/);
  assert.match(text, /▸ 2026-1-3 +│/);
  assert.doesNotMatch(text, /[▸▾] (Today|Yesterday|Last 7 days|Older)/);
  assert.match(text, /昨天的任务/, 'the newest day is open');
  assert.match(text, /优化会话查看器/);
  assert.match(text, /b  just now/);
  assert.doesNotMatch(text, / · /);
  assert.match(text, /Result/);
  assert.match(text, /已完成阅读界面调整/);

  // The view switch sits in the bottom-right corner of the detail box.
  assert.match(plain[28], / d {3}Reading │ Process +╯$/);
  const { reading, process, toggle } = frame.hits.viewTabs;
  assert.equal(columnsOf(plain[28], toggle.x0, toggle.x1), ' d ');
  assert.equal(reading.y, 29);
  assert.ok(process.x0 > reading.x1);
  assert.equal(columnsOf(plain[28], reading.x0, reading.x1).trim(), 'Reading');
  assert.equal(columnsOf(plain[28], process.x0, process.x1).trim(), 'Process');

  assert.match(plain.at(-1), /Tab +Panel/);
  assert.match(plain.at(-1), /\? +Help +q +Quit $/);
  for (const line of plain) assert.equal(displayWidth(line), 120);

  assert.equal(frame.hits.list[0].y, 3);
  assert.equal(frame.hits.list[0].key, 'group:running');
  assert.ok(frame.hits.detail.some((hit) => hit.key === 'final'));
});

test('narrow layout paints exactly one panel and switches between list and detail', () => {
  const list = renderFrame(model({ columns: 80, rows: 20, focus: 'list' }));
  const listText = framePlain(list).join('\n');
  assert.match(framePlain(list)[1], /╭ Sessions/);
  assert.doesNotMatch(listText, /Result/);
  assert.match(listText, /▾ Running/);
  for (const line of framePlain(list)) assert.equal(displayWidth(line), 80);

  const detail = renderFrame(
    model({
      columns: 80,
      rows: 20,
      focus: 'detail',
      detail: detailFor(['', 'Result', '', '  答案']),
    }),
  );

  const detailText = framePlain(detail).join('\n');
  assert.match(framePlain(detail)[1], /● Running  b  优化会话查看器/);
  assert.doesNotMatch(detailText, /▾ Running/);
  assert.match(detailText, /答案/);
  for (const line of framePlain(detail)) assert.equal(displayWidth(line), 80);
});

test('focused panel border uses the accent color while the other border stays gray', () => {
  const listFocused = renderFrame(model({ st: styler(true) }));
  const groupRow = (frame) => frame.lines.find((line) => line.includes('▾ Running'));
  assert.ok(groupRow(listFocused).startsWith('\x1b[96m│'), 'focused list border is accented');
  const detailFocused = renderFrame(model({ focus: 'detail', st: styler(true) }));
  assert.ok(groupRow(detailFocused).startsWith('\x1b[90m│'), 'unfocused list border is gray');
  const resultRow = detailFocused.lines.find((line) => line.includes('Result'));
  assert.ok(resultRow.includes('\x1b[96m│'), 'focused detail border is accented');
});

test('CJK-aware truncation and wrapping never split a wide character in half', () => {
  assert.equal(displayWidth('中文abc'), 7);
  assert.ok(displayWidth(truncate('中文中文中文', 5)) <= 5);
  assert.ok(truncate('中文中文中文', 5).endsWith('…'));
  assert.equal(cut('  中文   文本  ', 20), '中文 文本');
  for (const line of wrapText('中文中文中文abc', 3)) assert.ok(displayWidth(line) <= 3, line);

  const long = '超长任务标题'.repeat(20);
  const frame = renderFrame(
    model({
      selected: session('b', { title: long }),
      sessions: [session('b', { title: long })],
      selectedId: 'b',
    }),
  );

  assert.match(frame.lines[1], /…/);
  for (const line of framePlain(frame)) assert.equal(displayWidth(line), 120);
});

test('help overlays the detail pane and keeps the complete key table available', () => {
  // Tall enough for the whole wrapped help; shorter windows scroll it (tested below).
  const frame = renderFrame(model({ help: true, rows: 40 }));

  const text = framePlain(frame).join('\n');
  assert.match(framePlain(frame)[1], /Help  \? to close/);

  for (const value of [
    'Sessions',
    'Transcript',
    'Anywhere',
    'Mouse',
    'Tab/Shift+Tab switch panel',
    'Ctrl+D/Ctrl+U',
    'z fold all',
    'n next running session',
    'Ctrl+L redraw',
    'u check for and install updates',
    '? or Esc closes',
  ])
    assert.ok(text.includes(value), value);

  assert.match(text, /▾ Running/);
});

test('flattening expands only requested blocks and anchoring keeps the head row on screen', () => {
  const blocks = [
    { key: 'a', lines: ['a0'], full: ['a0', 'a1', 'a2'], expandable: true },
    { key: 'b', lines: ['b0'], full: ['b0', 'b1'], expandable: true },
  ];

  const closed = flattenBlocks(blocks);
  assert.deepEqual(closed.lines, ['a0', 'b0']);
  const open = flattenBlocks(blocks, { expanded: new Set(['a']) });
  assert.deepEqual(open.lines, ['a0', 'a1', 'a2', 'b0']);
  assert.equal(open.starts.get('b'), 3);
  assert.equal(blockKeyAt(open.keys, 1), 'a');
  assert.equal(moveBlockKey(open.starts, 'a', 1), 'b');
  assert.equal(moveBlockKey(open.starts, 'b', -1), 'a');
  assert.equal(moveBlockKey(open.starts, 'a', -1), 'a');
  assert.equal(moveBlockKey(open.starts, 'b', 1), 'b');

  // Expanding block b must keep its first line on the same screen row.
  const anchorClosed = flattenBlocks([
    { key: 'head', lines: ['head0', 'head1', 'head2', 'head3'], full: null, expandable: false },
    blocks[1],
  ]);
  const anchorExpanded = flattenBlocks(
    [
      { key: 'head', lines: ['head0', 'head1', 'head2', 'head3'], full: null, expandable: false },
      blocks[1],
    ],
    { expanded: new Set(['b']) },
  );

  const scroll = anchoredScroll(
    anchorClosed.starts.get('b'),
    2,
    anchorExpanded.starts.get('b'),
    100,
  );

  assert.equal(anchorExpanded.starts.get('b') - scroll, anchorClosed.starts.get('b') - 2);
  assert.equal(anchoredScroll(0, 0, 0, 100), 0);
});

test('block building is lazy: process blocks do not wrap every tool body up front', () => {
  const events = [
    { type: 'session', version: 4, id: 'x', cwd: '/work/x', createdAt: now },
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
  ];

  for (let index = 0; index < 40; index++) {
    events.push(
      {
        type: 'tool/call',
        seq: 2 + index * 2,
        time: now,
        data: {
          turn: 1,
          step: index,
          callId: `c${index}`,
          name: 'read_file',
          arguments: JSON.stringify({ path: `/work/x/${index}.mjs` }),
        },
      },
      {
        type: 'tool/result',
        seq: 3 + index * 2,
        time: now,
        data: {
          turn: 1,
          step: index,
          message: {
            role: 'tool',
            toolCallId: `c${index}`,
            content: [{ type: 'text', text: 'body '.repeat(200) }],
          },
        },
      },
    );
  }

  const blocks = buildBlocks(events, { view: 'process', columns: 80, st: styler(false) });
  assert.ok(blocks.length >= 40);

  const tool = blocks.find((block) => block.kind === 'tool');
  assert.ok(tool);

  // Accessing the collapsed form must not force the expanded body.
  assert.ok(Array.isArray(tool.lines));

  const flat = flattenBlocks(blocks);
  assert.ok(flat.lines.length < 80);

  const expanded = flattenBlocks(blocks, { expanded: new Set([tool.key]) });
  assert.ok(expanded.lines.length > flat.lines.length);
});

test('failed and aborted turn reasons have friendly status labels', () => {
  assert.equal(statusInfo('error').label, 'Failed');
  assert.equal(statusInfo('aborted').label, 'Aborted');
  for (const [state, label] of [
    ['error', 'Failed'],
    ['aborted', 'Aborted'],
  ]) {
    const selected = session(state, { state, title: `任务${label}` });
    const frame = renderFrame(model({ sessions: [selected], selectedId: state, selected }));
    assert.match(framePlain(frame)[1], new RegExp(`✗ ${label}`));
  }
});

test('geometry keeps the detail block width consistent with what layout paints', () => {
  for (const columns of [80, 100, 128, 200]) {
    const geo = geometry(columns);
    const frame = renderFrame(model({ columns, rows: 20, focus: 'detail' }));
    const panel = frame.hits.detailPanel,
      line = framePlain(frame)[2];
    const painted = columnsOf(line, panel.x0, panel.x1);

    assert.equal(
      displayWidth(painted),
      geo.detailWidth + 2,
      `${columns}: borders plus detail content`,
    );
    assert.equal(
      displayWidth(painted.slice(1, -1)),
      geo.detailWidth,
      `${columns}: painted content width`,
    );
  }

  const items = listItems({
    sessions: model().sessions,
    selectedId: 'b',
    listCursor: 'session:b',
    now,
  });
  assert.deepEqual(
    items.items.map((item) => item.key),
    [
      'group:running',
      'group:running:active',
      'session:b',
      'group:done',
      'group:day:2026-01-14',
      'session:a',
      'group:day:2026-01-12',
      'group:day:2026-01-03',
    ],
  );
});

test('a folded day group stays folded when a newer day appears', () => {
  const day = 86_400_000;
  const yesterday = session('day-15', { mtime: now - 10 * 60_000 });
  const older = session('day-14', { mtime: now - day });
  const toggled = new Map([['day:2026-01-15', true]]);

  const before = listItems({ sessions: [yesterday, older], toggledGroups: toggled, now });
  assert.ok(before.items.some((item) => item.key === 'group:day:2026-01-15' && item.collapsed));

  const latest = session('day-16', { mtime: now + day - 10 * 60_000 });
  const after = listItems({
    sessions: [latest, yesterday, older],
    toggledGroups: toggled,
    now: now + day,
  });

  assert.equal(
    after.collapsedOf('day:2026-01-16'),
    false,
    'the untouched newest day still starts open',
  );
  assert.equal(after.collapsedOf('day:2026-01-15'), true, 'the user-folded day stays folded');
});

test('ambiguous-width status icons count as one column, emoji and CJK as two', () => {
  for (const ch of '✓✗●◌·…‹›│╭▌') assert.equal(charWidth(ch.codePointAt(0)), 1, ch);
  for (const ch of '中【，✅❌⭐😀') assert.equal(charWidth(ch.codePointAt(0)), 2, ch);
});

test('the list scrolls with the cursor and keeps it inside the box', () => {
  const sessions = Array.from({ length: 30 }, (_, index) =>
    session(`s${index}`, { title: `任务${index}号`, mtime: now - index * 1000 }),
  );

  let top = 0;
  for (const index of [0, 10, 20, 29, 25, 3]) {
    const frame = renderFrame(
      model({
        sessions,
        selectedId: `s${index}`,
        selected: sessions[index],
        listCursor: `session:s${index}`,
        rows: 20,
        listTop: top,
      }),
    );
    top = frame.listTop;

    const plain = framePlain(frame);
    const row = plain.findIndex((line) => line.includes(`任务${index}号`) && line.startsWith('│▌'));

    // Screen rows 3..18 (0-based 2..17) are inside the list box.
    assert.ok(row >= 2 && row <= 17, `cursor ${index} visible inside the list box (row ${row})`);
    assert.ok(frame.hits.list.some((hit) => hit.key === `session:s${index}` && hit.y === row + 1));
  }
});

test('footer keeps help and quit at every width and drops lower-priority keys first', () => {
  for (const columns of [40, 60, 80, 100, 160]) {
    for (const focus of ['list', 'detail']) {
      const frame = renderFrame(model({ columns, focus }));
      const footer = framePlain(frame).at(-1);
      assert.equal(displayWidth(footer), columns);
      assert.match(footer, /\? +Help +q +Quit $/, `${columns} ${focus}`);
      assert.ok(frame.hits.footer.some((hit) => hit.key === '?'));
    }
  }

  const narrow = framePlain(renderFrame(model({ columns: 60 }))).at(-1);

  // Panel navigation outranks everything else when space is short.
  assert.match(narrow, /Enter +Open +Tab +Panel/);
  assert.doesNotMatch(narrow, /Follow/);
});

test('titles drop the bridge task label', () => {
  assert.equal(shortTitle('[dpsk-bridge] 重写 dsv'), '重写 dsv');
  assert.equal(shortTitle('普通任务'), '普通任务');
});

test('finished sessions linger in the running group, and a held session stays while viewed', () => {
  const ended = session('e', { title: '刚结束的任务', state: 'done', mtime: now - 30_000 });
  const old = session('o', { title: '早已结束', state: 'done', mtime: now - 10 * 60_000 });
  const stale = session('s', { title: '没人管的会话', state: 'quiet', mtime: now - 2 * 3600_000 });
  const quiet = session('q', { title: '暂时没动静', state: 'quiet', mtime: now - 6 * 60_000 });

  const keys = (held = new Set(), at = now) =>
    listItems({ sessions: [ended, old, stale, quiet], held, now: at }).items.map(
      (item) => item.key,
    );

  assert.deepEqual(keys(), [
    'group:running',
    'group:running:quiet',
    'session:q',
    'group:running:ended',
    'session:e',
    'group:done',
    'group:day:2026-01-15',
    'session:o',
    'session:s',
  ]);

  // Three minutes later the ended session has moved to 已完成 ...
  const later = keys(new Set(), now + 3 * 60_000);
  assert.ok(later.indexOf('session:e') > later.indexOf('group:done'));

  // ... unless it is held because the user is still looking at it.
  const held = keys(new Set(['e']), now + 3 * 60_000);
  assert.ok(held.indexOf('session:e') < held.indexOf('group:done'));
});

test('both top-level groups show even when empty', () => {
  assert.deepEqual(
    listItems({ sessions: [], now }).items.map((item) => item.key),
    ['group:running', 'group:done'],
  );
});

test('help wraps to the box width and scrolls when it does not fit', () => {
  for (const width of [30, 40, 78]) {
    const lines = helpView(width);
    for (const line of lines) assert.ok(displayWidth(line) <= width, `${width}: ${line}`);
    if (width < 70)
      assert.ok(lines.length > helpLines().length, 'long lines wrap instead of being cut');
  }

  const top = framePlain(
    renderFrame(model({ help: true, columns: 80, rows: 10, focus: 'detail' })),
  ).join('\n');

  assert.match(top, /Sessions +↑↓/);
  assert.doesNotMatch(top, /or Esc closes/);

  const bottom = framePlain(
    renderFrame(model({ help: true, columns: 80, rows: 10, focus: 'detail', helpScroll: 999 })),
  ).join('\n');

  assert.match(bottom, /or Esc closes/);
  assert.doesNotMatch(bottom, /Sessions +↑↓/);

  // While help is open the footer offers scrolling and closing.
  assert.match(
    framePlain(renderFrame(model({ help: true }))).at(-1),
    /Esc +Close help.*\? +Close +q +Quit/,
  );
});

test('footer Enter label follows the item under the cursor', () => {
  const onGroup = framePlain(renderFrame(model({ listCursor: 'group:done' }))).at(-1);
  assert.match(onGroup, /Enter +Fold/);
  assert.match(framePlain(renderFrame(model())).at(-1), /Enter +Open/);
});

test('the list never starts in the middle of a two-line session', () => {
  const sessions = Array.from({ length: 30 }, (_, index) =>
    session(`s${index}`, { title: `任务${index}号`, mtime: now - 3600_000 - index * 1000 }),
  );

  let top = 0;
  for (let index = 0; index < 30; index++) {
    const frame = renderFrame(
      model({
        sessions,
        selectedId: `s${index}`,
        selected: sessions[index],
        listCursor: `session:s${index}`,
        rows: 17,
        listTop: top,
      }),
    );
    top = frame.listTop;

    const firstRow = framePlain(frame)[2];
    assert.doesNotMatch(
      firstRow,
      /^│ {6,}\S+ +\d+ (min|h) ago/,
      `cursor ${index}: first list row is a session's second line`,
    );
  }
});
