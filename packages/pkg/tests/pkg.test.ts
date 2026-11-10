import type { Fetcher } from '../src/registry'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as kit from '@kaynooo/cli-kit'
import { Exit } from '@kaynooo/cli-kit'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { describe, expect, spyOn, test } from 'bun:test'
import { fetchAdvisories } from '../src/advisories'
import { parseSpec } from '../src/analyze'
import { checkPackage, render } from '../src/commands/check'
import { loadConfigs, loadSettings, parseBunfig, parseNpmrc, registryFor } from '../src/config'
import { nearMisses } from '../src/nearmiss'
import { fetchDownloads, fetchPackument } from '../src/registry'

const temp = tempDirs()

const FIXTURES = new URL('fixtures/', import.meta.url)

async function fixture<T>(name: string): Promise<T> {
  return await Bun.file(new URL(name, FIXTURES)).json() as T
}

interface Recorded {
  status: number
  body: unknown
}

// Answers the registry and downloads URLs from the recorded responses, and records the requests it saw.
async function recorded(): Promise<{ fetcher: Fetcher, seen: { url: string, authorization: string | undefined }[] }> {
  const routes: Record<string, Recorded> = {
    'https://registry.npmjs.org/left-pad': { status: 200, body: await fixture('left-pad.json') },
    'https://registry.npmjs.org/esbuild': { status: 200, body: await fixture('esbuild.json') },
    'https://registry.npmjs.org/@types%2fnode': { status: 200, body: await fixture('types-node.json') },
    'https://registry.npmjs.org/definitely-not-a-pkg-zzq': await fixture('registry-missing.json'),
    'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk': { status: 200, body: {} },
    'https://api.npmjs.org/downloads/point/last-week/left-pad': await fixture('downloads-left-pad.json'),
    'https://api.npmjs.org/downloads/point/last-week/esbuild': await fixture('downloads-esbuild.json'),
    'https://api.npmjs.org/downloads/point/last-week/definitely-not-a-pkg-zzq': await fixture('downloads-missing.json'),
  }
  const seen: { url: string, authorization: string | undefined }[] = []
  const fetcher: Fetcher = async (url, init) => {
    seen.push({ url, authorization: (init?.headers as Record<string, string> | undefined)?.authorization })

    const route = routes[url]

    return route === undefined ? new Response('{}', { status: 599 }) : Response.json(route.body, { status: route.status })
  }

  return { fetcher, seen }
}

// eslint-disable-next-line no-template-curly-in-string
const BRACED_TOKEN = '${TOKEN}'
const DAY = 86_400_000
const ESBUILD_LATEST = Date.parse('2026-08-08T20:00:55.454Z')

describe('parseSpec', () => {
  test('splits the name from the version, keeping the scope', () => {
    expect(parseSpec('left-pad')).toEqual({ name: 'left-pad' })
    expect(parseSpec('left-pad@1.3.0')).toEqual({ name: 'left-pad', request: '1.3.0' })
    expect(parseSpec('@types/node')).toEqual({ name: '@types/node' })
    expect(parseSpec('@types/node@^20')).toEqual({ name: '@types/node', request: '^20' })
  })
})

