import type { ExitRow } from '@kaynooo/cli-kit'
import type { Page } from 'playwright-core'
import type { Finding } from './report'
import type { DomFinding } from './types'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import { measureContrast } from '@kaynooo/audit-engine/contrast'
import { badUsage, jsonOption, marked, parse, printJson, problem, role } from '@kaynooo/cli-kit'
import { launch, open, PHONE_WIDTH, redirectedTo, SESSION_OPTIONS, sessionOf, shoot, targetOf } from './browser'
import { fontFindings } from './fonts'
import { beforeLoad, inPage } from './inpage'
import { findingLines, printLines, widthsOf } from './report'

const KINDS = ['redirect', 'overflow', 'console', 'request', 'font', 'contrast', 'tap-target', 'padding', 'wrap', 'image', 'layout-shift'] as const
// What a page does the same at every width, so it is reported once, at the first width it shows at.
const ONCE = new Set(['redirect', 'console', 'request', 'font', 'contrast'])
const URL_CAP = 160

const EXITS: ExitRow[] = [[0, 'nothing found'], [1, 'a defect was found'], [2, 'a usage error, or a target that would not load']]

const USAGE = `page check <file|url>...

Opens each HTML file or URL in a local Chromium at every width, writes a full-page PNG per width (next to a file as <name>-<width>.png, into --out, or the cache folder for a URL) and prints its path, then one line per defect: <target> <width>px <kind> <selector>: <measure>.
Kinds: redirect (the page landed elsewhere, a login page say, so what follows is about that page), overflow (the page scrolls sideways; the elements where it starts), console (errors and uncaught exceptions), request (failed, or answered 4xx/5xx), font (text drawn in another font than its stack asks for, naming the one drawn), contrast (text under WCAG AA, 4.5:1 or 3:1 for large text; text over an image, a gradient or a filter is left out), tap-target (under 44px below ${PHONE_WIDTH}px wide, under 24px otherwise; a link inside a sentence is exempt), padding (text touching the border or background edge of its box), wrap (a word broken between two letters, in a column too narrow for it), image (did not load), layout-shift (a score above 0.1).
It never starts or builds an app: give it a file or a URL already served. A page behind a login takes --cookie, -H or --storage-state; a header goes to the target's origin alone.
Chromium comes from PAGE_CHROMIUM, ~/.cache/ms-playwright or /usr/bin, never downloaded.

Exits 0 when nothing is found, 1 when something is, 2 on a usage error or when a target would not load.`

const OPTIONS = {
  widths: { type: 'string', short: 'w', description: 'viewport widths, comma separated (1440,400)' },
  out: { type: 'string', short: 'o', description: 'folder the PNGs go to instead of next to each file' },
  skip: { type: 'string', description: `kinds left out, comma separated: ${KINDS.join(', ')}` },
  ...SESSION_OPTIONS,
  json: jsonOption('{shots: [{target, width, path}], findings: [{target, width, kind, selector, message}], failed: [{target, error}]}'),
} as const

interface Shot {
  target: string
  width: number
  path: string
}

function shortUrl(url: string): string {
  return url.length > URL_CAP ? `${url.slice(0, URL_CAP - 3)}...` : url
}

// Console errors and failed requests, gathered while the page loads; a console line about a failed resource repeats the request one, so it is left out.
function listen(page: Page, into: Omit<Finding, 'target' | 'width'>[]): void {
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource'))
      into.push({ kind: 'console', message: message.text() })
  })
  page.on('pageerror', error => into.push({ kind: 'console', message: `uncaught ${error.name}: ${error.message}` }))
  page.on('requestfailed', request => into.push({ kind: 'request', message: `${request.method()} ${shortUrl(request.url())} failed: ${request.failure()?.errorText ?? 'no answer'}` }))
  page.on('response', (response) => {
    if (response.status() >= 400)
      into.push({ kind: 'request', message: `${response.request().method()} ${shortUrl(response.url())} answered ${response.status()}` })
  })
}

async function contrastFindings(page: Page): Promise<Omit<Finding, 'target' | 'width'>[]> {
  const { failures } = await measureContrast(page)

  return failures.map(({ selector, fg, bg, ratio, required }) => ({ kind: 'contrast', selector, message: `${fg} on ${bg}, ${ratio.toFixed(2)}:1, needs ${required}:1` }))
}

export async function check(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, USAGE, OPTIONS, {
    positionals: ['<file|url>...'],
    exits: EXITS,
    examples: [['page check mockup.html', 'mockup-1440.png and mockup-400.png beside it, then the defects'], ['page check http://localhost:5173/settings --cookie session=<value>', 'a page behind a login'], 'page check http://localhost:5173/settings -w 1280,768,375 -o shots', 'page check index.html --skip font,padding --json'],
  })
  const widths = widthsOf(values.widths)
  const skipped = new Set(values.skip?.split(',').map(kind => kind.trim()) ?? [])
  const unknown = [...skipped].find(kind => !(KINDS as readonly string[]).includes(kind))

  if (unknown !== undefined)
    badUsage(`--skip takes ${KINDS.join(', ')}, not ${unknown}`)

  const targets = positionals.map(given => targetOf(given, values.out))
  const session = sessionOf(values)
  const shots: Shot[] = []
  const findings: Finding[] = []
  const failed: { target: string, error: string }[] = []
  const path = role('path', process.stdout)
  const browser = await launch()

  try {
    for (const target of targets) {
      const once = new Set<string>()

      for (const width of widths) {
        const heard: Omit<Finding, 'target' | 'width'>[] = []
        let loaded

        try {
          loaded = await open(browser, target.url, width, session, async (page) => {
            listen(page, heard)
            await beforeLoad(page, 'measure', 'watchShifts')
          })
        }
        catch (error) {
          const { message } = error as Error

          failed.push({ target: target.label, error: message.includes('\n') ? message.slice(0, message.indexOf('\n')) : message })

          break
        }

        const { context, page, landed } = loaded
        const redirect = redirectedTo(target.url, landed)

        if (redirect !== undefined)
          heard.unshift({ kind: 'redirect', message: `landed on ${shortUrl(redirect)}` })

        const file = `${target.stem}-${width}.png`

        mkdirSync(dirname(file), { recursive: true })
        await shoot(page, file)
        shots.push({ target: target.label, width, path: file })

        if (!values.json)
          console.log(path(file))

        const found = [...heard, ...await inPage<DomFinding[]>(page, 'measure', 'measureDom', width < PHONE_WIDTH), ...skipped.has('font') ? [] : await fontFindings(page), ...skipped.has('contrast') ? [] : await contrastFindings(page)]

        await context.close()

        for (const finding of found) {
          const key = `${finding.kind}|${finding.selector ?? ''}|${finding.message}`

          if (skipped.has(finding.kind) || (ONCE.has(finding.kind) && once.has(key)))
            continue

          once.add(key)
          findings.push({ target: target.label, width, ...finding })
        }
      }
    }
  }
  finally {
    await browser.close()
  }

  if (values.json) {
    printJson({ shots, findings, failed })
  }
  else {
    printLines(findingLines(findings))

    for (const { target, error } of failed)
      problem(`${target} would not load`, error)

    if (findings.length === 0 && failed.length === 0)
      console.log(marked('ok', `no defect at ${widths.join(', ')}px`, process.stdout))
  }

  if (failed.length > 0)
    return 2

  return findings.length > 0 ? 1 : 0
}
