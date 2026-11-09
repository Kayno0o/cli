import type { Packument } from '../src/registry'
import { describe, expect, test } from 'bun:test'
import { analyze } from '../src/analyze'

const OLD = '2020-01-01T00:00:00.000Z'

function packument(versions: NonNullable<Packument['versions']>): Packument {
  const names = Object.keys(versions)

  return { 'name': 'demo', 'dist-tags': { latest: names.at(-1)! }, 'time': Object.fromEntries(names.map(name => [name, OLD])), versions }
}

function warningsOf(versions: Packument['versions'], request = '2.0.0'): string[] {
  return analyze({ spec: { name: 'demo', request }, packument: packument(versions), registry: 'registry.npmjs.org' }).warnings
}

describe('publisher change', () => {
  test('warns when the publisher differs from the previous release', () => {
    const warnings = warningsOf({ '1.0.0': { version: '1.0.0', _npmUser: { name: 'alice' } }, '2.0.0': { version: '2.0.0', _npmUser: { name: 'mallory' } } })

    expect(warnings).toEqual(['2.0.0 was published by mallory, 1.0.0 by alice'])
  })

  test('says nothing for the same publisher, a first release or a missing field', () => {
    expect(warningsOf({ '1.0.0': { version: '1.0.0', _npmUser: { name: 'alice' } }, '2.0.0': { version: '2.0.0', _npmUser: { name: 'alice' } } })).toEqual([])
    expect(warningsOf({ '2.0.0': { version: '2.0.0', _npmUser: { name: 'alice' } } })).toEqual([])
    expect(warningsOf({ '1.0.0': { version: '1.0.0' }, '2.0.0': { version: '2.0.0', _npmUser: { name: 'alice' } } })).toEqual([])
  })

  test('compares with the stable release just below, not a later or a pre-release one', () => {
    const versions = { '1.0.0': { version: '1.0.0', _npmUser: { name: 'alice' } }, '1.5.0-beta.1': { version: '1.5.0-beta.1', _npmUser: { name: 'bob' } }, '2.0.0': { version: '2.0.0', _npmUser: { name: 'alice' } }, '3.0.0': { version: '3.0.0', _npmUser: { name: 'carol' } } }

    expect(warningsOf(versions)).toEqual([])
  })

  test('warns when the previous release had attestations and this one lacks them', () => {
    const attested = { attestations: { url: 'https://registry.npmjs.org/-/npm/v1/attestations/demo@1.0.0' } }
    const lost = warningsOf({ '1.0.0': { version: '1.0.0', dist: attested }, '2.0.0': { version: '2.0.0' } })

    expect(lost).toEqual(['2.0.0 has no provenance attestation, 1.0.0 had one'])
    expect(warningsOf({ '1.0.0': { version: '1.0.0', dist: attested }, '2.0.0': { version: '2.0.0', dist: attested } })).toEqual([])
    expect(warningsOf({ '1.0.0': { version: '1.0.0' }, '2.0.0': { version: '2.0.0' } })).toEqual([])
  })

  test('is a warning, not a block', () => {
    const report = analyze({ spec: { name: 'demo', request: '2.0.0' }, packument: packument({ '1.0.0': { version: '1.0.0', _npmUser: { name: 'a' } }, '2.0.0': { version: '2.0.0', _npmUser: { name: 'b' } } }), registry: 'registry.npmjs.org' })

    expect(report.blocked).toBe(false)
  })
})
