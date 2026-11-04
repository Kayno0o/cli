import process from 'node:process'
import { paint } from '@kaynooo/cli-kit'

// The status letter in the colour of what it did: added green, modified yellow, deleted or conflicting red, renamed cyan.
export function letter(status: string, stream: { isTTY?: boolean } = process.stdout): string {
  const colors = paint(stream)
  const tint = { A: colors.green, M: colors.yellow, D: colors.red, U: colors.red, R: colors.cyan, C: colors.cyan }[status] ?? colors.dim

  return tint(status)
}
