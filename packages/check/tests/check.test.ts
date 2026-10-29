import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { check } from '../src/check'
import { discover } from '../src/steps'

const repo = (name: string) => new URL(`fixtures/repos/${name}`, import.meta.url).pathname

let logs: string[] = []
const spy = spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
  logs.push(parts.join(' '))
})

afterEach(() => {
  logs = []
  spy.mockClear()
})

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

  test('a Justfile\'s recipes without parameters', async () => {
    expect(await discover(repo('just'))).toEqual([{ name: 'lint', command: 'just lint', source: 'Justfile' }])
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
    expect(await check(['--list'], repo('composer'))).toBe(0)
    expect(logs.join('\n')).toContain('lint  composer run lint  composer.json')
  })

  test('one line per passing step, the failure of a failing one, and a failing exit code', async () => {
    expect(await check([], repo('js'))).toBe(1)

    const lines = logs.join('\n').split('\n')

    expect(lines[0]).toMatch(/^ok {4}check {2}\d+\.\ds {2}\S+check\.log$/)
    expect(lines[1]).toMatch(/^FAIL {2}lint {3}\d+\.\ds {2}bun run lint {2}\S+lint\.log$/)
    expect(lines[2]).toBe('  src/a.ts(1,7): error TS2322: bad')
    expect(lines[3]).toStartWith('ok    test')
  })

  test('saves each step\'s full output to the file it prints', async () => {
    await check(['--only', 'check'], repo('js'))

    const path = logs[0]?.split('  ').at(-1) ?? ''

    expect(await Bun.file(path).text()).toContain('types fine')
  })

  test('--only picks steps and exits 0 when they pass', async () => {
    expect(await check(['--only', 'check,test'], repo('js'))).toBe(0)
    expect(logs).toHaveLength(2)
  })

  test('--only with a step the repo lacks fails with the steps found', async () => {
    expect(await failure(check(['--only', 'test,nope'], repo('make')))).toContain('no nope step here, found test')
  })

  test('a folder without steps fails', async () => {
    expect(await failure(check([], new URL('fixtures', import.meta.url).pathname))).toContain('no check, typecheck, lint, test step')
  })
})
