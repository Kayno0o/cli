import type { AuditContext } from '../src/commands/audit'
import type { Fetcher } from '../src/registry'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { advisoriesFor, filterAdvisories } from '../src/advisories'
import { auditPackages, renderAudit } from '../src/commands/audit'
import { checkPackage } from '../src/commands/check'
import { loadSettings, parseSettings } from '../src/config'
import { isLicenseAllowed } from '../src/licenses'
import { parseBunLock } from '../src/lockfile'

const NOW = Date.parse('2026-09-01T00:00:00Z')
const OLD = '2026-01-01T00:00:00.000Z'

function packument(name: string, versions: Record<string, { license?: string }>) {
  return { 'name': name, 'dist-tags': { latest: Object.keys(versions).at(-1) }, 'time': Object.fromEntries(Object.keys(versions).map(each => [each, OLD])), 'versions': Object.fromEntries(Object.entries(versions).map(([version, more]) => [version, { version, ...more }])) }
}

const PACKUMENTS: Record<string, unknown> = {
  'https://registry.npmjs.org/mit-lib': packument('mit-lib', { '1.0.0': { license: 'MIT' } }),
  'https://registry.npmjs.org/gpl-lib': packument('gpl-lib', { '2.0.0': { license: 'GPL-3.0-only' } }),
  'https://registry.npmjs.org/none-lib': packument('none-lib', { '1.0.0': {} }),
  'https://registry.npmjs.org/dual-lib': packument('dual-lib', { '1.0.0': { license: '(GPL-3.0-only OR Apache-2.0)' } }),
  'https://registry.npmjs.org/vuln-lib': packument('vuln-lib', { '1.0.0': { license: 'MIT' }, '1.2.0': { license: 'MIT' }, '2.0.0': { license: 'MIT' } }),
}

const ADVISORIES = {
  'vuln-lib': [
    { id: 11, url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', title: 'Prototype pollution', severity: 'high', vulnerable_versions: '<1.2.0', cwe: [], cvss: { score: 0, vectorString: null } },
    { id: 12, url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff', title: 'Minor leak', severity: 'low', vulnerable_versions: '<=1.2.0', cwe: [], cvss: { score: 0, vectorString: null } },
  ],
}

// A registry serving the packuments above and the bulk advisory endpoint, recording each request.
function registry(): { fetcher: Fetcher, seen: { url: string, method: string, body: string }[] } {
  const seen: { url: string, method: string, body: string }[] = []
  const fetcher: Fetcher = async (url, init) => {
    seen.push({ url, method: init?.method ?? 'GET', body: String(init?.body ?? '') })

    if (url.endsWith('/-/npm/v1/security/advisories/bulk')) {
      const asked = JSON.parse(String(init?.body)) as Record<string, string[]>

      return Response.json(Object.fromEntries(Object.entries(ADVISORIES).filter(([name]) => name in asked)))
    }

    const found = PACKUMENTS[url]

    return found === undefined ? new Response('{}', { status: 404 }) : Response.json(found)
  }

  return { fetcher, seen }
}

describe('isLicenseAllowed', () => {
  test('follows SPDX OR, AND and WITH, ignoring case and parentheses', () => {
    const allowed = ['MIT', 'Apache-2.0']

    expect(isLicenseAllowed('mit', allowed)).toBe(true)
    expect(isLicenseAllowed('(GPL-3.0-only OR Apache-2.0)', allowed)).toBe(true)
    expect(isLicenseAllowed('MIT AND GPL-3.0-only', allowed)).toBe(false)
    expect(isLicenseAllowed('Apache-2.0 WITH LLVM-exception', allowed)).toBe(true)
    expect(isLicenseAllowed('SEE LICENSE IN LICENSE.md', allowed)).toBe(false)
  })
})

describe('settings', () => {
  test('keeps the keys of the right shape', () => {
    expect(parseSettings('{ "licenses": ["MIT"], "blockSeverity": "high" }')).toEqual({ licenses: ['MIT'], blockSeverity: 'high' })
    expect(parseSettings('{ "licenses": "MIT", "blockSeverity": "severe" }')).toEqual({})
  })

  test('each key comes from the nearest file that sets it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pkg-home-'))
    const project = mkdtempSync(join(tmpdir(), 'pkg-project-'))

    mkdirSync(join(home, '.config', 'pkg'), { recursive: true })
    writeFileSync(join(home, '.config', 'pkg', 'config.json'), '{ "licenses": ["ISC"], "blockSeverity": "critical" }')
    writeFileSync(join(project, '.pkgrc.json'), '{ "licenses": ["MIT"] }')

    expect(await loadSettings(project, home)).toEqual({ licenses: ['MIT'], blockSeverity: 'critical' })
    expect(await loadSettings(home, home)).toEqual({ licenses: ['ISC'], blockSeverity: 'critical' })
  })
})

describe('checkPackage with a licence allowlist', () => {
  const context = (licenses: string[]) => ({ configs: [], settings: { licenses }, minAgeDays: 14, now: NOW, fetcher: registry().fetcher })

  test('passes an allowed licence and refuses one outside the list', async () => {
    expect((await checkPackage('mit-lib', context(['MIT']))).blocked).toBe(false)

    const gpl = await checkPackage('gpl-lib', context(['MIT']))

    expect(gpl.blocked).toBe(true)
    expect(gpl.warnings.join()).toContain('GPL-3.0-only is not in the allowlist')
    expect((await checkPackage('dual-lib', context(['Apache-2.0']))).blocked).toBe(false)
  })

  test('refuses a missing licence', async () => {
    const report = await checkPackage('none-lib', context(['MIT']))

    expect(report.blocked).toBe(true)
    expect(report.warnings.join()).toContain('declares no licence')
  })

  test('flags nothing without an allowlist', async () => {
    const report = await checkPackage('gpl-lib', { configs: [], minAgeDays: 14, now: NOW, fetcher: registry().fetcher })

    expect(report.blocked).toBe(false)
  })
})

