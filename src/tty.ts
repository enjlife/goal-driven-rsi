/** Background + foreground for echoed user input (dark gray bar, light text). */
const INPUT_STYLE = '\x1b[48;5;236;38;5;252m';
const RESET = '\x1b[0m';

/** Terminal display width of `s` (CJK / fullwidth / emoji count as 2 columns). */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || (c >= 0x7f && c < 0xa0) || (c >= 0x300 && c < 0x370) || c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f)) continue;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff) ||
      (c >= 0x20000 && c <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}

/**
 * Repaint the line the user just submitted (`prompt` + `line`, already echoed by
 * readline) with a dark full-width background, so input stands apart from agent
 * output. No-op unless stdin and stdout are both TTYs.
 */
export function highlightInput(prompt: string, line: string, out: NodeJS.WriteStream = process.stdout): void {
  if (!out.isTTY || !process.stdin.isTTY) return;
  const cols = out.columns || 80;
  const rows = Math.max(1, Math.ceil(displayWidth(prompt + line) / cols));
  // Cursor is at the start of the line below the input: go back up, clear, redraw.
  // `\x1b[K` with the background active fills the rest of the last row.
  out.write(`\x1b[${rows}A\r\x1b[J${INPUT_STYLE}${prompt}${line}\x1b[K${RESET}\n`);
}
