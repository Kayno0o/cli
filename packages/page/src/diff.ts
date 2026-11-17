import type { ExitRow } from '@kaynooo/cli-kit'
import type { Browser } from 'playwright-core'
import type { Finding } from './report'
import type { Compared, Region } from './types'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import { formatPercent, jsonOption, marked, parse, printJson, role, wholeNumber } from '@kaynooo/cli-kit'
import { launch, open, shoot, targetOf } from './browser'
import { inPage } from './inpage'
import { findingLines, printLines, widthsOf } from './report'

const THRESHOLD = 32

const EXITS: ExitRow[] = [[0, 'both pages look the same at every width'], [1, 'a region differs, or a page would not load'], [2, 'a usage error']]

const USAGE = `page diff <mockup> <built>

Shoots the mockup and the built page (HTML files or URLs) full-page at every width, then writes two PNGs per width next to the built file, into --out, or the cache folder for a URL: <name>-side-<width>.png, the mockup left and the built page right, and <name>-diff-<width>.png, the built page faded with every differing pixel in red. The differing regions are boxed and numbered on both, then printed one line each: <built> <width>px region <n>: <width>×<height>px at <x>,<y>.
A pixel differs when a colour channel moves by more than --threshold (${THRESHOLD} of 255); a lone differing pixel in an 8px cell is taken for antialiasing and left out.

Exits 0 when both look the same at every width, 1 when a region differs or a page would not load, 2 on a usage error.`

const OPTIONS = {
  widths: { type: 'string', short: 'w', description: 'viewport widths, comma separated (1440,400)' },
  out: { type: 'string', short: 'o', description: 'folder the PNGs go to instead of next to the built file' },
  threshold: { type: 'string', description: `largest per-channel difference still counted as the same pixel, 0 to 255 (${THRESHOLD})` },
  json: jsonOption('[{width, side, overlay, mockupHeight, builtHeight, differing, regions: [{x, y, width, height}]}]'),
} as const

async function capture(browser: Browser, url: string, width: number): Promise<Buffer> {
  const { context, page } = await open(browser, url, width)

  try {
    return await shoot(page)
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
    examples: [['page diff mockup.html dist/index.html', 'index-side-1440.png, index-diff-1440.png and the 400px pair'], 'page diff mockup.html http://localhost:5173/ -w 1280 -o shots'],
  })
  const [mockupGiven, builtGiven] = positionals
  const widths = widthsOf(values.widths)
  const threshold = wholeNumber(values.threshold, 'threshold', THRESHOLD, 0)
  const mockup = targetOf(mockupGiven, values.out)
  const built = targetOf(builtGiven, values.out)
  // With the PNGs' paths in place of their content.
  const results: Compared[] = []
  const findings: Finding[] = []
  const path = role('path', process.stdout)
  const browser = await launch()

  try {
    const blank = await browser.newPage()

    for (const width of widths) {
      const [left, right] = await Promise.all([capture(browser, mockup.url, width), capture(browser, built.url, width)])
      const compared = await inPage<Compared>(blank, 'compare', 'compareImages', { mockup: left.toString('base64'), built: right.toString('base64'), threshold: Math.min(threshold, 255) })
      const side = `${built.stem}-side-${width}.png`
      const overlay = `${built.stem}-diff-${width}.png`

      mkdirSync(dirname(side), { recursive: true })
      await Bun.write(side, Buffer.from(compared.side, 'base64'))
      await Bun.write(overlay, Buffer.from(compared.overlay, 'base64'))
      results.push({ ...compared, side, overlay })

      if (compared.mockupHeight !== compared.builtHeight)
        findings.push({ target: built.label, width, kind: 'height', message: `the mockup is ${compared.mockupHeight}px tall, the built page ${compared.builtHeight}px` })

      for (const [index, region] of compared.regions.entries())
        findings.push({ target: built.label, width, kind: 'region', selector: String(index + 1), message: regionLine(region) })

      if (!values.json) {
        console.log(path(side))
        console.log(path(overlay))
        console.log(compared.regions.length === 0
          ? marked('ok', `${width}px: no region differs`, process.stdout)
          : marked('warn', `${width}px: ${compared.regions.length} ${compared.regions.length === 1 ? 'region differs' : 'regions differ'}`, process.stdout, `${formatPercent(compared.differing, 1)} of the pixels`))
      }
    }
  }
  finally {
    await browser.close()
  }

  if (values.json)
    printJson(results)
  else
    printLines(findingLines(findings))

  return results.some(result => result.regions.length > 0) ? 1 : 0
}
