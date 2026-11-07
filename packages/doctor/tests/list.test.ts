import type { Host } from '../src/checks'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { capture, tempDirs } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'
import { list } from '../src/cli-bin'
import { describeBin, filterBins } from '../src/list'

const temp = tempDirs()

const GST = { synopsis: 'gst [--log N]', summary: 'the repository in one line', replaces: 'git status --short', examples: [{ line: 'gst' }] }

// A host with `onPath` on the PATH, each answering --help with its stdout, and recording the env each ran with.
function fakeHost(onPath: Record<string, string>, envs: Record<string, string>[] = []): Host {
  return {
    home: '/home/x',
    globalModules: '/home/x/modules',
    bunVersion: '1.4.4',
    which: bin => bin in onPath ? `/bin/${bin}` : null,
    run: async ([bin], env = {}) => {
      envs.push(env)

      return { code: 0, stdout: onPath[bin!] ?? '', stderr: '' }
    },
  }
}

describe('describeBin', () => {
  test('reads the description a bin prints under KIT_HELP=json', async () => {
    const envs: Record<string, string>[] = []

    expect(await describeBin(fakeHost({ gst: JSON.stringify(GST) }, envs), 'gst', '@kaynooo/cli-git')).toEqual({ bin: 'gst', package: '@kaynooo/cli-git', installed: true, ...GST })
    expect(envs).toEqual([{ KIT_HELP: 'json', NO_COLOR: '1' }])
  })

  test('keeps the first line of an older bin\'s text help, and names one not installed', async () => {
    const host = fakeHost({ gst: 'Usage: gst [--log N]: the repository in one line\n\nOptions:\n' })

    expect(await describeBin(host, 'gst', '@kaynooo/cli-git')).toEqual({ bin: 'gst', package: '@kaynooo/cli-git', installed: true, summary: 'gst [--log N]: the repository in one line' })
    expect(await describeBin(host, 'gc', '@kaynooo/cli-git')).toEqual({ bin: 'gc', package: '@kaynooo/cli-git', installed: false })
  })
})

describe('describeBin with a declared bin', () => {
  test('runs the installed package\'s own file, not the first of that name on the PATH', async () => {
    const dir = temp('doctor-list-')

    mkdirSync(join(dir, '@kaynooo', 'cli-git'), { recursive: true })
    writeFileSync(join(dir, '@kaynooo', 'cli-git', 'package.json'), JSON.stringify({ bin: { gst: './dist/gst.js' } }))

    const argvs: string[][] = []
    const host: Host = { ...fakeHost({ gst: '' }), globalModules: dir, run: async (argv) => {
      argvs.push(argv)

      return { code: 0, stdout: JSON.stringify(GST), stderr: '' }
    } }

    await describeBin(host, 'gst', '@kaynooo/cli-git')
    expect(argvs).toEqual([['bun', join(dir, '@kaynooo', 'cli-git', 'dist/gst.js'), '--help']])
  })
})

describe('cli list', () => {
  test('prints one line per bin, what it replaces after the summary', async () => {
    const { result, out } = await capture(async () => list([], fakeHost({ gst: JSON.stringify(GST) })))
    // The names are padded to the longest bin's, which changes as bins come and go.
    const lines = out.split('\n').map(line => line.replace(/^(\S+) +/, '$1 '))

    expect(result).toBe(0)
    expect(lines).toContain('gst the repository in one line; instead of git status --short')
    expect(lines).toContain('gc not installed: bun install -g @kaynooo/cli-git')
  })
})

describe('filterBins', () => {
  const listed = [
    { bin: 'gst', package: '@kaynooo/cli-git', installed: true, summary: 'the repository in one line', replaces: 'git status --short' },
    { bin: 'gl', package: '@kaynooo/cli-gitlab', installed: true, summary: 'waits for a pipeline' },
    { bin: 'db', package: '@kaynooo/cli-db', installed: true, summary: 'read-only SQL', replaces: 'psql' },
  ]

  test('keeps everything without a word', () => {
    expect(filterBins(listed, undefined)).toEqual(listed)
  })

  test('matches the name\'s start, the package, the summary and the "instead of" in any case', () => {
    expect(filterBins(listed, 'GIT').map(each => each.bin)).toEqual(['gst', 'gl'])
    expect(filterBins(listed, 'sql').map(each => each.bin)).toEqual(['db'])
    expect(filterBins(listed, 'psql').map(each => each.bin)).toEqual(['db'])
    expect(filterBins(listed, 'zzz')).toEqual([])
  })
})

describe('the cli bin', () => {
  const CLI = new URL('../src/cli-bin.ts', import.meta.url).pathname
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, CLI, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env: { ...process.env, NO_COLOR: '1' } })

  test('a bare cli lists the bins when there is no terminal', () => {
    const bare = run()

    expect(bare.exitCode).toBe(0)
    expect(bare.stdout.toString()).toBe(run('list').stdout.toString())
  })

  test('cli list with a word nothing matches is a usage error', () => {
    const none = run('list', 'zzzz-no-such-bin')

    expect(none.exitCode).toBe(2)
    expect(none.stderr.toString()).toContain('no bin matches')
  })
})