describe('checkPackage', () => {
  test('reports a package that exists with its downloads, licence and repository', async () => {
    const { fetcher } = await recorded()
    const report = await checkPackage('left-pad', { configs: [], fetcher, minAgeDays: 14, now: Date.parse('2026-10-29') })

    expect(report).toMatchObject({ exists: true, blocked: false, version: '1.3.0', license: 'WTFPL', downloads: 2_714_160 })
    expect(report.repository).toContain('left-pad')
    expect(report.safe?.version).toBe('1.3.0')
    expect(report.warnings.join('\n')).toContain('deprecated')
  })

  test('blocks a name the registry does not know', async () => {
    const { fetcher, seen } = await recorded()
    const report = await checkPackage('definitely-not-a-pkg-zzq', { configs: [], fetcher, minAgeDays: 14 })

    expect(report).toMatchObject({ exists: false, blocked: true })
    expect(report.warnings[0]).toContain('not on registry.npmjs.org')
    expect(seen.map(request => request.url)).toEqual(['https://registry.npmjs.org/definitely-not-a-pkg-zzq'])
  })

  test('blocks a version under two weeks old and points at the newest older one', async () => {
    const { fetcher } = await recorded()
    const report = await checkPackage('esbuild', { configs: [], fetcher, minAgeDays: 14, now: ESBUILD_LATEST + 3 * DAY })

    expect(report.blocked).toBe(true)
    expect(report.safe?.version).toBe('0.28.1')
    expect(report.warnings.join('\n')).toContain('published 3 days ago, under 14 days, use esbuild@0.28.1')
  })

  test('lets the same version through once it is old enough, and a older one asked for', async () => {
    const { fetcher } = await recorded()
    const old = await checkPackage('esbuild', { configs: [], fetcher, minAgeDays: 14, now: ESBUILD_LATEST + 15 * DAY })
    const pinned = await checkPackage('esbuild@0.28.1', { configs: [], fetcher, minAgeDays: 14, now: ESBUILD_LATEST + 3 * DAY })

    expect(old.blocked).toBe(false)
    expect(pinned).toMatchObject({ blocked: false, version: '0.28.1' })
  })

  test('warns on install scripts', async () => {
    const { fetcher } = await recorded()
    const report = await checkPackage('esbuild', { configs: [], fetcher, minAgeDays: 14, now: ESBUILD_LATEST + 30 * DAY })

    expect(report.installScripts).toEqual({ postinstall: 'node install.js' })
    expect(report.warnings).toContain('0.28.2 runs postinstall at install')
  })

  test('resolves a range and blocks one nothing matches', async () => {
    const { fetcher } = await recorded()
    const ranged = await checkPackage('esbuild@^0.28.0', { configs: [], fetcher, minAgeDays: 14, now: ESBUILD_LATEST + 30 * DAY })
    const none = await checkPackage('esbuild@^9', { configs: [], fetcher, minAgeDays: 14, now: ESBUILD_LATEST + 30 * DAY })

    expect(ranged.version).toBe('0.28.2')
    expect(none).toMatchObject({ blocked: true, version: undefined })
  })

  test('reads a scoped package from its scoped registry, with its token and no downloads lookup', async () => {
    const { seen } = await recorded()
    const configs = [parseNpmrc(`@types:registry=https://registry.example.test/npm/\n//registry.example.test/npm/:_authToken=${BRACED_TOKEN}`, { TOKEN: 'secret' })]
    const body = await fixture<unknown>('types-node.json')
    const scoped: Fetcher = async (url, init) => {
      seen.push({ url, authorization: (init?.headers as Record<string, string> | undefined)?.authorization })

      return Response.json(init?.method === 'POST' ? {} : body)
    }
    const report = await checkPackage('@types/node', { configs, fetcher: scoped, minAgeDays: 14 })

    expect(report.registry).toBe('registry.example.test')
    expect(seen).toEqual([
      { url: 'https://registry.example.test/npm/@types%2fnode', authorization: 'Bearer secret' },
      { url: 'https://registry.example.test/npm/-/npm/v1/security/advisories/bulk', authorization: 'Bearer secret' },
    ])
    expect(report.downloads).toBeUndefined()
  })

  test('renders the recorded package as a table with its warnings', async () => {
    const { fetcher } = await recorded()
    const now = ESBUILD_LATEST + 3 * DAY
    const text = render(await checkPackage('esbuild', { configs: [], fetcher, minAgeDays: 14, now }), now, { isTTY: false })

    expect(text).toContain('esbuild: An extremely fast JavaScript and CSS bundler and minifier.')
    expect(text).toContain('safe         0.28.1, published')
    expect(text).toContain('  warning: 0.28.2 runs postinstall at install')
  })
})

