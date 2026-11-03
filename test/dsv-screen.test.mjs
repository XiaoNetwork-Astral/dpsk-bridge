import test from 'node:test';
import assert from 'node:assert/strict';

import { diffLines, createScreen } from '../lib/viewer/screen.mjs';

const SYNC = (body) => `\x1b[?2026h${body}\x1b[?2026l`;

test('line diff reports only changed rows and appends new rows', () => {
  assert.deepEqual(diffLines(['a', 'b', 'c'], ['a', 'B', 'c']), [{ row: 2, text: 'B' }]);
  assert.deepEqual(diffLines(['a', 'b'], ['a', 'b', 'c']), [{ row: 3, text: 'c' }]);
  assert.deepEqual(diffLines(['a', 'b'], ['a', 'b']), []);
});

test('screen writes absolute cursor moves for changed body rows and restores terminal state', () => {
  const chunks = [];
  const out = {
    write: (value) => {
      chunks.push(value);
      return true;
    },
  };

  const screen = createScreen({ out });
  screen.enter();
  const entered = chunks.join('');

  assert.ok(entered.includes('\x1b[?1049h'));
  assert.ok(entered.includes('\x1b[?1000h'));
  assert.ok(
    entered.includes('\x1b[?7l'),
    'auto-wrap is disabled so overflow cannot spill into the next row',
  );

  assert.equal(screen.draw(['a', 'b', 'c']), true);
  chunks.length = 0;
  assert.equal(screen.draw(['a', 'B', 'c']), true);
  assert.equal(
    chunks.join(''),
    SYNC('\x1b[2;1HB'),
    'only the changed row is written, in one synchronized write',
  );

  chunks.length = 0;
  assert.equal(screen.draw(['a', 'B', 'c']), false);
  assert.equal(chunks.length, 0);

  screen.restore();
  const restore = chunks.join('');
  for (const code of ['\x1b[?1006l', '\x1b[?1000l', '\x1b[?7h', '\x1b[?25h', '\x1b[?1049l'])
    assert.ok(restore.includes(code), JSON.stringify(code));
});

test('clear repaints every row together with the next frame', () => {
  const chunks = [];
  const screen = createScreen({
    out: {
      write: (value) => {
        chunks.push(value);
        return true;
      },
    },
  });

  screen.draw(['a', 'b']);
  chunks.length = 0;

  screen.clear();
  assert.equal(chunks.length, 0, 'nothing is written until the next frame');

  assert.equal(screen.draw(['a', 'b']), true, 'an identical frame is still repainted after clear');
  assert.equal(chunks.join(''), SYNC('\x1b[2J\x1b[1;1Ha\x1b[2;1Hb'));
});

test('shrinking a frame clears rows below the new content', () => {
  const chunks = [];
  const screen = createScreen({
    out: {
      write: (value) => {
        chunks.push(value);
        return true;
      },
    },
  });

  screen.draw(['a', 'b', 'c']);
  chunks.length = 0;

  assert.equal(screen.draw(['a']), true);
  assert.ok(chunks.join('').includes('\x1b[2;1H\x1b[0J'));
});
