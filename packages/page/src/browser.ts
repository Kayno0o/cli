import type { Browser, BrowserContext, Page } from 'playwright-core'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { badUsage, cacheFolder, fail } from '@kaynooo/cli-kit'
import { inPage } from './inpage'

const HTTP_URL = /^https?:\/\//
const HEADER_LINE = /^[\w!#$%&'*+.^`|~-]+:/
const HTML_EXT = /\.html?$/
const FILE_URL = /^file:\/\//
const FRAGMENT = /#[^/]*$/
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

  // A file:// URL or a path may end on a #fragment, kept for the page to scroll to.
  const url = FILE_URL.test(given) ? new URL(given) : undefined
  const fragment = url?.hash ?? (existsSync(resolve(given)) ? '' : FRAGMENT.exec(given)?.[0] ?? '')
  const path = url === undefined ? resolve(given.slice(0, given.length - fragment.length)) : fileURLToPath(url)

  if (!existsSync(path))
    fail(`${given} does not exist`)

  const name = basename(path).replace(HTML_EXT, '')

  return { label: given, url: `${pathToFileURL(path).href}${fragment}`, stem: join(out === undefined ? dirname(path) : resolve(out), name) }
}

// The options letting a page behind a login be checked, shared by both commands.
export const SESSION_OPTIONS = {
  'cookie': { type: 'string', multiple: true, description: 'name=value, a cookie for a URL target\'s site, repeatable' },
  'header': { type: 'string', short: 'H', multiple: true, description: '"Name: value", a header sent with every request to a URL target\'s origin and nowhere else, repeatable' },
  'storage-state': { type: 'string', description: 'a Playwright storage state file (cookies and localStorage) every page starts from' },
} as const

export interface Session {
  cookies: { name: string, value: string }[]
  headers: Record<string, string>
  storageState?: string
}

/** The session the options describe, refusing a malformed cookie or header without echoing its value. */
export function sessionOf(values: { 'cookie'?: string[] | undefined, 'header'?: string[] | undefined, 'storage-state'?: string | undefined }): Session {
  const cookies = (values.cookie ?? []).map((cookie) => {
    const at = cookie.indexOf('=')

    if (at < 1)
      badUsage('--cookie takes name=value')

    return { name: cookie.slice(0, at), value: cookie.slice(at + 1) }
  })
  const headers: Record<string, string> = {}

  for (const header of values.header ?? []) {
    if (!HEADER_LINE.test(header))
      badUsage('-H takes "Name: value"')

    const at = header.indexOf(':')

    headers[header.slice(0, at).trim().toLowerCase()] = header.slice(at + 1).trim()
  }

  const storageState = values['storage-state']

  if (storageState !== undefined && !existsSync(storageState))
    fail(`--storage-state ${storageState} does not exist`)

  return { cookies, headers, ...storageState === undefined ? {} : { storageState } }
}

export interface Loaded {
  context: BrowserContext
  page: Page
  // Where the page ended up, which differs from the URL asked for after a redirect, to a login page say.
  landed: string
}

/** Opens the target at one width in the session and waits until the network and the fonts settle, `prepare` running on the page before it navigates. */
export async function open(browser: Browser, url: string, width: number, session: Session, prepare?: (page: Page) => Promise<void>): Promise<Loaded> {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, hasTouch: width < PHONE_WIDTH, isMobile: false, ...session.storageState === undefined ? {} : { storageState: session.storageState } })

  if (HTTP_URL.test(url)) {
    if (session.cookies.length > 0)
      await context.addCookies(session.cookies.map(cookie => ({ ...cookie, url })))

    // A token must not reach the third-party scripts, fonts and images the page loads.
    if (Object.keys(session.headers).length > 0) {
      const { origin } = new URL(url)

      await context.route(requested => requested.origin === origin, async route => route.continue({ headers: { ...route.request().headers(), ...session.headers } }))
    }
  }

  const page = await context.newPage()

  await prepare?.(page)
  await page.goto(url, { waitUntil: 'load', timeout: 30_000 })

  // A page polling or streaming never goes idle, so idle is waited for only so long.
  try {
    await page.waitForLoadState('networkidle', { timeout: 5_000 })
  }
  catch {}

  await inPage(page, 'measure', 'fontsReady')

  return { context, page, landed: page.url() }
}

/** The URL a page landed on when it is not the one asked for, the fragment aside. */
export function redirectedTo(asked: string, landed: string): string | undefined {
  const bare = (url: string): string => {
    const parsed = new URL(url)

    parsed.hash = ''

    return parsed.href
  }

  return bare(asked) === bare(landed) ? undefined : landed
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