describe('registry configuration', () => {
  test('takes a scope registry and its token from an .npmrc, expanding the environment', () => {
    const config = parseNpmrc(`; comment\n@kaynooo:registry=https://git.kaynooo.fr/api/packages/kaynooo/npm/\n//git.kaynooo.fr/api/packages/kaynooo/npm/:_authToken=${BRACED_TOKEN}\n`, { TOKEN: 'abc' })
    const registry = registryFor('@kaynooo/cli-forgejo', [config])

    expect(registry).toEqual({ url: 'https://git.kaynooo.fr/api/packages/kaynooo/npm/', token: 'abc' })
    expect(registryFor('left-pad', [config])).toEqual({ url: 'https://registry.npmjs.org' })
  })

  test('drops a token whose environment variable is unset', () => {
    const config = parseNpmrc(`@kaynooo:registry=https://git.kaynooo.fr/npm/\n//git.kaynooo.fr/npm/:_authToken=${BRACED_TOKEN}`, {})

    expect(registryFor('@kaynooo/x', [config])).toEqual({ url: 'https://git.kaynooo.fr/npm/', token: undefined })
  })

  test('takes a scope from a bunfig.toml as a url string or a table with a token', () => {
    const config = parseBunfig('[install.scopes]\n"@kaynooo" = { url = "https://git.kaynooo.fr/npm/", token = "$FORGEJO" }\n"@other" = "https://other.test/"', { FORGEJO: 'tok' })

    expect(registryFor('@kaynooo/a', [config])).toEqual({ url: 'https://git.kaynooo.fr/npm/', token: 'tok' })
    expect(registryFor('@other/a', [config])).toEqual({ url: 'https://other.test/', token: undefined })
  })

  test('lets the nearest config win', () => {
    const near = parseNpmrc('@kaynooo:registry=https://near.test/', {})
    const far = parseNpmrc('@kaynooo:registry=https://far.test/', {})

    expect(registryFor('@kaynooo/a', [near, far]).url).toBe('https://near.test/')
  })

  test('lets a scope key win over a nearer default registry, as npm does', () => {
    const near = parseNpmrc('registry=https://near.test/', {})
    const far = parseNpmrc('@kaynooo:registry=https://far.test/', {})

    expect(registryFor('@kaynooo/a', [near, far]).url).toBe('https://far.test/')
    expect(registryFor('@other/a', [near, far]).url).toBe('https://near.test/')
    expect(registryFor('left-pad', [near, far]).url).toBe('https://near.test/')
  })

  test('matches a token on a path boundary and never sends it over plain http', () => {
    const config = parseNpmrc('registry=https://host.test/npm\n//host.test:_authToken=abc\n//host.test.evil/:_authToken=bad', {})
    const other = parseNpmrc('registry=https://host.test.evil/\n//host.test:_authToken=abc', {})
    const plain = parseNpmrc('registry=http://host.test/\n//host.test/:_authToken=abc', {})
    const local = parseNpmrc('registry=http://localhost:4873/\n//localhost:4873/:_authToken=abc', {})

    expect(registryFor('a', [config]).token).toBe('abc')
    expect(registryFor('a', [other]).token).toBeUndefined()
    expect(registryFor('a', [plain]).token).toBeUndefined()
    expect(registryFor('a', [local]).token).toBe('abc')
  })

  test('reads the environment for a token only, not for a registry address', () => {
    const config = parseNpmrc(`registry=https://${BRACED_TOKEN}.evil.test/\n@kaynooo:registry=https://x.test/\n`, { TOKEN: 'secret' })
    const bunfig = parseBunfig('[install]\nregistry = "https://$TOKEN.evil.test/"', { TOKEN: 'secret' })

    expect(config.registry).toBeUndefined()
    expect(bunfig.registry).toBeUndefined()
  })

  test('ends on exit 2, could not check, for a broken config file', async () => {
    const dir = temp('pkg-config-')

    writeFileSync(join(dir, 'bunfig.toml'), '[install\nbroken')
    writeFileSync(join(dir, '.pkgrc.json'), '{ nope')

    const thrown = async (run: () => Promise<unknown>): Promise<unknown> => {
      try {
        return await run()
      }
      catch (error) {
        return error
      }
    }
    const configs = await thrown(async () => loadConfigs(dir, {}, dir))
    const settings = await thrown(async () => loadSettings(dir, dir))

    expect(configs).toBeInstanceOf(Exit)
    expect((configs as Exit).code).toBe(2)
    expect((configs as Exit).message).toContain('could not check')
    expect((settings as Exit).code).toBe(2)
  })

  test('loads every config from the directory up, then the home', async () => {
    const home = temp('pkg-home-')
    const dir = join(home, 'a', 'b')

    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.npmrc'), 'registry=https://near.test/')
    writeFileSync(join(home, 'bunfig.toml'), '[install.scopes]\n"@x" = "https://home.test/"')

    const configs = await loadConfigs(dir, {}, home)

    expect(configs.map(each => each.registry ?? Object.values(each.scopes)[0])).toEqual(['https://near.test/', 'https://home.test/'])
  })
})

