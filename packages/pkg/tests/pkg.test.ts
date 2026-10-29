import type { Fetcher } from '../src/registry'
import { describe, expect, test } from 'bun:test'
import { parseSpec } from '../src/analyze'
import { checkPackage, render } from '../src/commands/check'
import { parseBunfig, parseNpmrc, registryFor } from '../src/config'
import { nearMisses } from '../src/nearmiss'

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

      return Response.json(body)
    }
    const report = await checkPackage('@types/node', { configs, fetcher: scoped, minAgeDays: 14 })

    expect(report.registry).toBe('registry.example.test')
    expect(seen).toEqual([{ url: 'https://registry.example.test/npm/@types%2fnode', authorization: 'Bearer secret' }])
    expect(report.downloads).toBeUndefined()
  })

  test('renders the recorded package as a table with its warnings', async () => {
    const { fetcher } = await recorded()
    const now = ESBUILD_LATEST + 3 * DAY
    const text = render(await checkPackage('esbuild', { configs: [], fetcher, minAgeDays: 14, now }), now)

    expect(text).toContain('esbuild: An extremely fast JavaScript and CSS bundler and minifier.')
    expect(text).toContain('safe         0.28.1, published')
    expect(text).toContain('  warning: 0.28.2 runs postinstall at install')
  })
})

describe('registry configuration', () => {
  test('takes a scope registry and its token from an .npmrc, expanding the environment', () => {
    const config = parseNpmrc(`; comment\n@kaynooo:registry=https://git.kaynooo.fr/api/packages/kaynooo/npm/\n//git.kaynooo.fr/api/packages/kaynooo/npm/:_authToken=${BRACED_TOKEN}\n`, { TOKEN: 'abc' })
    const registry = registryFor('@kaynooo/forgejo-tools', [config])

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
})

describe('nearMisses', () => {
  test('flags a typo, other separators and another scope of a popular name', () => {
    expect(nearMisses('lodasch')).toEqual(['lodash, 1 edit away'])
    expect(nearMisses('react_dom')[0]).toContain('react-dom')
    expect(nearMisses('@evil/lodash')).toContain('lodash under another scope')
  })

  test('stays quiet for a popular name itself and for a short unrelated one', () => {
    expect(nearMisses('lodash')).toEqual([])
    expect(nearMisses('left-pad')).toEqual([])
    expect(nearMisses('ms')).toEqual([])
  })
})
