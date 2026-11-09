import { statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Exit } from '@kaynooo/cli-kit'
import { capture, tempDirs } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'
import { check } from '../src/check'
import { fix } from '../src/fix'
import { discover } from '../src/steps'

const temp = tempDirs()

const RUNTIME = temp('check-runtime-')

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
    const dir = temp('check-just-')

    writeFileSync(join(dir, 'Justfile'), '@test:\n  true\n\nlint *args:\n  true\n\ncheck:\n  true\n\n[private]\ntypecheck:\n  true\n')
    expect((await discover(dir)).map(step => step.name)).toEqual(['check', 'lint', 'test'])

    writeFileSync(join(dir, 'Justfile'), 'lint target:\n  true\n\ntest +files:\n  true\n')
    expect(await discover(dir)).toEqual([])
  })

  test('reads GNUmakefile, then makefile, then Makefile, as make does', async () => {
    const dir = temp('check-make-')

    writeFileSync(join(dir, 'Makefile'), 'lint:\n\ttrue\n')
    writeFileSync(join(dir, 'GNUmakefile'), 'test:\n\ttrue\n')
    expect((await discover(dir)).map(step => step.name)).toEqual(['test'])
  })

  test.skipIf(Bun.which('just') === null)('a Justfile or Makefile check wins over a package.json check, the other steps keeping theirs', async () => {
    const dir = temp('check-runner-')

    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { check: 'tsc', lint: 'eslint .' } }))
    writeFileSync(join(dir, 'Makefile'), 'check:\n\ttrue\n')
    expect((await discover(dir)).map(step => step.command)).toEqual(['make check', 'bun run lint'])

    writeFileSync(join(dir, 'justfile'), 'check:\n  true\n\nlint:\n  true\n')
    expect((await discover(dir)).map(step => step.command)).toEqual(['just check', 'bun run lint'])
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

  test('--quiet prints nothing for passing steps and nothing at all when all pass', async () => {
    const failing = await capture(async () => check(['--quiet'], repo('js')))

    expect(failing.result).toBe(1)
    expect(failing.out).not.toContain('ok ')
    expect(failing.out).toContain('FAIL  lint')
    expect(failing.out).toContain('1 failed')

    const passing = await capture(async () => check(['-q', '--only', 'check,test'], repo('js')))

    expect(passing.result).toBe(0)
    expect(passing.out).toBe('')
  })

  test('--slot runs each step through the slot bin, and fails when there is none', async () => {
    const bin = temp('check-slot-')
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

  test('--parallel runs the steps at once and prints them in step order', async () => {
    const dir = temp('check-parallel-')

    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { check: 'sleep 1.5; echo slow', lint: 'echo bad; exit 1', test: 'sleep 1.5; echo also slow' } }))

    const started = Date.now()
    const { result, out } = await capture(async () => check(['--parallel'], dir))

    expect(Date.now() - started).toBeLessThan(2800)
    expect(result).toBe(1)
    expect(out.indexOf('check')).toBeLessThan(out.indexOf('FAIL  lint'))
    expect(out.indexOf('FAIL  lint')).toBeLessThan(out.indexOf('test', out.indexOf('FAIL  lint')))
    expect(await failure(check(['--fix', '--parallel'], dir))).toContain('--parallel does not apply to --fix')
  })

  test('--only with a step the repo lacks fails with the steps found', async () => {
    expect(await failure(check(['--only', 'test,nope'], repo('make')))).toContain('no nope step here, found test')
  })

  test('--timeout is validated before --list', async () => {
    expect(await failure(check(['--list', '--timeout', 'bad'], repo('js')))).toContain('--timeout')
  })

  test('a malformed package.json fails with an Exit, not a stack', async () => {
    const dir = temp('check-broken-')

    writeFileSync(join(dir, 'package.json'), '{ nope')

    try {
      await check(['--list'], dir)
    }
    catch (error) {
      expect(error).toBeInstanceOf(Exit)
    }
  })

  test('--only with no step name left fails instead of passing silently', async () => {
    expect(await failure(check(['--only', ''], repo('js')))).toContain('--only names no step')
    expect(await failure(check(['--only', ','], repo('js')))).toContain('--only names no step')
  })

  test('--timeout ends a step and what it started, and exits 2', async () => {
    const dir = temp('check-timeout-')

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

describe('check --fix', () => {
  test('runs what fix runs, with the same output', async () => {
    const dir = temp('check-fix-')

    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { 'lint:fix': 'true' } }))

    const viaFix = await capture(async () => fix(['--list'], dir))
    const viaCheck = await capture(async () => check(['--fix', '--list'], dir))

    expect(viaCheck.result).toBe(0)
    expect(viaCheck.out).toBe(viaFix.out)
    expect(viaCheck.out).toContain('lint:fix')
  })

  test('--only names fixers, and the step-only options are refused', async () => {
    const dir = temp('check-fix-only-')

    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { 'lint:fix': 'true' } }))
    expect(await failure(check(['--fix', '--only', 'lint'], dir))).toContain('no lint fixer here, found lint:fix')
    expect(await failure(check(['--fix', '--changed'], dir))).toContain('--changed')
    expect(await failure(check(['--fix', '--failed'], dir))).toContain('--failed')
  })
})

describe('check --failed', () => {
  test('re-runs only the steps that failed in the last run', async () => {
    await capture(async () => check([], repo('js')))

    const { result, out } = await capture(async () => check(['--failed'], repo('js')))

    expect(result).toBe(1)
    expect(out).toContain('FAIL  lint')
    expect(out).not.toContain('ok    check')
    expect(out).not.toContain('ok    test')
  })

  test('still knows what failed after a partial run that passed', async () => {
    await capture(async () => check([], repo('js')))
    await capture(async () => check(['--only', 'test'], repo('js')))

    const { out } = await capture(async () => check(['--failed'], repo('js')))

    expect(out).toContain('FAIL  lint')
  })

  test('fails with usage when no run failed', async () => {
    const dir = temp('check-failed-')

    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { lint: 'true' } }))
    expect(await failure(check(['--failed'], dir))).toContain('no failed step in the last run')
    await capture(async () => check([], dir))
    expect(await failure(check(['--failed'], dir))).toContain('no failed step in the last run')
  })
})
