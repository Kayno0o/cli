import type { ExitRow } from '@kaynooo/cli-kit'
import type { Browser } from 'playwright-core'
import type { Session, Target } from './browser'
import type { Finding, ViewportSpec } from './report'
import type { Compared, Region } from './types'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import { formatPercent, jsonOption, marked, parse, printJson, role, warn, wholeNumber } from '@kaynooo/cli-kit'
import { launch, open, redirectedTo, SESSION_OPTIONS, sessionOf, shoot, targetOf } from './browser'
import { inPage } from './inpage'
import { findingLines, printLines, viewportsOf } from './report'

const THRESHOLD = 32

const EXITS: ExitRow[] = [[0, 'both pages look the same at every width'], [1, 'a region differs, or a page would not load'], [2, 'a usage error']]

const USAGE = `page diff <mockup> <built>

Shoots the mockup and the built page (HTML files or URLs) full-page at every viewport, then writes two PNGs per viewport (into the cache folder by default, or into --out): <name>-side-<width>.png and <name>-diff-<width>.png. Use --mask <selector> to mask dynamic regions (timestamps, avatars, charts) before diffing.
A pixel differs when a colour channel moves by more than --threshold (${THRESHOLD} of 255); a lone differing pixel in an 8px cell is taken for antialiasing and left out.

Exits 0 when both look the same at every width, 1 when a region differs or a page would not load, 2 on a usage error.`

const OPTIONS = {
  widths: { type: 'string', short: 'w', description: 'viewports, comma separated: W, WxH, or WxH@2x (1440,400)' },
  out: { type: 'string', short: 'o', description: 'folder the PNGs go to (default: cache folder)' },
  threshold: { type: 'string', description: `largest per-channel difference still counted as the same pixel, 0 to 255 (${THRESHOLD})` },
  mask: { type: 'string', multiple: true, description: 'CSS selector of dynamic regions masked before diffing, repeatable' },
  all: { type: 'boolean', description: 'print all differing regions instead of capping at 10' },
  ...SESSION_OPTIONS,
  json: jsonOption('[{width, side, overlay, mockupHeight, builtHeight, differing, regions: [{x, y, width, height}]}]'),
} as const

async function capture(browser: Browser, target: Target, viewport: ViewportSpec, session: Session, masks: readonly string[]): Promise<Buffer> {
  const { context, page, landed } = await open(browser, target.url, viewport, session)
  const redirect = redirectedTo(target.url, landed)

  if (redirect !== undefined)
    warn(`${target.label} landed on ${redirect} at ${viewport.label}`, 'the shot is of that page')

  try {
    return await shoot(page, undefined, masks)
  }
  finally {
    await context.close()
  }
}

function regionLine(region: Region): string {
  return `${region.width}×${region.height}px at ${region.x},${region.y}`
}

export async function diff(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, USAGE, OPTIONS, {
    positionals: ['<mockup>', '<built>'],
    exits: EXITS,
    examples: [['page diff mockup.html dist/index.html -o shots', 'writes index-side-1440.png and index-diff-1440.png into shots'], ['page diff mockup.html http://localhost:5173/ --mask .timestamp --dark', 'dark-mode diff ignoring dynamic timestamps']],
  })
  const [mockupGiven, builtGiven] = positionals
  const viewports = viewportsOf(values.widths)
  const threshold = wholeNumber(values.threshold, 'threshold', THRESHOLD, 0)
  const masks = values.mask ?? []
  const mockup = targetOf(mockupGiven, values.out)
  const built = targetOf(builtGiven, values.out)
  const session = sessionOf(values)
  const results: Compared[] = []
  const findings: Finding[] = []
  const path = role('path', process.stdout)
  const browser = await launch()

  try {
    const captured = await Promise.all(viewports.map(async (vp) => {
      const [left, right] = await Promise.all([capture(browser, mockup, vp, session, masks), capture(browser, built, vp, session, masks)])

      return { vp, left, right }
    }))
    const blank = await browser.newPage()

    for (const { vp, left, right } of captured) {
      const compared = await inPage<Compared>(blank, 'compare', 'compareImages', { mockup: left.toString('base64'), built: right.toString('base64'), threshold: Math.min(threshold, 255) })
      const side = `${built.stem}-side-${vp.suffix}.png`
      const overlay = `${built.stem}-diff-${vp.suffix}.png`

      mkdirSync(dirname(side), { recursive: true })
      await Bun.write(side, Buffer.from(compared.side, 'base64'))
      await Bun.write(overlay, Buffer.from(compared.overlay, 'base64'))
      results.push({ ...compared, width: vp.width, side, overlay })

      if (compared.mockupHeight !== compared.builtHeight)
        findings.push({ target: built.label, width: vp.width, kind: 'height', message: `the mockup is ${compared.mockupHeight}px tall, the built page ${compared.builtHeight}px` })

      for (const [index, region] of compared.regions.entries())
        findings.push({ target: built.label, width: vp.width, kind: 'region', selector: String(index + 1), message: regionLine(region) })

      if (!values.json) {
        console.log(path(side))
        console.log(path(overlay))
        console.log(compared.regions.length === 0
          ? marked('ok', `${vp.width}px: no region differs`, process.stdout)
          : marked('warn', `${vp.width}px: ${compared.regions.length} ${compared.regions.length === 1 ? 'region differs' : 'regions differ'}`, process.stdout, `${formatPercent(compared.differing, 1)} of the pixels`))
      }
    }
  }
  finally {
    await browser.close()
  }

  if (values.json)
    printJson(results)
  else
    printLines(findingLines(findings, process.stdout, values.all === true))

  return results.some(result => result.regions.length > 0) ? 1 : 0
}
