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
import { findingLines, printLines, viewportsOf } from './report'

const KINDS = ['redirect', 'overflow', 'console', 'request', 'font', 'contrast', 'tap-target', 'padding', 'wrap', 'clip', 'spill', 'overlap', 'text-size', 'stretch', 'double-border', 'image', 'layout-shift', 'a11y', 'head'] as const
const DOM_KINDS = new Set(['overflow', 'tap-target', 'padding', 'wrap', 'clip', 'spill', 'overlap', 'text-size', 'stretch', 'double-border', 'image', 'layout-shift', 'a11y', 'head'])
// What a page does the same at every width, so it is reported once, at the first width it shows at.
const ONCE = new Set(['redirect', 'console', 'request', 'font', 'contrast', 'a11y', 'head'])
const URL_CAP = 160

const EXITS: ExitRow[] = [[0, 'nothing found'], [1, 'a defect was found'], [2, 'a usage error, or a target that would not load']]

const USAGE = `page check <file|url>...

Opens each HTML file or URL in a local Chromium at every viewport (parallel contexts per target), writes a full-page PNG per viewport (into the cache folder by default, or into --out; skip with --no-shots) and prints its path, then a <target> <width>px <kind> line per kind found with its defects under it.
Kinds: redirect, overflow, console, request, font, contrast, tap-target, padding, wrap, clip, spill, overlap, text-size, stretch, double-border, image, layout-shift, a11y (missing img alt, unlabeled inputs, skipped headings, multiple h1), head (missing title, non-UTF-8 charset, zoom-blocking viewport, empty meta description).
Viewports take W, WxH, or WxH@2x (default: 1440,400). Use --dark, --wait-for <selector>, --delay <ms>, and --click/--hover/--fill/--focus to inspect interactive or dark-mode states.
Chromium comes from PAGE_CHROMIUM, ~/.cache/ms-playwright or /usr/bin, never downloaded.

Exits 0 when nothing is found, 1 when something is, 2 on a usage error or when a target would not load.`

const OPTIONS = {
  'widths': { type: 'string', short: 'w', description: 'viewports, comma separated: W, WxH, or WxH@2x (1440,400)' },
  'out': { type: 'string', short: 'o', description: 'folder the PNGs go to (default: cache folder)' },
  'no-shots': { type: 'boolean', description: 'skip writing screenshot PNGs' },
  'only': { type: 'string', description: `run only these kinds, comma separated: ${KINDS.join(', ')}` },
  'skip': { type: 'string', description: `kinds left out, comma separated: ${KINDS.join(', ')}` },
  'all': { type: 'boolean', description: 'print all findings per kind instead of capping at 10' },
  ...SESSION_OPTIONS,
  'json': jsonOption('{shots: [{target, width, path}], findings: [{target, width, kind, selector, message}], failed: [{target, error}]}'),
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

function activeKinds(only: string | undefined, skip: string | undefined): Set<string> {
  const all = new Set<string>(KINDS)

  if (only !== undefined) {
    const picked = only.split(',').map(kind => kind.trim()).filter(Boolean)
    const unknown = picked.find(kind => !all.has(kind))

    if (unknown !== undefined)
      badUsage(`--only takes ${KINDS.join(', ')}, not ${unknown}`)

    all.clear()

    for (const kind of picked)
      all.add(kind)
  }

  for (const kind of skip?.split(',').map(item => item.trim()).filter(Boolean) ?? []) {
    if (!(KINDS as readonly string[]).includes(kind))
      badUsage(`--skip takes ${KINDS.join(', ')}, not ${kind}`)

    all.delete(kind)
  }

  return all
}

export async function check(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, USAGE, OPTIONS, {
    positionals: ['<file|url>...'],
    exits: EXITS,
    examples: [
      ['page check mockup.html', 'checks at 1440 and 400px, screenshots cached unless -o is passed'],
      ['page check http://localhost:5173/ --dark --only contrast --no-shots', 'dark-mode contrast check without writing files'],
      ['page check http://localhost:5173/ -w 1280x800@2x,390x844@2x --wait-for main', 'HiDPI viewports with SPA selector wait'],
    ],
  })
  const viewports = viewportsOf(values.widths)
  const active = activeKinds(values.only, values.skip)
  const runDom = [...active].some(kind => DOM_KINDS.has(kind))
  const runFont = active.has('font')
  const runContrast = active.has('contrast')
  const noShots = values['no-shots'] === true
  const targets = positionals.map(given => targetOf(given, values.out))
  const session = sessionOf(values)
  const shots: Shot[] = []
  const findings: Finding[] = []
  const failed: { target: string, error: string }[] = []
  const path = role('path', process.stdout)
  const browser = await launch()

  try {
    for (const target of targets) {
      const perViewport = await Promise.all(viewports.map(async (vp) => {
        const heard: Omit<Finding, 'target' | 'width'>[] = []
        let loaded

        try {
          loaded = await open(browser, target.url, vp, session, async (page) => {
            listen(page, heard)
            await beforeLoad(page, 'measure', 'watchShifts')
          })
        }
        catch (error) {
          const { message } = error as Error

          return { ok: false as const, error: message.includes('\n') ? message.slice(0, message.indexOf('\n')) : message }
        }

        const { context, page, landed } = loaded

        try {
          const redirect = redirectedTo(target.url, landed)

          if (redirect !== undefined)
            heard.unshift({ kind: 'redirect', message: `landed on ${shortUrl(redirect)}` })

          let shot: Shot | undefined

          if (!noShots) {
            const file = `${target.stem}-${vp.suffix}.png`

            mkdirSync(dirname(file), { recursive: true })
            await shoot(page, file)
            shot = { target: target.label, width: vp.width, path: file }
          }

          const found = [
            ...heard,
            ...(runDom ? await inPage<DomFinding[]>(page, 'measure', 'measureDom', vp.width < PHONE_WIDTH) : []),
            ...(runFont ? await fontFindings(page) : []),
            ...(runContrast ? await contrastFindings(page) : []),
          ]

          return { ok: true as const, width: vp.width, shot, found }
        }
        finally {
          await context.close()
        }
      }))

      const once = new Set<string>()
      let recordedFailure = false

      for (const entry of perViewport) {
        if (!entry.ok) {
          if (!recordedFailure) {
            failed.push({ target: target.label, error: entry.error })
            recordedFailure = true
          }

          continue
        }

        if (entry.shot !== undefined) {
          shots.push(entry.shot)

          if (!values.json)
            console.log(path(entry.shot.path))
        }

        for (const finding of entry.found) {
          const key = `${finding.kind}|${finding.selector ?? ''}|${finding.message}`

          if (!active.has(finding.kind) || (ONCE.has(finding.kind) && once.has(key)))
            continue

          once.add(key)
          findings.push({ target: target.label, width: entry.width, ...finding })
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
    printLines(findingLines(findings, process.stdout, values.all === true))

    for (const { target, error } of failed)
      problem(`${target} would not load`, error)

    if (findings.length === 0 && failed.length === 0)
      console.log(marked('ok', `no defect at ${viewports.map(vp => vp.width).join(', ')}px`, process.stdout))
  }

  if (failed.length > 0)
    return 2

  return findings.length > 0 ? 1 : 0
}
