import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'
import { holdsOsvLock, osvAudit, parseCargoLock, parseComposerLock, parseUvLock } from '../src/osv'

const temp = tempDirs()

const COMPOSER = JSON.stringify({ 'packages': [{ name: 'symfony/http-kernel', version: 'v4.4.0' }], 'packages-dev': [{ name: 'phpunit/phpunit', version: '9.5.0' }] })

const CARGO = `# generated
[[package]]
name = "mine"
version = "0.1.0"

[[package]]
name = "smallvec"
version = "1.6.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "abc"

[[package]]
name = "forked"
version = "1.0.0"
source = "git+https://example.com/x"
`

const UV = `version = 1

[[package]]
name = "demo"
version = "0.1.0"
source = { editable = "." }

[[package]]
name = "pillow"
version = "8.0.0"
source = { registry = "https://pypi.org/simple" }
`

describe('lockfile parsers', () => {
  test('composer.lock gives prod and dev entries without the v prefix', () => {
    expect(parseComposerLock(COMPOSER)).toEqual([{ name: 'symfony/http-kernel', version: '4.4.0', prod: true }, { name: 'phpunit/phpunit', version: '9.5.0', prod: false }])
  })

  test('Cargo.lock keeps registry crates only', () => {
    expect(parseCargoLock(CARGO)).toEqual([{ name: 'smallvec', version: '1.6.0', prod: true }])
  })

  test('uv.lock keeps registry packages and drops the project', () => {
    expect(parseUvLock(UV)).toEqual([{ name: 'pillow', version: '8.0.0', prod: true }])
  })
})

describe('osvAudit', () => {
  const vulns: Record<string, unknown> = {
    'GHSA-aaaa': { id: 'GHSA-aaaa', summary: 'RCE in Symfony', database_specific: { severity: 'HIGH' }, affected: [{ package: { name: 'symfony/http-kernel' }, ranges: [{ events: [{ introduced: '4.3.0' }, { fixed: '4.4.13' }] }] }] },
    'GHSA-bbbb': { id: 'GHSA-bbbb', summary: 'minor', database_specific: { severity: 'LOW' }, affected: [{ package: { name: 'symfony/http-kernel' }, ranges: [{ events: [{ fixed: '4.4.20' }] }] }] },
  }

  // An OSV stand-in: every query for symfony/http-kernel matches the two vulnerabilities, the others none.
  function stub(requests: string[]) {
    return async (url: string, init?: RequestInit) => {
      requests.push(url)

      if (url.endsWith('/querybatch')) {
        const { queries } = JSON.parse(String(init?.body)) as { queries: { package: { name: string, ecosystem: string } }[] }

        return Response.json({ results: queries.map(query => ({ vulns: query.package.name === 'symfony/http-kernel' ? [{ id: 'GHSA-aaaa' }, { id: 'GHSA-bbbb' }] : [] })) })
      }

      return Response.json(vulns[decodeURIComponent(url.split('/').at(-1)!)])
    }
  }

  function repo(): string {
    const dir = temp('osv-')

    writeFileSync(join(dir, 'composer.lock'), COMPOSER)
    writeFileSync(join(dir, 'composer.json'), JSON.stringify({ require: { 'symfony/http-kernel': '^4' } }))
    mkdirSync(join(dir, 'src'))

    return dir
  }

  test('turns the batch answer into a finding with severity, scope, direct and the highest fix', async () => {
    const requests: string[] = []
    const { findings, below } = await osvAudit(repo(), 'low', [], stub(requests))

    expect(holdsOsvLock(repo())).toBe(true)
    expect(below).toBe(0)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ package: 'symfony/http-kernel', severity: 'high', scope: 'prod', direct: true, fix: '4.4.20' })
    expect(findings[0]!.advisories.map(row => row.ghsa)).toEqual(['GHSA-aaaa', 'GHSA-bbbb'])
    expect(requests.filter(url => url.endsWith('/querybatch'))).toHaveLength(1)
  })

  test('the level leaves the low advisory out and counts it, and --ignore drops one by id', async () => {
    const level = await osvAudit(repo(), 'moderate', [], stub([]))

    expect(level.findings[0]!.advisories).toHaveLength(1)
    expect(level.below).toBe(1)

    const ignored = await osvAudit(repo(), 'low', ['GHSA-aaaa', 'GHSA-bbbb'], stub([]))

    expect(ignored.findings).toEqual([])
  })

  test('an osv.dev error rejects instead of reading as clean', async () => {
    let message = ''

    try {
      await osvAudit(repo(), 'low', [], async () => new Response('', { status: 503 }))
    }
    catch (error) {
      message = (error as Error).message
    }

    expect(message).toContain('503')
  })
})
