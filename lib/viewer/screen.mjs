/**
 * Minimal alternate-screen writer. Frames are diffed line by line; only rows
 * whose content changed are rewritten, always with an absolute cursor move.
 *
 * Like btop, the screen runs with auto-wrap off (DECAWM, ?7l): a row that a
 * terminal measures one column wider than we do then overwrites its own last
 * cell instead of wrapping into the next row and corrupting the layout. Each
 * frame is sent in one write inside synchronized output (?2026), which
 * terminals that support it paint atomically and others ignore.
 */
const ENTER = '\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[H';
const RESTORE = '\x1b[?1006l\x1b[?1000l\x1b[?7h\x1b[?25h\x1b[0m\x1b[?1049l';
const SYNC_BEGIN = '\x1b[?2026h', SYNC_END = '\x1b[?2026l';

/** @returns {Array<{row: number, text: string}>} changed rows (1-based). */
export function diffLines(previous, next) {
  const changes = [];
  for (let index = 0; index < next.length; index++) {
    if (previous[index] !== next[index]) changes.push({ row: index + 1, text: next[index] });
  }
  return changes;
}

export function createScreen({ out = process.stdout } = {}) {
  let previous = [], entered = false, restored = false, pendingClear = false;
  const write = value => { try { out.write(value); } catch {} };
  return {
    enter() {
      if (entered) return;
      entered = true; restored = false;
      write(ENTER);
      previous = [];
    },
    /** Draw a complete frame; returns true when at least one line was written. */
    draw(lines) {
      const next = lines.map(line => String(line));
      const changes = diffLines(previous, next);
      const shrank = previous.length > next.length;
      if (!changes.length && !shrank && !pendingClear) return false;
      // A clear is sent with the following frame, so the terminal never shows
      // an empty screen between the two.
      let buffer = pendingClear ? '\x1b[2J' : '';
      pendingClear = false;
      for (const change of changes) buffer += `\x1b[${change.row};1H${change.text}`;
      if (shrank) buffer += `\x1b[${next.length + 1};1H\x1b[0J`;
      write(SYNC_BEGIN + buffer + SYNC_END);
      previous = next;
      return true;
    },
    /** Forget what is on screen; the next draw clears and repaints every row. */
    clear() {
      pendingClear = true;
      previous = [];
    },
    restore() {
      if (restored) return;
      restored = true; entered = false; previous = [];
      write(RESTORE);
    },
    get previous() { return previous; },
  };
}
