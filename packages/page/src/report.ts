import type { Writable } from 'node:stream'
import process from 'node:process'
import { badUsage, role, wholeNumber } from '@kaynooo/cli-kit'

const MAX_PER_KIND = 10
const DEFAULT_WIDTHS = [1440, 400]

export interface Finding {
  target: string
  width: number
  kind: string
  // Absent for what belongs to the whole page, a console error or a failed request.
  selector?: string
  message: string
}

/** The `--widths` list, 1440 and 400 when not given. */
export function widthsOf(given: string | undefined): number[] {
  if (given === undefined)
    return DEFAULT_WIDTHS

  const widths = given.split(',').map(width => wholeNumber(width.trim(), 'widths', 0, 200))

  if (widths.some(width => width > 7680))
    badUsage(`--widths takes widths up to 7680, not ${given}`)

  return widths
}

/** One line per finding, at most ten of a kind per target and width, then how many more there were. */
export function findingLines(findings: Finding[], stream: { isTTY?: boolean } = process.stdout): string[] {
  const label = role('label', stream)
  const kind = role('warn', stream)
  const accent = role('accent', stream)
  const seen = new Map<string, number>()
  const lines: string[] = []

  for (const finding of findings) {
    const group = `${finding.target} ${finding.width}px ${finding.kind}`
    const count = (seen.get(group) ?? 0) + 1

    seen.set(group, count)

    if (count <= MAX_PER_KIND)
      lines.push(`${finding.target} ${label(`${finding.width}px`)} ${kind(finding.kind)}${finding.selector === undefined ? '' : ` ${accent(finding.selector)}`}: ${finding.message}`)
  }

  for (const [group, count] of seen) {
    if (count > MAX_PER_KIND)
      lines.push(`${group}: ${count - MAX_PER_KIND} more`)
  }

  return lines
}

export function printLines(lines: string[], stream: Writable = process.stdout): void {
  if (lines.length > 0)
    stream.write(`${lines.join('\n')}\n`)
}
