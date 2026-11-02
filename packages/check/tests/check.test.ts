import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { capture } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'
import { check } from '../src/check'
import { discover } from '../src/steps'

const RUNTIME = mkdtempSync(join(tmpdir(), 'check-runtime-'))

process.env.XDG_RUNTIME_DIR = RUNTIME

const repo = (name: string) => new URL(`fixtures/repos/${name}`, import.meta.url).pathname

async function failure(run: Promise<number>): Promise<string> {
  try {
    await run
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }

  return ''
}

describe('discover', () => {
  test('package.json scripts, in step order, through bun run', async () => {
    const steps = await discover(repo('js'))

    expect(steps.map(step => step.command)).toEqual(['bun run check', 'bun run lint', 'bun run test'])
    expect(steps.every(step => step.source === 'package.json')).toBe(true)
  })

  test('skips a script that calls this bin by name', async () => {
    expect((await discover(repo('self'))).map(step => step.name)).toEqual(['lint'])
  })

  test.skipIf(Bun.which('just') === null)('a Justfile\'s recipes that need no argument', async () => {
    expect(await discover(repo('just'))).toEqual([{ name: 'lint', command: 'just lint', source: 'Justfile' }, { name: 'test', command: 'just test', source: 'Justfile' }])
  })

  test.skipIf(Bun.which('just') === null)('recipes with @ or parameters are found, those needing an argument or private are not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-just-'))

    writeFileSync(join(dir, 'Justfile'), '@test:\n  true\n\nlint *args:\n  true\n\ncheck:\n  true\n\n[private]\ntypecheck:\n  true\n')
    expect((await discover(dir)).map(step => step.name)).toEqual(['check', 'lint', 'test'])

    writeFileSync(join(dir, 'Justfile'), 'lint target:\n  true\n\ntest +files:\n  true\n')
    expect(await discover(dir)).toEqual([])
  })

  test('reads GNUmakefile, then makefile, then Makefile, as make does', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-make-'))

    writeFileSync(join(dir, 'Makefile'), 'lint:\n\ttrue\n')
    writeFileSync(join(dir, 'GNUmakefile'), 'test:\n\ttrue\n')
    expect((await discover(dir)).map(step => step.name)).toEqual(['test'])
  })

  test('composer.json scripts, even as an array', async () => {
    expect((await discover(repo('composer'))).map(step => step.command)).toEqual(['composer run lint', 'composer run test'])
  })

  test('a Makefile\'s targets', async () => {
    expect(await discover(repo('make'))).toEqual([{ name: 'test', command: 'make test', source: 'Makefile' }])
  })

  test('nothing in a folder without a manifest', async () => {
    expect(await discover(new URL('fixtures', import.meta.url).pathname)).toEqual([])
  })
})

describe('check', () => {
  test('--list prints the steps without running them', async () => {
    const { result, out } = await capture(async () => check(['--list'], repo('composer')))

    expect(result).toBe(0)
    expect(out).toContain('lint  composer run lint  composer.json')
  })

  test('one line per passing step, the failure of a failing one, and a failing exit code', async () => {
    const { result, out } = await capture(async () => check([], repo('js')))
    const lines = out.split('\n')

    expect(result).toBe(1)

    expect(lines[0]).toMatch(/^ok {4}check {2}\d+\.\ds {2}\S+check\.log$/)
    expect(lines[1]).toMatch(/^FAIL {2}lint {3}\d+\.\ds {2}bun run lint {2}\S+lint\.log$/)
    expect(lines[2]).toBe('  src/a.ts(1,7): error TS2322: bad')
    expect(lines[3]).toStartWith('ok    test')
  })

  test('--json prints each step\'s outcome, what failed under a failing one', async () => {
    const { result, out } = await capture(async () => check(['--json'], repo('js')))
    const outcomes = JSON.parse(out) as { name: string, ok: boolean, log: string, failed?: string }[]

    expect(result).toBe(1)
    expect(outcomes.map(outcome => [outcome.name, outcome.ok, outcome.failed])).toEqual([['check', true, undefined], ['lint', false, 'src/a.ts(1,7): error TS2322: bad'], ['test', true, undefined]])
    expect(outcomes[0]?.log).toEndWith('check.log')
    expect((JSON.parse((await capture(async () => check(['--list', '--json'], repo('just')))).out) as { name: string }[]).map(step => step.name)).toEqual(['lint', 'test'])
  })

  test('saves each step\'s full output to the file it prints', async () => {
    const { out } = await capture(async () => check(['--only', 'check'], repo('js')))
    const path = out.slice(0, out.indexOf('\n')).split('  ').at(-1) ?? ''

    expect(await Bun.file(path).text()).toContain('types fine')
  })

  test('--only picks steps and exits 0 when they pass', async () => {
    const { result, out } = await capture(async () => check(['--only', 'check,test'], repo('js')))

    expect(result).toBe(0)
    expect(out.trimEnd().split('\n')).toHaveLength(2)
  })

  test('--slot runs each step through the slot bin, and fails when there is none', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'check-slot-'))
    const calls = join(bin, 'calls')
    const path = process.env.PATH

    writeFileSync(join(bin, 'slot'), `#!/bin/sh\necho "$@" >> ${calls}\nshift\nexec "$@"\n`, { mode: 0o755 })

    try {
      process.env.PATH = `${bin}:${path}`

      const { result } = await capture(async () => check(['--slot', '--only', 'check,test'], repo('js')))

      expect(result).toBe(0)
      expect((await Bun.file(calls).text()).trim().split('\n')).toEqual(['-- sh -c bun run check', '-- sh -c bun run test'])

      process.env.PATH = '/nonexistent'
      expect(await failure(check(['--slot'], repo('js')))).toContain('--slot needs the slot bin')
    }
    finally {
      process.env.PATH = path
    }
  })

  test('--only with a step the repo lacks fails with the steps found', async () => {
    expect(await failure(check(['--only', 'test,nope'], repo('make')))).toContain('no nope step here, found test')
  })

  test('--only with no step name left fails instead of passing silently', async () => {
    expect(await failure(check(['--only', ''], repo('js')))).toContain('--only names no step')
    expect(await failure(check(['--only', ','], repo('js')))).toContain('--only names no step')
  })

  test('--timeout ends a step and what it started, and exits 2', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-timeout-'))

    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'sleep 30 & wait' } }))

    const started = Date.now()
    const { result, out } = await capture(async () => check(['--timeout', '1s'], dir))

    expect(result).toBe(2)
    expect(out).toContain('TIME  test')
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  test('keeps the logs in a private folder of the user\'s own, one per run', async () => {
    const { out } = await capture(async () => check(['--only', 'check'], repo('js')))
    const path = out.slice(0, out.indexOf('\n')).split('  ').at(-1) ?? ''

    expect(path.startsWith(RUNTIME)).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
  })

  test('a folder without steps fails', async () => {
    expect(await failure(check([], new URL('fixtures', import.meta.url).pathname))).toContain('no check, typecheck, lint, test step')
  })
})