describe('fetchDownloads', () => {
  test('reads the weekly count, undefined for an unknown name or an unreadable answer', async () => {
    expect(await fetchDownloads('left-pad', async () => Response.json({ downloads: 42 }))).toBe(42)
    expect(await fetchDownloads('nope', async () => new Response('{}', { status: 404 }))).toBeUndefined()
    expect(await fetchDownloads('nope', async () => new Response('<html>', { status: 200 }))).toBeUndefined()
  })
})

describe('registry failures end on exit 2', () => {
  const registry = { url: 'https://registry.test' }
  const failure = async (fetcher: Fetcher, name = 'left-pad'): Promise<unknown> => {
    try {
      return await fetchPackument(name, registry, fetcher)
    }
    catch (error) {
      return error
    }
  }

  test('an unreachable registry, a 502, a 200 HTML page and another package\'s metadata', async () => {
    for (const fetcher of [
      async () => Promise.reject(new Error('connection refused')),
      async () => new Response('bad gateway', { status: 502 }),
      async () => new Response('<html>captive portal</html>', { status: 200 }),
      async () => Response.json({ name: 'something-else' }),
    ]) {
      const error = await failure(fetcher)

      expect(error).toBeInstanceOf(Exit)
      expect((error as Exit).code).toBe(2)
      expect((error as Exit).message).toStartWith('could not check: ')
    }
  })

  test('a missing package is undefined, an invalid name is refused before any request, every request has a deadline', async () => {
    let signal: AbortSignal | null | undefined

    expect(await fetchPackument('left-pad', registry, async (_url, init) => {
      signal = init?.signal

      return new Response('{}', { status: 404 })
    })).toBeUndefined()
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(((await failure(async () => new Response('{}'), '../etc/passwd')) as Exit).message).toContain('not a valid npm package name')
  })
})

