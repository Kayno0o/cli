import type { Host } from '../src/checks'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { capture, tempDirs } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'
import { configGet, configSet, configUnset, list, stats, theme } from '../src/cli-bin'
import { describeBin, filterBins, listBins } from '../src/list'

const temp = tempDirs()

const GST = { synopsis: 'gst [--log N]', summary: 'the repository in one line', replaces: 'git status --short', examples: [{ line: 'gst' }] }

// A host with `onPath` on the PATH, each answering --help with its stdout, and recording the env each ran with.
function fakeHost(onPath: Record<string, string>, envs: Record<string, string>[] = []): Host {
  return {
    home: '/home/x',
    globalModules: '/home/x/modules',
    bunVersion: '1.4.4',
    shell: '',
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

  test('listBins caches parsed bin descriptions by file stat', async () => {
    const dir = temp('doctor-cache-')
    const modules = join(dir, 'modules')
    const binFile = join(modules, '@kaynooo', 'cli-git', 'dist', 'gst.js')

    mkdirSync(join(modules, '@kaynooo', 'cli-git', 'dist'), { recursive: true })
    writeFileSync(join(modules, '@kaynooo', 'cli-git', 'package.json'), JSON.stringify({ bin: { gst: './dist/gst.js' } }))
    writeFileSync(binFile, '// gst')

    let runs = 0
    const host: Host = {
      ...fakeHost({ gst: '' }),
      home: dir,
      globalModules: modules,
      run: async () => {
        runs++

        return { code: 0, stdout: JSON.stringify(GST), stderr: '' }
      },
    }
    const prevXdg = process.env.XDG_CACHE_HOME

    process.env.XDG_CACHE_HOME = join(dir, 'cache')

    try {
      const first = await listBins(host)
      const second = await listBins(host)

      expect(runs).toBe(1)
      expect(second.find(each => each.bin === 'gst')).toEqual(first.find(each => each.bin === 'gst'))
    }
    finally {
      if (prevXdg === undefined)
        delete process.env.XDG_CACHE_HOME
      else
        process.env.XDG_CACHE_HOME = prevXdg
    }
  })

  test('cli theme previews the active theme or a named preset', async () => {
    const preview = await capture(() => theme(['light']))

    expect(preview.result).toBe(0)
    expect(preview.out).toContain('light')
    expect(preview.out).toContain('marks & badges')
    expect(() => theme(['nope'])).toThrow('no preset nope')
  })

  test('cli stats --mode filters runs by output mode', async () => {
    const file = join(temp('stats-mode-'), 'usage.jsonl')

    writeFileSync(file, [
      JSON.stringify({ at: new Date().toISOString(), bin: 'ft', command: 'board', flags: [], code: 0, mode: 'agent' }),
      JSON.stringify({ at: new Date().toISOString(), bin: 'gst', flags: [], code: 0, mode: 'terminal' }),
    ].join('\n'))

    const agent = await capture(async () => stats(['--mode', 'agent', '--json'], file))

    expect(agent.result).toBe(0)
    expect(JSON.parse(agent.out)).toMatchObject({ runs: 1, bins: [{ bin: 'ft', runs: 1 }] })
  })

  test('cli config get/set/unset reads and writes dotted keys in unified config', async () => {
    const dir = temp('cli-cfg-')
    const host = { ...fakeHost({}), home: dir }

    expect((await capture(() => configSet(['out.lines', '250'], host))).result).toBe(0)
    expect((await capture(() => configGet(['out.lines'], host))).out.trim()).toBe('250')
    expect(JSON.parse((await capture(() => configGet(['out.lines', '--json'], host))).out)).toBe(250)
    expect((await capture(() => configUnset(['out.lines'], host))).result).toBe(0)
    expect(() => configGet(['out.lines'], host)).toThrow('out.lines is not set')
  })
})
