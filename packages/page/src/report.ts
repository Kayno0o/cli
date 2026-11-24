import type { Writable } from 'node:stream'
import process from 'node:process'
import { badUsage, role, wholeNumber } from '@kaynooo/cli-kit'

const MAX_PER_KIND = 10
const DEFAULT_HEIGHT = 900
const VIEWPORT_TOKEN = /^(\d+)(?:x(\d+))?(?:@(\d+(?:\.\d+)?)x?)?$/i

export interface ViewportSpec {
  width: number
  height: number
  scale: number
  /** Short suffix used in screenshot filenames, e.g. `1440` or `1280x720@2x`. */
  suffix: string
  /** Display label, e.g. `1440px` or `1280×720@2x`. */
  label: string
}

const DEFAULT_VIEWPORTS: ViewportSpec[] = [
  { width: 1440, height: DEFAULT_HEIGHT, scale: 1, suffix: '1440', label: '1440px' },
  { width: 400, height: DEFAULT_HEIGHT, scale: 1, suffix: '400', label: '400px' },
]

export interface Finding {
  target: string
  width: number
  kind: string
  // Absent for what belongs to the whole page, a console error or a failed request.
  selector?: string
  message: string
}

/** Parses `--widths` entries of the form `W`, `WxH`, `W@2x`, or `WxH@2x` (default: 1440 and 400). */
export function viewportsOf(given: string | undefined): ViewportSpec[] {
  if (given === undefined)
    return DEFAULT_VIEWPORTS

  return given.split(',').map((raw) => {
    const token = raw.trim()
    const match = VIEWPORT_TOKEN.exec(token)

    if (match === null)
      badUsage(`--widths takes W, WxH, or WxH@2x (e.g. 1440,390x844@2x), not ${token}`)

    const width = wholeNumber(match[1], 'widths', 0, 200)
    const height = match[2] === undefined ? DEFAULT_HEIGHT : wholeNumber(match[2], 'widths', DEFAULT_HEIGHT, 200)
    const scale = match[3] === undefined ? 1 : Number(match[3])

    if (width > 7680 || height > 7680)
      badUsage(`--widths takes dimensions up to 7680, not ${given}`)

    if (!Number.isFinite(scale) || scale < 1 || scale > 4)
      badUsage(`--widths takes scale factors from 1 to 4, not ${token}`)

    const hasCustomHeight = match[2] !== undefined
    const hasCustomScale = match[3] !== undefined && scale !== 1
    const suffix = `${width}${hasCustomHeight ? `x${height}` : ''}${hasCustomScale ? `@${scale}x` : ''}`
    const label = `${width}${hasCustomHeight ? `×${height}` : ''}${hasCustomScale ? `@${scale}x` : 'px'}`

    return { width, height, scale, suffix, label }
  })
}

/** The `--widths` list as plain width numbers, 1440 and 400 when not given. */
export function widthsOf(given: string | undefined): number[] {
  return viewportsOf(given).map(vp => vp.width)
}

/** A heading per target, width and kind with its findings indented under it, a repeated one counted once, at most ten (or all with `all = true`), then how many more there were. */
export function findingLines(findings: Finding[], stream: { isTTY?: boolean } = process.stdout, all = false): string[] {
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
    const cap = all ? counts.size : MAX_PER_KIND
    const lines = [...counts].slice(0, cap).map(([line, count]) => `  ${line}${count > 1 ? ` ${label(`×${count}`)}` : ''}`)
    const more = counts.size - cap

    return [heading, ...lines, ...more > 0 ? [`  ${more} more`] : []]
  })
}

export function printLines(lines: string[], stream: Writable = process.stdout): void {
  if (lines.length > 0)
    stream.write(`${lines.join('\n')}\n`)
}