describe('analyze edge cases', () => {
  const dated = (time: Record<string, string>): Fetcher => async (url) => {
    if (url.endsWith('/bulk'))
      return Response.json({})

    return Response.json({ 'name': 'some-lib', 'dist-tags': { latest: '1.0.0' }, time, 'versions': { '1.0.0': { version: '1.0.0' }, '1.1.0': { version: '1.1.0' } } })
  }

  test('an invalid range resolves to nothing instead of the highest version', async () => {
    const report = await checkPackage('some-lib@banana', { configs: [], minAgeDays: 14, fetcher: dated({ '1.0.0': '2020-01-01T00:00:00.000Z' }) })

    expect(report.version).toBeUndefined()
    expect(report.blocked).toBe(true)
  })

  test('a version with no publish time is refused on the public registry, a warning elsewhere or with no minimum age', async () => {
    const fetcher = dated({})
    const publicRegistry = await checkPackage('some-lib', { configs: [], minAgeDays: 14, fetcher })
    const noMinimum = await checkPackage('some-lib', { configs: [], minAgeDays: 0, fetcher })
    const private_ = await checkPackage('some-lib', { configs: [parseNpmrc('registry=https://private.test/', {})], minAgeDays: 14, fetcher })

    expect(publicRegistry.blocked).toBe(true)
    expect(publicRegistry.warnings.join()).toContain('no publish date')
    expect(noMinimum.blocked).toBe(false)
    expect(private_.blocked).toBe(false)
  })

  test('a fresh version fixing a high advisory of the safe one is not held back for its age', async () => {
    const now = Date.parse('2026-11-01')
    const fetcher = (severity: string, vulnerable: string): Fetcher => async (url) => {
      if (url.endsWith('/bulk'))
        return Response.json({ 'some-lib': [{ id: 7, url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', title: 'RCE', severity, vulnerable_versions: vulnerable }] })

      return Response.json({ 'name': 'some-lib', 'dist-tags': { latest: '1.1.0' }, 'time': { '1.0.0': '2020-01-01T00:00:00.000Z', '1.1.0': '2026-10-29T00:00:00.000Z' }, 'versions': { '1.0.0': { version: '1.0.0' }, '1.1.0': { version: '1.1.0' } } })
    }
    const fixed = await checkPackage('some-lib', { configs: [], minAgeDays: 14, now, fetcher: fetcher('high', '<1.1.0') })
    const moderate = await checkPackage('some-lib', { configs: [], minAgeDays: 14, now, fetcher: fetcher('moderate', '<1.1.0') })
    const unfixed = await checkPackage('some-lib', { configs: [], minAgeDays: 14, now, fetcher: fetcher('high', '<=1.1.0') })

    expect(fixed.blocked).toBe(false)
    expect(fixed.warnings.join()).toContain('1.1.0 was published 3 days ago, under 14 days, but it fixes GHSA-aaaa-bbbb-cccc (high) that 1.0.0 has')
    expect(moderate.blocked).toBe(true)
    expect(moderate.warnings.join()).toContain('use some-lib@1.0.0')
    expect(unfixed.blocked).toBe(true)
    expect(unfixed.fixes).toEqual([])
  })

  test('a name longer than every popular name by more than two skips the edit distance', () => {
    const counted = spyOn(kit, 'distance')

    try {
      expect(nearMisses('@scope7/package-with-a-name-longer-than-any-popular-one')).toEqual([])
      expect(counted).not.toHaveBeenCalled()
    }
    finally {
      counted.mockRestore()
    }
  })
})

describe('bad advisory answers are not read as none', () => {
  const registry = { url: 'https://registry.test' }

  test('an unreachable registry, a 500 and a non-JSON page say why; a missing endpoint is unsupported', async () => {
    const rejected = await fetchAdvisories({ a: ['1.0.0'] }, registry, async () => Promise.reject(new Error('timeout')))
    const broken = await fetchAdvisories({ a: ['1.0.0'] }, registry, async () => new Response('x', { status: 500 }))
    const html = await fetchAdvisories({ a: ['1.0.0'] }, registry, async () => new Response('<html>'))
    const missing = await fetchAdvisories({ a: ['1.0.0'] }, registry, async () => new Response('{}', { status: 404 }))
    const none = await fetchAdvisories({ a: ['1.0.0'] }, registry, async () => Response.json({}))

    expect(rejected.unavailable).toContain('timeout')
    expect(broken.unavailable).toContain('500')
    expect(html.unavailable).toContain('not JSON')
    expect(missing).toMatchObject({ isUnsupported: true })
    expect(none.unavailable).toBeUndefined()
  })

  test('check ends on exit 2 when the advisories cannot be read, and only warns without an endpoint', async () => {
    const answering = (status: number): Fetcher => async (url) => {
      if (url.endsWith('/bulk'))
        return new Response('{}', { status })

      return Response.json({ 'name': 'left-pad', 'dist-tags': { latest: '1.0.0' }, 'versions': { '1.0.0': { version: '1.0.0' } }, 'time': { '1.0.0': '2020-01-01T00:00:00.000Z' } })
    }
    const context = (status: number) => ({ configs: [], settings: {}, minAgeDays: 14, fetcher: answering(status) })

    try {
      await checkPackage('left-pad', context(502))
      expect.unreachable()
    }
    catch (error) {
      expect((error as Exit).code).toBe(2)
    }

    const report = await checkPackage('left-pad', context(404))

    expect(report.blocked).toBe(false)
    expect(report.warnings.join()).toContain('no advisory endpoint')
  })
})

describe('nearMisses', () => {
  test('flags a typo, other separators and another scope of a popular name', () => {
    expect(nearMisses('lodasch')).toEqual(['lodash, 1 edit away'])
    expect(nearMisses('raect')).toEqual(['react, 1 edit away'])
    expect(nearMisses('react_dom')[0]).toContain('react-dom')
    expect(nearMisses('@evil/lodash')).toContain('lodash under another scope')
  })

  test('stays quiet for a popular name itself and for a short unrelated one', () => {
    expect(nearMisses('lodash')).toEqual([])
    expect(nearMisses('left-pad')).toEqual([])
    expect(nearMisses('ms')).toEqual([])
  })
})
