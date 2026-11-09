import { join } from 'node:path'
import process from 'node:process'
import { capture, tempDirs } from '@kaynooo/cli-kit/test'
import { $ } from 'bun'
import { describe, expect, test } from 'bun:test'
import { release } from '../src/commands/release'
import { parseTargets } from '../src/commands/release-many'

const temp = tempDirs()

describe('parseTargets', () => {
  test('gives each folder the level after its colon, else the default', () => {
    expect(parseTargets('a,b:minor,c', 'patch')).toEqual([{ folder: 'a', level: 'patch' }, { folder: 'b', level: 'minor' }, { folder: 'c', level: 'patch' }])
  })

  test('rejects a level that is none', () => {
    expect(() => parseTargets('a:huge', 'patch')).toThrow('a:huge is no folder[:level]')
  })
})

describe('release of several packages', () => {
  async function workspace(): Promise<string> {
    const root = temp('ft-release-many-')

    await $`git init -q --bare -b main ${root}/origin.git && git clone -q ${root}/origin.git ${root}/work`.cwd(root).quiet()

    const work = join(root, 'work')

    await Bun.write(join(work, 'packages', 'a', 'package.json'), JSON.stringify({ name: 'a', version: '1.0.0' }))
    await Bun.write(join(work, 'packages', 'b', 'package.json'), JSON.stringify({ name: 'b', version: '2.0.0' }))
    await Bun.write(join(work, 'packages', 'kit', 'package.json'), JSON.stringify({ name: 'kit', version: '3.0.0', private: true }))
    await $`git config user.name t && git config user.email t@t && git add . && git commit -q -m init && git push -q origin main`.cwd(work).quiet()

    return work
  }

  async function inside<T>(work: string, body: () => Promise<T>): Promise<T> {
    const home = process.cwd()

    process.chdir(work)

    try {
      return await body()
    }
    finally {
      process.chdir(home)
    }
  }

  test('--package a,b:minor plans each one with its own level, in one push', async () => {
    const { result, out } = await inside(await workspace(), async () => capture(async () => release(['patch', '--dry-run', '--package', 'a,b:minor'])))

    expect(result).toBe(0)
    expect(out).toContain('would release a 1.0.0 -> 1.0.1, tagged a-v1.0.1')
    expect(out).toContain('would release b 2.0.0 -> 2.1.0, tagged b-v2.1.0')
    expect(out).toContain('push main and a-v1.0.1, b-v2.1.0 in one atomic push')
  })

  test('--all takes the published packages only', async () => {
    const { out } = await inside(await workspace(), async () => capture(async () => release(['patch', '--dry-run', '--all'])))

    expect(out).toContain('tagged a-v1.0.1')
    expect(out).toContain('tagged b-v2.0.1')
    expect(out).not.toContain('kit')
  })

  test('a folder with no package stops the release before anything runs', async () => {
    const work = await workspace()

    // eslint-disable-next-line ts/await-thenable -- bun types .rejects as void
    await expect(inside(work, async () => capture(async () => release(['patch', '--dry-run', '-p', 'a,nope,b'])))).rejects.toThrow('no package.json in nope')
  })

  test('refuses --tagged and --all with --package', async () => {
    const work = await workspace()

    // eslint-disable-next-line ts/await-thenable -- bun types .rejects as void
    await expect(inside(work, async () => capture(async () => release(['patch', '--all', '-p', 'a,b'])))).rejects.toThrow('give --all or --package')
  })
})
