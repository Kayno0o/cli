import type { ExitRow } from '@kaynooo/cli-kit'
import type { Browser } from 'playwright-core'
import type { Session, Target } from './browser'
import type { Finding } from './report'
import type { LayoutBox } from './types'
import process from 'node:process'
import { jsonOption, marked, parse, printJson, warn } from '@kaynooo/cli-kit'
import { launch, open, redirectedTo, SESSION_OPTIONS, sessionOf, targetOf } from './browser'
import { inPage } from './inpage'
import { layoutShifts } from './layout'
import { findingLines, printLines, widthsOf } from './report'

const EXITS: ExitRow[] = [[0, 'no element moved or resized at any width'], [1, 'something shifted, or a page would not load'], [2, 'a usage error']]

const USAGE = `page shift <before> <after>

Loads both pages (HTML files or URLs) at every width, pairs their elements and prints one line per cause of a change: <after> <width>px <kind> <selector>: <change>, pushing <n> elements.
Kinds: resized (with both sizes), moved (its offset from its parent and its gap to its previous sibling both changed, a margin say), added, removed. An element that keeps its offset from its parent or its gap to its previous sibling was pushed, and is counted in the cause it follows instead of getting a line; so is a box resized by what changed inside it, or whose width follows its parent's.
Elements pair by id, then by tag with their text or accessible name when unique on both pages, then by tag in order under parents already paired; so two builds of one page pair throughout, and a mockup against a built app pairs on its headings, labels and buttons, what is left being reported as added and removed.
A page behind a login takes --cookie, -H or --storage-state, as page check does; a page landing elsewhere is warned about on stderr.

Exits 0 when nothing shifted at any width, 1 when something did or a page would not load, 2 on a usage error.`

const OPTIONS = {
  widths: { type: 'string', short: 'w', description: 'viewport widths, comma separated (1440,400)' },
  ...SESSION_OPTIONS,
  json: jsonOption('[{target, width, kind, selector, message}]'),
} as const

async function boxesOf(browser: Browser, target: Target, width: number, session: Session): Promise<LayoutBox[]> {
  const { context, page, landed } = await open(browser, target.url, width, session)
  const redirect = redirectedTo(target.url, landed)

  if (redirect !== undefined)
    warn(`${target.label} landed on ${redirect} at ${width}px`, 'its layout is that page\'s')

  try {
    return await inPage<LayoutBox[]>(page, 'measure', 'layoutBoxes')
  }
  finally {
    await context.close()
  }
}

export async function shift(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, USAGE, OPTIONS, {
    positionals: ['<before>', '<after>'],
    exits: EXITS,
    examples: [['page shift before.html after.html', 'what a CSS change moved, by cause'], ['page shift mockup.html http://localhost:5173/ -w 1280', 'the built page against its mockup']],
  })
  const [beforeGiven, afterGiven] = positionals
  const widths = widthsOf(values.widths)
  // Neither writes a file, so no --out.
  const before = targetOf(beforeGiven, undefined)
  const after = targetOf(afterGiven, undefined)
  const session = sessionOf(values)
  const findings: Finding[] = []
  const browser = await launch()

  try {
    for (const width of widths) {
      const [a, b] = await Promise.all([boxesOf(browser, before, width, session), boxesOf(browser, after, width, session)])

      for (const { kind, selector, message, pushed } of layoutShifts(a, b))
        findings.push({ target: after.label, width, kind, selector, message: pushed === 0 ? message : `${message}, pushing ${pushed} ${pushed === 1 ? 'element' : 'elements'}` })
    }
  }
  finally {
    await browser.close()
  }

  if (values.json)
    printJson(findings)
  else if (findings.length === 0)
    console.log(marked('ok', `nothing moved or resized at ${widths.join(', ')}px`, process.stdout))
  else
    printLines(findingLines(findings))

  return findings.length > 0 ? 1 : 0
}
