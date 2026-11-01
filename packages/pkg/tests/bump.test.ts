import type { Ran } from '@kaynooo/cli-kit'
import type { BumpSettings } from '../src/commands/bump'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Exit } from '@kaynooo/cli-kit'
import { capture } from '@kaynooo/cli-kit/test'
import { beforeEach, describe, expect, test } from 'bun:test'
import { bumpConsumers, servedVersion } from '../src/commands/bump'
import { addCommand, findConsumers } from '../src/consumers'

const NAME = '@kaynooo/cli-kit'
const CLI = new URL('../src/cli.ts', import.meta.url).pathname

let root = ''

function manifest(dir: string, fields: Record<string, unknown>, lockfile = 'bun.lock') {
  mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, dir, 'package.json'), JSON.stringify(fields))

  if (lockfile !== '')
    writeFileSync(join(root, dir, lockfile), '')
}

function settings(more: Partial<BumpSettings> = {}): BumpSettings {
  return { root, configs: [], timeout: 1000, poll: 10, ...more }
}

// A registry serving the versions given, the next call's list taken from each.
function registry(...answers: string[][]): { fetcher: BumpSettings['fetcher'], calls: () => number } {
  let calls = 0
  const fetcher = async () => {
    const versions = answers[Math.min(calls++, answers.length - 1)] ?? []

    return Promise.resolve(Response.json({ 'name': NAME, 'dist-tags': { latest: versions.at(-1) }, 'versions': Object.fromEntries(versions.map(each => [each, { version: each }])) }))
  }

  return { fetcher, calls: () => calls }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pkg-bump-'))
  manifest('kay', { name: 'kay', devDependencies: { [NAME]: '0.7.3' } })
  manifest('tools', { name: 'tools', workspaces: ['packages/*'] })
  manifest('tools/packages/a', { name: 'a', devDependencies: { [NAME]: 'workspace:*' } }, '')
  manifest('app', { name: 'app', dependencies: { [NAME]: '^0.8.0' } }, 'pnpm-lock.yaml')
  manifest('done', { name: 'done', dependencies: { [NAME]: '0.8.0' } })
  manifest('kay/node_modules/x', { name: 'x', dependencies: { [NAME]: '0.1.0' } }, '')
  manifest('other', { name: 'other', dependencies: { react: '19.0.0' } })
})

describe('findConsumers', () => {
  test('lists every package.json depending on the package, node_modules left out', () => {
    expect(findConsumers(NAME, root).map(each => [each.dir, each.kind, each.spec, each.manager])).toEqual([
      ['app', 'dependencies', '^0.8.0', 'pnpm'],
      ['done', 'dependencies', '0.8.0', 'bun'],
      ['kay', 'devDependencies', '0.7.3', 'bun'],
      ['tools/packages/a', 'devDependencies', 'workspace:*', 'bun'],
    ])
  })

  test('adds under the same kind of dependency', () => {
    const [kay] = findConsumers(NAME, root).filter(each => each.dir === 'kay')

    expect(kay === undefined ? [] : addCommand(kay, NAME, '0.8.0')).toEqual(['bun', 'add', '--dev', '--exact', '--no-cache', `${NAME}@0.8.0`])
  })
})

describe('servedVersion', () => {
  test('waits until the registry serves the version', async () => {
    const { fetcher, calls } = registry(['0.7.3'], ['0.7.3'], ['0.7.3', '0.8.0'])

    expect(await servedVersion(NAME, '0.8.0', settings({ fetcher }))).toBe('0.8.0')
    expect(calls()).toBe(3)
  })

  test('takes the latest when no version is asked for', async () => {
    expect(await servedVersion(NAME, undefined, settings({ fetcher: registry(['0.7.3', '0.8.0']).fetcher }))).toBe('0.8.0')
  })

  test('gives up after the timeout', async () => {
    const { result } = await capture(async () => {
      try {
        return await servedVersion(NAME, '0.9.0', settings({ fetcher: registry(['0.8.0']).fetcher, timeout: 50 }))
      }
      catch (error) {
        return error instanceof Exit ? `${error.code}: ${error.message}` : String(error)
      }
    })

    expect(result).toContain(`2: `)
    expect(result).toContain(`does not serve ${NAME}@0.9.0 after`)
  })
})

