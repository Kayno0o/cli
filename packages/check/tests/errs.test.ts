import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { capture } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'
import { errs } from '../src/errs'
import { parseErrors } from '../src/output'

process.env.XDG_RUNTIME_DIR = mkdtempSync(join(tmpdir(), 'errs-runtime-'))

interface ErrsJson { errors: unknown[], unrecognised: number, log: string, code?: number }

const fixturePath = (name: string) => new URL(`fixtures/errs/${name}`, import.meta.url).pathname

async function fixture(name: string): Promise<string> {
  return Bun.file(fixturePath(name)).text()
}

describe('parseErrors', () => {
  test('tsgo: one error per line with its code as the rule', async () => {
    const { errors, unrecognised } = parseErrors(await fixture('tsgo.txt'))

    expect(unrecognised).toBe(0)
    expect(errors).toEqual([
      { tool: 'tsc', file: 'a.ts', line: 1, column: 7, rule: 'TS2322', severity: 'error', message: 'Type \'string\' is not assignable to type \'number\'.' },
      { tool: 'tsc', file: 'a.ts', line: 3, column: 18, rule: 'TS2304', severity: 'error', message: 'Cannot find name \'missing\'.' },
      { tool: 'tsc', file: 'a.ts', line: 5, column: 8, rule: 'TS2345', severity: 'error', message: 'Argument of type \'string\' is not assignable to parameter of type \'number\'.' },
    ])
  })

  test('tsc: pretty output joins continuation lines and skips the code frames', async () => {
    const { errors, unrecognised } = parseErrors(await Bun.file(new URL('fixtures/tsc-pretty.txt', import.meta.url)).text())

    expect(unrecognised).toBe(0)
    expect(errors.map(error => [error.file, error.line, error.column, error.rule])).toEqual([['src/a.ts', 1, 7, 'TS2322'], ['src/b.ts', 10, 3, 'TS2345']])
    expect(errors[1]?.message).toBe('Argument of type \'{ a: number; }\' is not assignable to parameter of type \'Options\'. Property \'b\' is missing in type \'{ a: number; }\' but required in type \'Options\'.')
  })

  test('keslint: each problem with its file and rule', async () => {
    const { errors, unrecognised } = parseErrors(await fixture('keslint.txt'))

    expect(unrecognised).toBe(0)
    expect(errors).toHaveLength(7)
    expect(errors[0]).toEqual({ tool: 'eslint', file: '/repo/src/scratch-lint.ts', line: 1, column: 1, rule: 'no-var', severity: 'error', message: 'Unexpected var, use let or const instead' })
    expect(errors[1]?.rule).toBe('unused-imports/no-unused-vars')
    expect(errors[6]).toMatchObject({ line: 4, column: 13, rule: 'antfu/if-newline' })
  })

  test('eslint: warnings keep their severity and a problem without a rule is kept', async () => {
    const { errors } = parseErrors(`${await Bun.file(new URL('fixtures/eslint.txt', import.meta.url)).text()}\n/repo/src/c.ts\n  1:1  error  Parsing error: Unexpected token\n`)

    expect(errors.map(error => error.severity)).toEqual(['error', 'warning', 'error', 'error'])
    expect(errors[3]).toMatchObject({ file: '/repo/src/c.ts', rule: undefined, message: 'Parsing error: Unexpected token' })
  })

  test('bun check: the code is the rule and the source frame is dropped', async () => {
    const { errors, unrecognised } = parseErrors(await fixture('bun-check.txt'))

    expect(unrecognised).toBe(0)
    expect(errors.map(error => [error.file, error.line, error.column, error.rule])).toEqual([['a.ts', 1, 7, 'TS2322'], ['a.ts', 3, 18, 'TS2304'], ['a.ts', 5, 8, 'TS2345']])
    expect(errors.every(error => error.tool === 'bun check')).toBe(true)
  })

  test('bun test: the test name, the assertion and the failing frame', async () => {
    const { errors, unrecognised } = parseErrors(await fixture('bun-test.txt'))

    expect(unrecognised).toBe(0)
    expect(errors).toEqual([
      { tool: 'bun test', file: '/repo/a.test.ts', line: 4, column: 17, severity: 'error', message: 'expect(received).toBe(expected) (expected 3, received 2)', test: 'adds numbers' },
      { tool: 'bun test', file: '/repo/a.test.ts', line: 8, column: 25, severity: 'error', message: 'boom', test: 'throws' },
    ])
  })

  test('bun test: a test listed again at the end is reported once', () => {
    const log = ['a.test.ts:', 'error: nope', '      at <anonymous> (/repo/a.test.ts:2:3)', '(fail) one [1.00ms]', '', '(fail) one [1.00ms]', ' 1 fail'].join('\n')

    expect(parseErrors(log).errors).toHaveLength(1)
  })

  test('counts the lines no format recognised', () => {
    const { errors, unrecognised } = parseErrors('who knows\na.ts(1,2): error TS1: bad\n\nsomething else\n')

    expect(errors).toHaveLength(1)
    expect(unrecognised).toBe(2)
  })
})

