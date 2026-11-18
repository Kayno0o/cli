import type { Finding } from '../src/report'
import { existsSync } from 'node:fs'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname
const FIXTURES = new URL('fixtures/', import.meta.url).pathname
const KINDS = ['overflow', 'console', 'request', 'font', 'contrast', 'tap-target', 'padding', 'image', 'layout-shift']
const temp = tempDirs()

interface Report {
  shots: { target: string, width: number, path: string }[]
  findings: Finding[]
  failed: { target: string, error: string }[]
}

async function page(args: string[]): Promise<{ code: number, out: string, err: string }> {
  const child = Bun.spawn([process.execPath, CLI, ...args], { cwd: FIXTURES, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { code, out, err }
}

describe('page check', () => {
  const out = temp('page-check-')
  let report: Report
  let code: number

  // One run over every fixture, starting Chromium being the slow part.
  beforeAll(async () => {
    const run = await page(['check', 'clean.html', ...KINDS.map(kind => `${kind}.html`), '-o', out, '--json'])

    code = run.code
    report = JSON.parse(run.out) as Report
  }, 120_000)

  function lines(target: string): string[] {
    return report.findings.filter(finding => finding.target === target).map(({ width, kind, selector, message }) => `${width} ${kind} ${selector ?? '-'}: ${message}`)
  }

  test('shoots each target at 1440 and 400 into --out and exits 1 on a finding', () => {
    expect(code).toBe(1)
    expect(report.failed).toEqual([])
    expect(report.shots.filter(shot => shot.target === 'clean.html')).toEqual([{ target: 'clean.html', width: 1440, path: `${out}/clean-1440.png` }, { target: 'clean.html', width: 400, path: `${out}/clean-400.png` }])
    expect(report.shots.every(shot => existsSync(shot.path))).toBe(true)
  })

  test('a clean page has nothing to report', () => {
    expect(lines('clean.html')).toEqual([])
  })

  test('overflow names the element where the sideways scroll starts', () => {
    expect(lines('overflow.html')).toEqual(['400 overflow div.wide: right edge at 716px, 316px past the 400px viewport'])
  })

  test('console errors and uncaught exceptions, once for every width', () => {
    expect(lines('console.html')).toEqual(['1440 console -: boom', '1440 console -: uncaught Error: bad'])
  })

  test('a request that fails', () => {
    expect(lines('request.html')).toEqual([`1440 request -: GET file://${FIXTURES}missing.css failed: net::ERR_FILE_NOT_FOUND`])
  })

  test('text drawn in a fallback font names the font drawn', () => {
    const [line, ...rest] = lines('font.html')

    expect(rest).toEqual([])
    expect(line).toMatch(/^1440 font p\.lead: font-family "No Such Font Zz", monospace drawn in .+: No Such Font Zz is not available$/)
  })

  test('text under WCAG AA contrast, once for every width', () => {
    expect(lines('contrast.html')).toEqual(['1440 contrast body > p:nth-of-type(2): rgb(153, 153, 153) on rgb(255, 255, 255), 2.84:1, needs 4.5:1'])
  })

  test('a tap target under 44px at a phone width, 24px is enough wider', () => {
    expect(lines('tap-target.html')).toEqual(['400 tap-target button.close: 30×30px, under 44px'])
  })

  test('text touching the edge of its box', () => {
    expect(lines('padding.html')).toEqual(['1440 padding span.chip: text touches its top, right, bottom and left edge, no padding', '400 padding span.chip: text touches its top, right, bottom and left edge, no padding'])
  })

  test('an image that did not load', () => {
    expect(lines('image.html')).toEqual(['1440 image img.hero: data:image/png;base64,AAAA did not load', '400 image img.hero: data:image/png;base64,AAAA did not load'])
  })

  test('a layout shift score over 0.1 names what moved', () => {
    const found = lines('layout-shift.html')

    expect(found).toHaveLength(2)
    expect(found.every(line => (/^\d+ layout-shift div\.content: layout shift score \d\.\d\d, over 0\.1$/).test(line))).toBe(true)
  })
})

describe('page check output', () => {
  test('prints the PNG paths, then one line per finding', async () => {
    const out = temp('page-check-')
    const { code, out: printed } = await page(['check', 'tap-target.html', '-w', '375', '-o', out])

    expect(code).toBe(1)
    expect(printed).toBe(`${out}/tap-target-375.png\ntap-target.html 375px tap-target button.close: 30×30px, under 44px\n`)
  }, 60_000)

  test('exits 0 on a clean page and --skip leaves a kind out', async () => {
    const out = temp('page-check-')

    expect((await page(['check', 'clean.html', '-w', '1024', '-o', out])).code).toBe(0)
    expect((await page(['check', 'tap-target.html', '-w', '375', '-o', out, '--skip', 'tap-target'])).code).toBe(0)
  }, 60_000)

  test('a missing file and an unknown kind are usage errors', async () => {
    expect((await page(['check', 'nope.html'])).code).toBe(2)
    expect((await page(['check', 'clean.html', '--skip', 'colour'])).code).toBe(2)
  })
})

describe('page check behind a login', () => {
  const thirdParty: (string | null)[] = []
  const assets = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
    thirdParty.push(request.headers.get('authorization'))

    return new Response(null, { status: 204 })
  } })
  // The app lets in a session cookie or a bearer token and sends anyone else to its login page.
  const app = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
    const url = new URL(request.url)
    const signedIn = (request.headers.get('cookie') ?? '').includes('session=ok') || request.headers.get('authorization') === 'Bearer t'

    if (url.pathname === '/login')
      return new Response('<!doctype html><title>login</title><style>body{font-family:monospace}</style><p>Sign in</p>', { headers: { 'content-type': 'text/html' } })

    if (!signedIn)
      return Response.redirect(`${url.origin}/login`, 302)

    return new Response(`<!doctype html><title>app</title><style>body{font-family:monospace}</style><p>Dashboard</p><script>fetch('${assets.url.href}beacon', { mode: 'no-cors' })</script>`, { headers: { 'content-type': 'text/html' } })
  } })
  const home = `${app.url.href}home`

  afterAll(async () => {
    await app.stop(true)
    await assets.stop(true)
  })

  test('a page sent to its login page says where it landed', async () => {
    const { code, out } = await page(['check', home, '-w', '1024', '-o', temp('page-auth-'), '--json'])

    expect(code).toBe(1)
    expect((JSON.parse(out) as Report).findings).toEqual([{ target: home, width: 1024, kind: 'redirect', message: `landed on ${app.url.href}login` }])
  }, 60_000)

  test('a session cookie gets the page itself', async () => {
    expect((await page(['check', home, '-w', '1024', '-o', temp('page-auth-'), '--cookie', 'session=ok'])).code).toBe(0)
  }, 60_000)

  test('a header reaches the target\'s origin and no other', async () => {
    thirdParty.length = 0

    expect((await page(['check', home, '-w', '1024', '-o', temp('page-auth-'), '-H', 'Authorization: Bearer t'])).code).toBe(0)
    expect(thirdParty).toEqual([null])
  }, 60_000)

  test('a storage state file starts every page signed in', async () => {
    const state = `${temp('page-auth-')}/state.json`

    await Bun.write(state, JSON.stringify({ cookies: [{ name: 'session', value: 'ok', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] }))

    expect((await page(['check', home, '-w', '1024', '-o', temp('page-auth-'), '--storage-state', state])).code).toBe(0)
  }, 60_000)

  test('a malformed cookie or header is a usage error that does not echo it', async () => {
    const cookie = await page(['check', home, '--cookie', 'secretvalue'])
    const header = await page(['check', home, '-H', 'Bearer secretvalue'])

    expect([cookie.code, header.code]).toEqual([2, 2])
    expect(cookie.err + header.err).not.toContain('secretvalue')
  })
})
