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

/** A heading per target, width and kind with its findings indented under it, a repeated one counted once, at most ten, then how many more there were. */
export function findingLines(findings: Finding[], stream: { isTTY?: boolean } = process.stdout): string[] {
  const label = role('label', stream)
  const kind = role('warn', stream)
  const accent = role('accent', stream)
  const groups = new Map<string, { heading: string, counts: Map<string, number> }>()

  for (const finding of findings) {
    const key = `${finding.target} ${finding.width} ${finding.kind}`
    const group = groups.get(key) ?? { heading: `${finding.target} ${label(`${finding.width}px`)} ${kind(finding.kind)}`, counts: new Map<string, number>() }
    const line = finding.selector === undefined ? finding.message : `${accent(finding.selector)}: ${finding.message}`

    group.counts.set(line, (group.counts.get(line) ?? 0) + 1)
    groups.set(key, group)
  }

  return [...groups.values()].flatMap(({ heading, counts }) => {
    const lines = [...counts].slice(0, MAX_PER_KIND).map(([line, count]) => `  ${line}${count > 1 ? ` ${label(`×${count}`)}` : ''}`)
    const more = counts.size - MAX_PER_KIND

    return [heading, ...lines, ...more > 0 ? [`  ${more} more`] : []]
  })
}

export function printLines(lines: string[], stream: Writable = process.stdout): void {
  if (lines.length > 0)
    stream.write(`${lines.join('\n')}\n`)
}
