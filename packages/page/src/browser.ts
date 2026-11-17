import type { Browser, BrowserContext, Page } from 'playwright-core'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { cacheFolder, fail } from '@kaynooo/cli-kit'
import { inPage } from './inpage'

const HTTP_URL = /^https?:\/\//
const HTML_EXT = /\.html?$/
const UNSAFE = /[^\w.-]+/g
const EDGE_DASHES = /^-+|-+$/g

// Below this width a page is laid out for a phone, where a finger needs 44px to hit a target.
export const PHONE_WIDTH = 600

const SYSTEM_CHROMES = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/brave', '/usr/bin/brave-browser']

// Playwright's own builds, newest revision first, the full browser before the headless shell: the shell resolves fonts unlike a desktop browser (system-ui to Adwaita Sans where Chrome draws Adwaita Mono).
function playwrightBuilds(cache: string): string[] {
  if (!existsSync(cache))
    return []

  const folders = readdirSync(cache).filter(name => name.startsWith('chromium')).toSorted((a, b) => Number(a.includes('headless')) - Number(b.includes('headless')) || revision(b) - revision(a))

  return folders.flatMap(folder => [join(cache, folder, 'chrome-headless-shell-linux64/chrome-headless-shell'), join(cache, folder, 'chrome-linux64/chrome'), join(cache, folder, 'chrome-linux/chrome')])
}

function revision(folder: string): number {
  return Number(folder.split('-').at(-1)) || 0
}

/** The Chromium to drive: `PAGE_CHROMIUM`, else the newest one Playwright downloaded, else a system install; none is ever downloaded. */
export function findChromium(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  if (env.PAGE_CHROMIUM !== undefined && env.PAGE_CHROMIUM !== '') {
    if (!existsSync(env.PAGE_CHROMIUM))
      fail(`PAGE_CHROMIUM points at ${env.PAGE_CHROMIUM}, which does not exist`)

    return env.PAGE_CHROMIUM
  }

  const cache = env.PLAYWRIGHT_BROWSERS_PATH ?? join(home, '.cache/ms-playwright')
  const found = [...playwrightBuilds(cache), ...SYSTEM_CHROMES].find(path => existsSync(path))

  if (found === undefined)
    fail(`no Chromium under ${cache} or /usr/bin`, 2, 'bunx playwright install chromium-headless-shell, or set PAGE_CHROMIUM to a Chrome or Chromium binary')

  return found
}

export async function launch(): Promise<Browser> {
  const { chromium } = await import('playwright-core')

  return chromium.launch({ executablePath: findChromium() })
}

export interface Target {
  // As given on the command line, shown in every finding.
  label: string
  url: string
  // The PNG path without `-<width>.png`.
  stem: string
}

/** Where a target loads from and where its shots go: next to a file, into `out` when given, or the cache folder for a URL. */
export function targetOf(given: string, out: string | undefined): Target {
  if (HTTP_URL.test(given)) {
    const url = new URL(given)
    const name = `${url.host}${url.pathname}`.replace(UNSAFE, '-').replace(EDGE_DASHES, '')

    return { label: given, url: given, stem: join(out ?? join(cacheFolder(), 'kaynooo-page'), name) }
  }

  const path = resolve(given)

  if (!existsSync(path))
    fail(`${given} does not exist`)

  const name = basename(path).replace(HTML_EXT, '')

  return { label: given, url: pathToFileURL(path).href, stem: join(out === undefined ? dirname(path) : resolve(out), name) }
}

export interface Loaded {
  context: BrowserContext
  page: Page
}

/** Opens the target at one width and waits until the network and the fonts settle, `prepare` running on the page before it navigates. */
export async function open(browser: Browser, url: string, width: number, prepare?: (page: Page) => Promise<void>): Promise<Loaded> {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, hasTouch: width < PHONE_WIDTH, isMobile: false })
  const page = await context.newPage()

  await prepare?.(page)
  await page.goto(url, { waitUntil: 'load', timeout: 30_000 })

  // A page polling or streaming never goes idle, so idle is waited for only so long.
  try {
    await page.waitForLoadState('networkidle', { timeout: 5_000 })
  }
  catch {}

  await inPage(page, 'measure', 'fontsReady')

  return { context, page }
}

/** A full-page PNG with animations stopped and the caret hidden, retried once: a fresh Chromium has refused its first capture ("Unable to capture screenshot"). */
export async function shoot(page: Page, path?: string): Promise<Buffer> {
  const options = { ...path === undefined ? {} : { path }, fullPage: true, animations: 'disabled', caret: 'hide' } as const

  try {
    return await page.screenshot(options)
  }
  catch {
    return page.screenshot(options)
  }
}