describe('bumpConsumers', () => {
  test('runs bun add where it applies, saying why the others are left', async () => {
    const ran: [string[], string][] = []
    const run = async (argv: string[], cwd: string): Promise<Ran> => {
      ran.push([argv, cwd])

      return Promise.resolve({ code: 0, text: '', output: '', chunks: [] } as unknown as Ran)
    }
    const { result, out, err } = await capture(async () => bumpConsumers(NAME, '0.8.0', settings({ run })))

    expect(result).toBe(true)
    expect(ran).toEqual([[['bun', 'add', '--dev', '--exact', '--no-cache', `${NAME}@0.8.0`], join(root, 'kay')]])
    expect(out).toContain('done already on 0.8.0')
    expect(out).toContain('kay 0.7.3 -> 0.8.0')
    expect(out).toContain('1 workspace:, link: or file: dependency left as they are')
    expect(err).toContain('app ^0.8.0, its lockfile pins pnpm')
  })

  test('reports a failed install and returns false', async () => {
    const run = async (): Promise<Ran> => Promise.resolve({ code: 1, text: 'resolving\nerror: no version 0.8.0\n', output: '', chunks: [] } as unknown as Ran)
    const { result, err } = await capture(async () => bumpConsumers(NAME, '0.8.0', settings({ run })))

    expect(result).toBe(false)
    expect(err).toContain('exited 1: error: no version 0.8.0')
  })
})

describe('bumpConsumers --all-consumers', () => {
  // Stubs bun add, check and gc, failing the programs named.
  function stub(failing: string[] = []) {
    const ran: [string[], string][] = []
    const run = async (argv: string[], cwd: string): Promise<Ran> => {
      ran.push([argv, cwd])

      return Promise.resolve({ code: failing.includes(argv[0] ?? '') ? 1 : 0, text: failing.includes(argv[0] ?? '') ? `${argv[0]} broke\n` : '', output: '', chunks: [] } as unknown as Ran)
    }

    return { ran, run }
  }

  test('checks then commits through gc, adding the lockfile the folder has', async () => {
    const { ran, run } = stub()
    const { result, out } = await capture(async () => bumpConsumers(NAME, '0.8.0', settings({ run, isAll: true })))

    expect(result).toBe(true)
    expect(ran.map(([argv]) => argv[0])).toEqual(['bun', 'check', 'gc'])
    expect(ran[2]).toEqual([['gc', `chore(deps): bump ${NAME} to 0.8.0`, '--', 'package.json', 'bun.lock'], join(root, 'kay')])
    expect(out).toContain('kay 0.7.3 -> 0.8.0, checked and committed')
    expect(out).toContain('summary 1 bumped and committed, 0 bumped and failing, 3 skipped')
  })

  test('leaves a folder whose check fails uncommitted and returns false', async () => {
    const { ran, run } = stub(['check'])
    const { result, err, out } = await capture(async () => bumpConsumers(NAME, '0.8.0', settings({ run, isAll: true })))

    expect(result).toBe(false)
    expect(ran.map(([argv]) => argv[0])).toEqual(['bun', 'check'])
    expect(err).toContain('kay 0.7.3 -> 0.8.0, left uncommitted: check exited 1: check broke')
    expect(out).toContain('summary 0 bumped and committed, 1 bumped and failing (kay), 3 skipped')
  })

  test('a monorepo package commits the lockfile at its root', async () => {
    manifest('mono', { name: 'mono' })
    manifest('mono/packages/b', { name: 'b', dependencies: { [NAME]: '0.7.0' } }, '')

    const { ran, run } = stub()

    await capture(async () => bumpConsumers(NAME, '0.8.0', settings({ run, isAll: true })))

    expect(ran.find(([argv, cwd]) => argv[0] === 'gc' && cwd === join(root, 'mono/packages/b'))?.[0].slice(3)).toEqual(['package.json', '../../bun.lock'])
  })

  test('a dry run lists what would run and touches nothing', async () => {
    const { ran, run } = stub()
    const { out } = await capture(async () => bumpConsumers(NAME, '0.8.0', settings({ run, isAll: true, isDryRun: true })))

    expect(ran).toEqual([])
    expect(out).toContain(`kay would run bun add --dev --exact --no-cache ${NAME}@0.8.0, then check, then gc 'chore(deps): bump ${NAME} to 0.8.0'`)
  })
})

describe('pkg consumers', () => {
  test('prints the consumers as a table and as JSON', () => {
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, CLI, 'consumers', NAME, '--root', root, ...args], { stdout: 'pipe', stderr: 'pipe' }).stdout.toString()

    expect(run()).toMatch(/^FOLDER\s+KIND\s+VERSION\s+MANAGER\napp\s+dependencies\s+\^0\.8\.0\s+pnpm\n/)
    expect((JSON.parse(run('--json')) as { dir: string }[]).map(each => each.dir)).toEqual(['app', 'done', 'kay', 'tools/packages/a'])
  })
})
