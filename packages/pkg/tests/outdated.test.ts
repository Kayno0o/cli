import type { Fetcher } from '../src/registry'
import { join } from 'node:path'
import { capture, tempDirs } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'
import { wanted } from '../src/commands/check'
import { outdated, outdatedCommand } from '../src/commands/outdated'
import { registryDependencies } from '../src/consumers'
import { parseBunLock } from '../src/lockfile'

const temp = tempDirs()
const DAY = 86_400_000
const ESBUILD_LATEST = Date.parse('2026-08-08T20:00:55.454Z')
const ESBUILD = await Bun.file(new URL('fixtures/esbuild.json', import.meta.url)).json() as unknown

const fetcher: Fetcher = async url => url === 'https://registry.npmjs.org/esbuild' ? Response.json(ESBUILD) : new Response('{}', { status: 404 })

const manifest = JSON.stringify({
  dependencies: { esbuild: '^0.27.0', local: 'workspace:*', ghost: 'github:a/b' },
  devDependencies: { 'missing-pkg': '1.0.0' },
  peerDependencies: { react: '^18' },
})

describe('registryDependencies', () => {
  test('keeps registry ranges, drops peers and local or remote sources', () => {
    expect(registryDependencies(manifest)).toEqual([
      { name: 'esbuild', kind: 'dependencies', spec: '^0.27.0' },
      { name: 'missing-pkg', kind: 'devDependencies', spec: '1.0.0' },
    ])
  })
})

describe('outdated', () => {
  test('lists a dependency whose safe version is newer than the locked one, with the newest while it is too fresh', async () => {
    const locked = parseBunLock(JSON.stringify({ packages: { esbuild: ['esbuild@0.27.7', '', {}, 'x'] } }))
    const rows = await outdated(manifest, { fetcher, now: ESBUILD_LATEST + 3 * DAY, minAgeDays: 14, locked })

    expect(rows).toEqual([{ name: 'esbuild', kind: 'dependencies', spec: '^0.27.0', current: '0.27.7', safe: '0.28.1', change: 'minor', published: '2026-06-11T22:47:05.085Z', latest: '0.28.2' }])
  })

  test('takes a trusted dependency\'s newest version whatever its age', async () => {
    const locked = parseBunLock(JSON.stringify({ packages: { esbuild: ['esbuild@0.27.7', '', {}, 'x'] } }))
    const rows = await outdated(manifest, { fetcher, now: ESBUILD_LATEST + 3 * DAY, minAgeDays: 14, locked, trusted: ['esbuild'] })

    expect(rows.map(row => [row.safe, row.latest])).toEqual([['0.28.2', undefined]])
  })

  test('reads the version in use from the range when there is no lockfile, and lists nothing once on the safe one', async () => {
    const pinned = JSON.stringify({ dependencies: { esbuild: '0.28.1' } })

    expect(await outdated(pinned, { fetcher, now: ESBUILD_LATEST + 3 * DAY, minAgeDays: 14, locked: [] })).toEqual([])
    expect((await outdated(pinned, { fetcher, now: ESBUILD_LATEST + 30 * DAY, minAgeDays: 14, locked: [] })).map(row => row.safe)).toEqual(['0.28.2'])
  })
})

describe('the names pkg check takes from a package.json', () => {
  test('--from turns the dependencies into name@range', async () => {
    const dir = temp('pkg-from-')
    const file = join(dir, 'package.json')

    await Bun.write(file, manifest)

    expect(await wanted([], file)).toEqual(['esbuild@^0.27.0', 'missing-pkg@1.0.0'])
    expect(await wanted(['zod', 'esbuild@^0.27.0'], file)).toEqual(['zod', 'esbuild@^0.27.0', 'missing-pkg@1.0.0'])
  })
})

describe('outdatedCommand folder lookup', () => {
  test('walks up from a folder with no package.json to the nearest one and says which it used', async () => {
    const root = temp('pkg-outdated-up-')

    await Bun.write(join(root, 'package.json'), '{}')
    await Bun.write(join(root, 'src/deep/keep'), '')

    const { result, err } = await capture(async () => outdatedCommand([join(root, 'src/deep'), '--json']))

    expect(result).toBe(0)
    expect(err).toContain(`using the package.json in ${root}`)
  })

  test('keeps a workspace package\'s own package.json and says nothing', async () => {
    const root = temp('pkg-outdated-own-')
    const own = join(root, 'packages/app')

    await Bun.write(join(root, 'package.json'), JSON.stringify({ dependencies: { esbuild: '0.28.1' } }))
    await Bun.write(join(own, 'package.json'), '{}')

    const { result, err, out } = await capture(async () => outdatedCommand([own, '--json']))

    expect(result).toBe(0)
    expect(err).toBe('')
    expect(JSON.parse(out)).toEqual([])
  })
})