describe('advisories', () => {
  test('covers a version by range and reads the fixed version off an exclusive bound', () => {
    const raw = ADVISORIES['vuln-lib'].map(each => ({ id: each.id, ghsa: each.url.split('/').at(-1), url: each.url, title: each.title, severity: each.severity as 'high' | 'low', vulnerable: each.vulnerable_versions }))

    expect(advisoriesFor(raw, '1.0.0').map(each => [each.id, each.fixed])).toEqual([[11, '1.2.0'], [12, undefined]])
    expect(advisoriesFor(raw, '1.2.0').map(each => each.id)).toEqual([12])
    expect(advisoriesFor(raw, '2.0.0')).toEqual([])
  })

  test('filters by level and ignores a GHSA or numeric id', () => {
    const raw = ADVISORIES['vuln-lib'].map(each => ({ id: each.id, ghsa: each.url.split('/').at(-1), url: each.url, title: each.title, severity: each.severity as 'high' | 'low', vulnerable: each.vulnerable_versions }))

    expect(filterAdvisories(raw, 'high').map(each => each.id)).toEqual([11])
    expect(filterAdvisories(raw, 'low', ['GHSA-aaaa-bbbb-cccc']).map(each => each.id)).toEqual([12])
    expect(filterAdvisories(raw, 'low', ['12']).map(each => each.id)).toEqual([11])
  })

  test('check refuses a version at or above the configured severity, posting name to versions', async () => {
    const { fetcher, seen } = registry()
    const context = { configs: [], settings: { blockSeverity: 'high' as const }, minAgeDays: 14, now: NOW, fetcher }
    const bad = await checkPackage('vuln-lib@1.0.0', context)
    const fixed = await checkPackage('vuln-lib@1.2.0', context)

    expect(bad.blocked).toBe(true)
    expect(bad.warnings.join()).toContain('GHSA-aaaa-bbbb-cccc')
    expect(fixed.blocked).toBe(false)
    expect(seen.find(each => each.method === 'POST')).toEqual({ url: 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', method: 'POST', body: '{"vuln-lib":["1.0.0"]}' })
  })

  test('check asks for no advisories without a threshold', async () => {
    const { fetcher, seen } = registry()

    await checkPackage('vuln-lib@1.0.0', { configs: [], minAgeDays: 14, now: NOW, fetcher })

    expect(seen.some(each => each.method === 'POST')).toBe(false)
  })
})

const LOCK = `{
  "lockfileVersion": 2,
  "workspaces": { "": { "name": "root" } },
  "packages": {
    "mit-lib": ["mit-lib@1.0.0", "", {}, "sha512-a"],
    "gpl-lib": ["gpl-lib@2.0.0", "", {}, "sha512-b"],
    "vuln-lib": ["vuln-lib@1.0.0", "", {}, "sha512-c"],
    "a/vuln-lib": ["vuln-lib@1.2.0", "", {}, "sha512-d"],
    "root-tool": ["root-tool@workspace:packages/tool"],
    "git-lib": ["git-lib@github:owner/repo#abc"],
  },
}`

describe('parseBunLock', () => {
  test('lists registry packages once per version, leaving workspace and git sources out', () => {
    expect(parseBunLock(LOCK)).toEqual([
      { name: 'gpl-lib', version: '2.0.0' },
      { name: 'mit-lib', version: '1.0.0' },
      { name: 'vuln-lib', version: '1.0.0' },
      { name: 'vuln-lib', version: '1.2.0' },
    ])
  })
})

describe('auditPackages', () => {
  const base = (fetcher: Fetcher): AuditContext => ({ configs: [], settings: { licenses: ['MIT'] }, minAgeDays: 14, level: 'low', ignore: [], fetcher, now: NOW })

  test('groups licence and advisory findings per package, looking each name up once', async () => {
    const { fetcher, seen } = registry()
    const audited = await auditPackages(parseBunLock(LOCK), base(fetcher))
    const findings = audited.filter(each => each.blocked || each.warnings.length > 0 || each.advisories.length > 0)

    expect(findings.map(each => `${each.name}@${each.version}`)).toEqual(['gpl-lib@2.0.0', 'vuln-lib@1.0.0', 'vuln-lib@1.2.0'])
    expect(findings[0]?.warnings.join()).toContain('not in the allowlist')
    expect(findings[1]?.advisories.map(each => each.ghsa)).toEqual(['GHSA-aaaa-bbbb-cccc', 'GHSA-dddd-eeee-ffff'])
    expect(findings[2]?.advisories.map(each => each.id)).toEqual([12])
    expect(seen.filter(each => each.url.endsWith('/vuln-lib'))).toHaveLength(1)
    expect(seen.filter(each => each.method === 'POST')).toHaveLength(1)
    expect(renderAudit(findings, audited.length)).toContain('GHSA-aaaa-bbbb-cccc high: Prototype pollution (fixed in 1.2.0)')
  })

  test('--audit-level and --ignore narrow the advisories, an unblocked package stays clean', async () => {
    const { fetcher } = registry()
    const audited = await auditPackages(parseBunLock(LOCK), { ...base(fetcher), settings: {}, level: 'high', ignore: ['GHSA-aaaa-bbbb-cccc'] })

    expect(audited.every(each => !each.blocked && each.advisories.length === 0)).toBe(true)
  })
})
