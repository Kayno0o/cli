import { textWidth } from './format'

// A synchronized update: a terminal that supports it paints the frame written in between at once, others ignore both.
export const SYNC_START = '\x1B[?2026h'
export const SYNC_END = '\x1B[?2026l'

// Lines drawn over the rows they land on, each erasing only what is left of its row, so a terminal painting mid-write never shows the frame blank. A line filling its row leaves the cursor on the last cell, which an erase after it would take, so that one erases its row first.
export function overwrite(lines: readonly string[], columns: number): string {
  return lines.map(line => textWidth(line) < columns ? `${line}\x1B[K` : `\x1B[2K${line}`).join('\n')
}
