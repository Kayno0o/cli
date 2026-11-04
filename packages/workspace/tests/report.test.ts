import type { Advisory } from '../src/report'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { directDependencies, findingsOf, fixedAt, fixFor, parseAudit, workspaceFolders } from '../src/report'

const advisory = (severity: Advisory['severity'], range: string, title = 'a flaw'): Advisory => ({ id: 1, url: 'https://github.com/advisories/GHSA-x', title, severity, vulnerable_versions: range })

describe('fixedAt', () => {
  test('is the version a range ends below, the highest of several ranges', () => {
    expect(fixedAt('<1.2.3')).toBe('1.2.3')
    expect(fixedAt('>=2.0.0 <2.4.1')).toBe('2.4.1')
    expect(fixedAt('>=2.0.0 <2.4.1 || <1.9.9')).toBe('2.4.1')
  })

  test('is undefined for a range with no fixed version', () => {
    expect(fixedAt('<=0.24.2')).toBeUndefined()
    expect(fixedAt('>=3.0.0')).toBeUndefined()
    expect(fixedAt('<1.0.0 || >=2.0.0')).toBeUndefined()
  })
})

describe('fixFor', () => {
  test('is the highest fix of the advisories, undefined as soon as one names none', () => {
    expect(fixFor([advisory('low', '<1.2.3'), advisory('high', '<1.10.0')])).toBe('1.10.0')
    expect(fixFor([advisory('low', '<1.2.3'), advisory('high', '<=1.10.0')])).toBeUndefined()
    expect(fixFor([])).toBeUndefined()
  })
})

describe('parseAudit', () => {
  test('reads the advisories object and nothing else', () => {
    expect(parseAudit('{"a":[]}')).toEqual({ a: [] })
    expect(parseAudit('[]')).toBeUndefined()
    expect(parseAudit('not json')).toBeUndefined()
    expect(parseAudit('')).toBeUndefined()
  })
})

describe('findingsOf', () => {
  const audit = {
    minimist: [advisory('low', '<1.2.6')],
    lodash: [advisory('high', '<4.17.21', 'prototype pollution'), advisory('moderate', '<4.17.19', 'redos')],
    esbuild: [advisory('moderate', '<=0.24.2')],
  }

  test('makes one finding per package with its worst severity, scope, directness and fix', () => {
    const found = findingsOf(audit, new Set(['lodash']), new Set(['esbuild', 'lodash']), 'low')

    expect(found.map(each => each.package)).toEqual(['lodash', 'esbuild', 'minimist'])
    expect(found[0]).toMatchObject({ severity: 'high', scope: 'prod', direct: true, fix: '4.17.21' })
    expect(found[0]?.advisories.map(each => each.title)).toEqual(['prototype pollution', 'redos'])
    expect(found[1]).toMatchObject({ scope: 'dev', direct: true, fix: undefined })
    expect(found[2]).toMatchObject({ scope: 'dev', direct: false })
  })

  test('leaves out the advisories under the level, and the packages left with none', () => {
    expect(findingsOf(audit, new Set(), new Set(), 'moderate').map(each => each.package)).toEqual(['lodash', 'esbuild'])
    expect(findingsOf(audit, new Set(), new Set(), 'high').map(each => each.package)).toEqual(['lodash'])
    expect(findingsOf(audit, new Set(), new Set(), 'high')[0]?.advisories).toHaveLength(1)
  })

  test('skips an advisory ignored by GHSA or numeric id, and the package left with none', () => {
    expect(findingsOf(audit, new Set(), new Set(), 'low', ['GHSA-x']).map(each => each.package)).toEqual([])
    expect(findingsOf(audit, new Set(), new Set(), 'low', ['1']).map(each => each.package)).toEqual([])
    expect(findingsOf(audit, new Set(), new Set(), 'low', ['GHSA-other']).map(each => each.package)).toHaveLength(3)
  })

  test('puts a production package before a development one of the same severity', () => {
    const both = { b: [advisory('high', '<2.0.0')], a: [advisory('high', '<2.0.0')] }

    expect(findingsOf(both, new Set(['b']), new Set(), 'low').map(each => each.package)).toEqual(['b', 'a'])
  })
})

describe('directDependencies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'))

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('collects what the root and its workspaces ask for', () => {
    mkdirSync(join(dir, 'packages', 'a'), { recursive: true })
    mkdirSync(join(dir, 'packages', 'b'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ workspaces: ['packages/*'], dependencies: { lodash: '1' }, devDependencies: { eslint: '1' } }))
    writeFileSync(join(dir, 'packages', 'a', 'package.json'), JSON.stringify({ dependencies: { zod: '1' } }))
    writeFileSync(join(dir, 'packages', 'b', 'package.json'), '{ broken')

    const folders = workspaceFolders(dir, () => ['a', 'b'])

    expect(folders).toEqual([join('packages', 'a'), join('packages', 'b')])
    expect([...directDependencies(dir, folders)].toSorted()).toEqual(['eslint', 'lodash', 'zod'])
  })

  test('reads the packages form of the workspaces field and lists a plain folder as is', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ workspaces: { packages: ['tools'] } }))

    expect(workspaceFolders(dir, () => [])).toEqual(['tools'])
  })
})
