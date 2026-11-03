/**
 * Terminal text helpers shared by the viewer. Everything that comes from a
 * session log must pass through safeText before it reaches a terminal.
 */

const OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const C0 = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

export const stripAnsi = (value) =>
  String(value ?? '')
    .replace(CSI, '')
    .replace(OSC, '');

/** Remove terminal control sequences and non-printing controls from log text. */
export function safeText(value) {
  return String(value ?? '')
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ')
    .replace(C0, '');
}

// Wide (2-column) ranges: East Asian Wide/Fullwidth plus the symbols that have
// default emoji presentation. Ambiguous-width characters (box drawing, ·, …,
// ●, ‹›, ✓, ✗) stay narrow, as Windows Terminal, VS Code and most Unix
// terminals render them. Treating all of U+2600–U+27BF as wide used to shift
// every row containing ✓ one column left in real terminals.
const WIDE = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x17000, 0x18cff],
  [0x1b000, 0x1b2ff],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f251],
  [0x1f300, 0x1f320],
  [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2],
  [0x1f6d5, 0x1f6d7],
  [0x1f6dc, 0x1f6df],
  [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc],
  [0x1f7e0, 0x1f7eb],
  [0x1f7f0, 0x1f7f0],
  [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945],
  [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
];

function isWideCp(cp) {
  let lo = 0,
    hi = WIDE.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1,
      [start, end] = WIDE[mid];
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Display width of one code point (0, 1 or 2 columns). */
export function charWidth(cp) {
  if (!Number.isFinite(cp) || cp <= 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0x200b ||
    cp === 0x200c ||
    cp === 0x200d
  )
    return 0;
  return cp >= 0x1100 && isWideCp(cp) ? 2 : 1;
}

export function displayWidth(value) {
  let width = 0;
  for (const ch of stripAnsi(value)) width += charWidth(ch.codePointAt(0));
  return width;
}

/** Collapse whitespace and cut to `max` display columns. */
export function cut(value, max, ellipsis = '…') {
  const text = safeText(value).replace(/\s+/g, ' ').trim();
  return truncate(text, max, ellipsis);
}

/** Cut to `max` display columns without changing interior whitespace. */
export function truncate(value, max, ellipsis = '…') {
  const text = String(value ?? '');
  if (max <= 0) return '';
  if (displayWidth(text) <= max) return text;
  const room = Math.max(0, max - displayWidth(ellipsis));
  let out = '',
    width = 0;
  for (const ch of text) {
    const next = charWidth(ch.codePointAt(0));
    if (width + next > room) break;
    out += ch;
    width += next;
  }
  return out + ellipsis;
}

/**
 * Truncate/pad an ANSI-styled string to exactly `width` columns. When `bg` is
 * supplied it is applied after every reset, so highlighted rows keep their
 * background even when the embedded text contains its own SGR codes.
 */
export function fitAnsi(value, width, bg = '') {
  const text = String(value ?? '');
  let out = bg,
    columns = 0;
  for (let index = 0; index < text.length;) {
    if (text[index] === '\x1b') {
      const match = /^\x1b\[[0-9;]*m/.exec(text.slice(index));
      if (match) {
        out += match[0] === '\x1b[0m' ? match[0] + bg : match[0];
        index += match[0].length;
        continue;
      }
    }
    const cp = text.codePointAt(index),
      ch = String.fromCodePoint(cp),
      next = charWidth(cp);
    if (columns + next > width) break;
    out += ch;
    columns += next;
    index += ch.length;
  }
  out += ' '.repeat(Math.max(0, width - columns));
  return bg || out.includes('\x1b') ? out + '\x1b[0m' : out;
}

/** Wrap plain text to `width` columns, retaining existing line breaks. */
export function wrapText(value, width) {
  const max = Math.max(1, Math.floor(width));
  const out = [];
  for (const paragraph of safeText(value).split('\n')) {
    let line = '',
      columns = 0;
    for (const token of paragraph.split(/(\s+)/)) {
      if (!token) continue;
      const tokenWidth = displayWidth(token);
      if (columns + tokenWidth <= max) {
        line += token;
        columns += tokenWidth;
        continue;
      }
      if (/^\s+$/.test(token)) {
        out.push(line.trimEnd());
        line = '';
        columns = 0;
        continue;
      }
      if (tokenWidth <= max && columns > 0) {
        out.push(line.trimEnd());
        line = token;
        columns = tokenWidth;
        continue;
      }
      for (const ch of token) {
        const next = charWidth(ch.codePointAt(0));
        if (columns + next > max && columns > 0) {
          out.push(line.trimEnd());
          line = '';
          columns = 0;
        }
        line += ch;
        columns += next;
      }
    }
    out.push(line.trimEnd());
  }
  while (out.length > 1 && !out[out.length - 1]) out.pop();
  return out.length ? out : [''];
}

/** Build a no-op or SGR styler. Layout and block builders take this object. */
export function styler(enabled = true) {
  const paint = (code) => (value) => (enabled ? `\x1b[${code}m${value}\x1b[0m` : String(value));
  return {
    enabled,
    bold: paint('1'),
    dim: paint('2'),
    ital: paint('2;3'),
    underline: paint('4'),
    red: paint('91'),
    green: paint('92'),
    yellow: paint('93'),
    blue: paint('94'),
    magenta: paint('95'),
    cyan: paint('96'),
    gray: paint('90'),
    inverse: paint('7'),
    tabActive: paint('30;46'),
    selected: paint('48;5;236'),
    // Footer key chips: clickable, informational only, and switched-on toggle.
    key: paint('1;97;48;5;238'),
    keyIdle: paint('37;48;5;236'),
    keyOn: paint('1;30;42'),
    bgSelected: enabled ? '\x1b[48;5;236m' : '',
  };
}

const two = (value) => String(value).padStart(2, '0');

/** Local date and time, e.g. 2026-11-2 09:05 (dates are not zero-padded). */
export const when = (time) => {
  if (!time) return '';
  const date = new Date(time);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()} ${two(date.getHours())}:${two(date.getMinutes())}`;
};

export function ago(time, now = Date.now()) {
  if (!time) return '';
  const seconds = Math.max(0, (now - time) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return when(time);
}

/** Wrap width for transcript text: the pane width minus the indent and gutter. */
export const bodyColumns = (columns) => Math.max(14, columns - 4);