describe('errs', () => {
  test('prints file:line:col: message (rule) lines from a log file and counts the lines it skipped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'errs-'))
    const path = join(dir, 'build.log')

    writeFileSync(path, `noise\n${await fixture('tsgo.txt')}`)

    const { result, out, err } = await capture(async () => errs([path], dir))

    expect(result).toBe(1)
    expect(out.split('\n').at(0)).toBe('a.ts:1:7: Type \'string\' is not assignable to type \'number\'. (TS2322)')
    expect(err).toContain('1 line not recognised')
  })

  test('shows eslint paths under the current folder as relative ones', async () => {
    const { out } = await capture(async () => errs([fixturePath('keslint.txt')], '/repo'))

    expect(out.split('\n').at(0)).toBe('src/scratch-lint.ts:1:1: Unexpected var, use let or const instead (no-var)')
  })

  test('puts the test name before the message and exits 0 on a log without errors', async () => {
    const { out } = await capture(async () => errs([fixturePath('bun-test.txt')], '/repo'))

    expect(out.split('\n').at(1)).toBe('a.test.ts:8:25: throws: boom')

    const dir = mkdtempSync(join(tmpdir(), 'errs-'))
    const clean = join(dir, 'clean.log')

    writeFileSync(clean, ' 3 pass\n 0 fail\n')

    expect((await capture(async () => errs([clean], dir))).result).toBe(0)
  })

  test('--json prints the errors, the unrecognised count and the log path', async () => {
    const { result, out } = await capture(async () => errs([fixturePath('bun-check.txt'), '--json']))
    const json: ErrsJson = JSON.parse(out)

    expect(result).toBe(1)
    expect(json.errors).toHaveLength(3)
    expect(json.unrecognised).toBe(0)
    expect(json.log).toBe(fixturePath('bun-check.txt'))
  })

  test('runs a command after --, saves its full output and exits 1 with its errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'errs-'))
    const script = join(dir, 'tsgo')

    writeFileSync(script, `#!/bin/sh\ncat ${fixturePath('tsgo.txt')}\necho 'stray line' >&2\nexit 2\n`)
    chmodSync(script, 0o755)

    const { result, out, err } = await capture(async () => errs(['--json', '--', script], dir))
    const json: ErrsJson = JSON.parse(out)

    expect(result).toBe(1)
    expect(json.errors).toHaveLength(3)
    expect(json.code).toBe(2)
    expect(json.unrecognised).toBe(1)
    expect(await Bun.file(json.log).text()).toContain('stray line')
    expect(err).toBe('')
  })

  test('a failing command with no recognised error still exits 1 and says so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'errs-'))
    const script = join(dir, 'broken')

    writeFileSync(script, '#!/bin/sh\necho boom\nexit 3\n')
    chmodSync(script, 0o755)

    const { result, out, err } = await capture(async () => errs(['--', script], dir))

    expect(result).toBe(1)
    expect(out).toBe('')
    expect(err).toContain('the command exited 3 with no error recognised')
    expect(err).toContain('1 line not recognised')
  })
})
