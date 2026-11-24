import type { Fetcher } from '../src/registry'
import { Buffer } from 'node:buffer'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parsePackageLock, parsePnpmLock, parseYarnLock } from '@kaynooo/cli-kit/audit'
import { capture, tempDirs } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'
import { add } from '../src/commands/add'
import { addCommand } from '../src/consumers'

const temp = tempDirs()
const DAY = 86_400_000
const ESBUILD_LATEST = Date.parse('2026-08-08T20:00:55.454Z')
const ESBUILD = await Bun.file(new URL('fixtures/esbuild.json', import.meta.url)).json() as unknown

const fetcher: Fetcher = async (url) => {
  if (url === 'https://registry.npmjs.org/esbuild')
    return Response.json(ESBUILD)

  if (url.includes('advisories/bulk'))
    return Response.json({})

  return url.includes('api.npmjs.org') ? Response.json({ downloads: 5_000_000 }) : new Response('{}', { status: 404 })
}

describe('multi-ecosystem JS lockfile parsers', () => {
  test('parses package-lock.json, pnpm-lock.yaml, and yarn.lock', () => {
    const npmLock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'app' },
        'node_modules/zod': { version: '3.23.8' },
        'node_modules/@types/node': { version: '22.0.0', dev: true },
      },
    })

    expect(parsePackageLock(npmLock)).toEqual([
      { name: '@types/node', version: '22.0.0', prod: false },
      { name: 'zod', version: '3.23.8', prod: true },
    ])

    const pnpmLock = `lockfileVersion: '9.0'
packages:
  '@scope/pkg@1.2.3':
    resolution: {integrity: sha512-x}
  zod@3.23.8:
    resolution: {integrity: sha512-y}
`

    expect(parsePnpmLock(pnpmLock)).toEqual([
      { name: '@scope/pkg', version: '1.2.3', prod: true },
      { name: 'zod', version: '3.23.8', prod: true },
    ])

    const yarnLock = `"@scope/pkg@^1.0.0":
  version "1.2.3"

zod@^3.20.0:
  version "3.23.8"
`

    expect(parseYarnLock(yarnLock)).toEqual([
      { name: '@scope/pkg', version: '1.2.3', prod: true },
      { name: 'zod', version: '3.23.8', prod: true },
    ])
  })
})

describe('addCommand across bun, pnpm, yarn, and npm', () => {
  test('generates exact install commands for every JS manager', () => {
    const base = { dir: 'app', path: 'app/package.json', kind: 'dependencies' as const, spec: '1.0.0' }

    expect(addCommand({ ...base, manager: 'bun' }, 'zod', '3.23.8')).toEqual(['bun', 'add', '--exact', '--no-cache', 'zod@3.23.8'])
    expect(addCommand({ ...base, manager: 'pnpm', kind: 'devDependencies' }, 'zod', '3.23.8')).toEqual(['pnpm', 'add', '-D', '--save-exact', 'zod@3.23.8'])
    expect(addCommand({ ...base, manager: 'yarn' }, 'zod', '3.23.8')).toEqual(['yarn', 'add', '--exact', 'zod@3.23.8'])
    expect(addCommand({ ...base, manager: 'npm', kind: 'devDependencies' }, 'zod', '3.23.8')).toEqual(['npm', 'install', '--save-dev', '--save-exact', 'zod@3.23.8'])
  })
})

describe('pkg add', () => {
  test('vets and pins the exact safe version using the detected manager', async () => {
    const dir = temp('pkg-add-')

    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')

    const commands: string[][] = []
    const res = await capture(async () => add(['esbuild', '-D'], {
      cwd: dir,
      fetcher,
      now: ESBUILD_LATEST + 3 * DAY,
      run: async (argv) => {
        await Promise.resolve()
        commands.push(argv)

        return { code: 0, stdout: '', text: '', chunks: [], output: Buffer.alloc(0), truncated: false, timedOut: false, signal: null }
      },
    }))

    expect(res.result).toBe(0)
    expect(commands).toEqual([['pnpm', 'add', '-D', '--save-exact', 'esbuild@0.28.1']])
  })

  test('refuses to install a blocked package without --force', async () => {
    const dir = temp('pkg-add-blocked-')
    const commands: string[][] = []
    const res = await capture(async () => add(['missing-pkg'], {
      cwd: dir,
      fetcher,
      now: ESBUILD_LATEST + 3 * DAY,
      run: async (argv) => {
        await Promise.resolve()
        commands.push(argv)

        return { code: 0, stdout: '', text: '', chunks: [], output: Buffer.alloc(0), truncated: false, timedOut: false, signal: null }
      },
    }))

    expect(res.result).toBe(1)
    expect(commands).toEqual([])
  })
})
