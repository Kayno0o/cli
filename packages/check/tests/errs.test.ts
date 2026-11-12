import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { capture, tempDirs } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'
import { errs } from '../src/errs'
import { parseErrors } from '../src/output'

const temp = tempDirs()

process.env.XDG_RUNTIME_DIR = temp('errs-runtime-')

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

  test('eslint: a stray line between problems leaves them under their file', () => {
    const { errors } = parseErrors('/x/a.ts\n  1:1  error  A  r\nsome stray warning line\n  2:2  error  B  r\n')

    expect(errors.map(error => `${error.file}:${error.line}:${error.column}`)).toEqual(['/x/a.ts:1:1', '/x/a.ts:2:2'])
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

  test('bun test: a test of the same name failing in two files is two errors', () => {
    const block = (file: string) => [`${file}:`, 'error: nope', `      at <anonymous> (/repo/${file}:2:3)`, '(fail) works [1.00ms]', '']
    const { errors, unrecognised } = parseErrors([...block('a.test.ts'), ...block('b.test.ts'), '(fail) works [1.00ms]', ' 2 fail'].join('\n'))

    expect(errors.map(error => error.file)).toEqual(['/repo/a.test.ts', '/repo/b.test.ts'])
    expect(unrecognised).toBe(0)
  })

  test('tsc: a CRLF log reads as an LF one', () => {
    expect(parseErrors('src/a.ts(1,2): error TS2322: Bad.\r\nsrc/b.ts(3,4): error TS2345: Worse.\r\n').errors).toEqual([
      { tool: 'tsc', file: 'src/a.ts', line: 1, column: 2, rule: 'TS2322', severity: 'error', message: 'Bad.' },
      { tool: 'tsc', file: 'src/b.ts', line: 3, column: 4, rule: 'TS2345', severity: 'error', message: 'Worse.' },
    ])
  })

  test('bun test: a test listed again at the end is reported once', () => {
    const log = ['a.test.ts:', 'error: nope', '      at <anonymous> (/repo/a.test.ts:2:3)', '(fail) one [1.00ms]', '', '(fail) one [1.00ms]', ' 1 fail'].join('\n')

    expect(parseErrors(log).errors).toHaveLength(1)
  })

  test('phpunit 12: each failed or errored test with its location, a short diff, risky tests and deprecations left out', async () => {
    const { errors, unrecognised } = parseErrors(await fixture('phpunit-12.txt'))

    expect(unrecognised).toBe(0)
    expect(errors.map(error => [error.file, error.line, error.test, error.message])).toEqual([
      ['/repo/tests/CalcTest.php', 27, 'Tests\\CalcTest::testBoom', 'RuntimeException: boom happened'],
      ['/repo/tests/CalcTest.php', 17, 'Tests\\CalcTest::testWrong', 'Failed asserting that 4 is identical to 5.'],
      ['/repo/tests/CalcTest.php', 22, 'Tests\\CalcTest::testArray', 'Failed asserting that two arrays are identical. (- \'b\' => 2, | + \'b\' => 3,)'],
      ['/repo/tests/CalcTest.php', 37, 'Tests\\CalcTest::testMultiline', 'Failed asserting that two strings are identical. (- line two\' | + line 2\')'],
    ])
    expect(errors.every(error => error.tool === 'phpunit')).toBe(true)

    const issues = parseErrors(await fixture('phpunit-12-issues.txt'))

    expect(issues.errors).toEqual([])
    expect(issues.unrecognised).toBe(0)
  })

  test('phpunit 10 and 9: the first file under a stack trace, a data set kept in the name', async () => {
    const { errors, unrecognised } = parseErrors(await fixture('phpunit-10.txt'))

    expect(unrecognised).toBe(0)
    expect(errors).toEqual([
      { tool: 'phpunit', file: '/app/tests/MailerTest.php', line: 14, column: 0, severity: 'error', message: 'Failed asserting that false is true.', test: 'Tests\\MailerTest::testSends with data set #0 (\'a@b.fr\', 2)' },
    ])

    expect(parseErrors(await Bun.file(new URL('fixtures/phpunit.txt', import.meta.url)).text()).errors.map(error => error.line)).toEqual([14])
  })

  test('paratest prints the same listing as phpunit', async () => {
    const { errors, unrecognised } = parseErrors(await fixture('paratest-12.txt'))

    expect(unrecognised).toBe(0)
    expect(errors.map(error => error.test)).toEqual(['Tests\\CalcTest::testBoom', 'Tests\\CalcTest::testWrong', 'Tests\\CalcTest::testArray', 'Tests\\CalcTest::testMultiline'])
  })

  test('phpunit: coloured output reads the same', async () => {
    const coloured = (await fixture('phpunit-12.txt')).replaceAll('Failed asserting', '\u001B[41mFailed asserting\u001B[0m')

    expect(parseErrors(coloured).errors.map(error => error.message)).toEqual(parseErrors(await fixture('phpunit-12.txt')).errors.map(error => error.message))
  })

  test('phpstan table: file, line, message and the identifier as the rule, a wrapped message joined', async () => {
    const { errors, unrecognised } = parseErrors(await fixture('phpstan-table.txt'))

    expect(unrecognised).toBe(0)
    expect(errors.map(error => [error.file, error.line, error.rule])).toEqual([['Bad.php', 4, 'missingType.return'], ['Bad.php', 4, 'missingType.parameter'], ['Calc.php', 14, 'method.notFound'], ['Calc.php', 20, 'return.type']])
    expect(errors[0]).toMatchObject({ tool: 'phpstan', message: 'Method App\\Bad::f() has no return type specified.' })
  })

  test('phpstan table: wrapped lines, tips and the table of errors with no file', async () => {
    const { errors, unrecognised } = parseErrors(await fixture('phpstan-general.txt'))

    expect(unrecognised).toBe(0)
    expect(errors).toHaveLength(3)
    expect(errors[1]?.message).toBe('Parameter #1 $user of method App\\Service\\Mailer::send() expects App\\Entity\\User, null given.')
    expect(errors[2]).toMatchObject({ file: '', line: 0, message: 'Ignored error pattern #Unused# was not matched in reported errors.' })
  })

  test('phpstan raw and json carry the same errors', async () => {
    const raw = parseErrors(await fixture('phpstan-raw.txt'))
    const json = parseErrors(await fixture('phpstan-json.txt'))

    expect(raw.unrecognised + json.unrecognised).toBe(0)
    expect(raw.errors.map(error => [error.file, error.line, error.message])).toEqual(json.errors.map(error => [error.file, error.line, error.message]))
    expect(raw.errors).toHaveLength(4)
    expect(json.errors[2]).toMatchObject({ tool: 'phpstan', file: '/repo/src/Calc.php', line: 14, rule: 'method.notFound' })
  })

  test('phpstan: no error is no error', async () => {
    expect(parseErrors(await fixture('phpstan-ok.txt'))).toEqual({ errors: [], unrecognised: 0 })
  })

  test('php-cs-fixer: one error per file with its fixers, the diffs skipped', async () => {
    const listed = parseErrors(await fixture('php-cs-fixer-v.txt'))
    const diffed = parseErrors(await fixture('php-cs-fixer-diff.txt'))

    expect(listed.unrecognised + diffed.unrecognised).toBe(0)
    expect(listed.errors).toHaveLength(2)
    expect(listed.errors[0]).toEqual({ tool: 'php-cs-fixer', file: 'src/Calc.php', line: 0, column: 0, rule: 'blank_line_after_opening_tag, blank_lines_before_namespace', severity: 'error', message: 'style issues to fix' })
    expect(diffed.errors.map(error => error.file)).toEqual(['src/Calc.php', 'src/Bad.php'])
  })

  test('playwright: failures at their frame with the first error line, a test that passed on retry left out', async () => {
    for (const name of ['playwright-list.txt', 'playwright-line.txt']) {
      const { errors, unrecognised } = parseErrors(await fixture(name))

      expect(unrecognised).toBe(0)
      expect(errors).toEqual([
        { tool: 'playwright', file: '/repo/e2e/flow.spec.ts', line: 8, column: 19, severity: 'error', message: 'Error: expect(received).toBe(expected) // Object.is equality (expected "world", received "hello")', test: 'fails on assertion' },
        { tool: 'playwright', file: '/repo/e2e/flow.spec.ts', line: 13, column: 11, severity: 'error', message: 'Error: kaboom', test: 'group › throws inside' },
      ])
    }
  })

  test('playwright: projects name the test, a timeout is the message, flaky tests are told apart per project', async () => {
    const { errors, unrecognised } = parseErrors(await fixture('playwright-projects.txt'))

    expect(unrecognised).toBe(0)
    expect(errors).toEqual([
      { tool: 'playwright', file: '/app/e2e/login.spec.ts', line: 9, column: 54, severity: 'error', message: 'Test timeout of 30000ms exceeded.', test: '[chromium] logs in' },
    ])
  })

  test('vitest: each failed test at its frame, a suite that failed to load without a test', async () => {
    const { errors, unrecognised } = parseErrors(await fixture('vitest.txt'))

    expect(unrecognised).toBe(0)
    expect(errors.map(error => [error.tool, error.file, error.line, error.column, error.test])).toEqual([
      ['vitest', 'e2e/flow.spec.ts', 3, 1, undefined],
      ['vitest', 'tests/math.test.ts', 13, 23, 'math > adds wrong'],
      ['vitest', 'tests/math.test.ts', 17, 33, 'math > compares objects'],
      ['vitest', 'tests/math.test.ts', 21, 11, 'math > throws'],
    ])
    expect(errors[1]?.message).toBe('AssertionError: expected 3 to be 4 // Object.is equality')
  })

  test('counts the lines no format recognised', () => {
    const { errors, unrecognised } = parseErrors('who knows\na.ts(1,2): error TS1: bad\n\nsomething else\n')

    expect(errors).toHaveLength(1)
    expect(unrecognised).toBe(2)
  })
})

describe('errs', () => {
  test('prints file:line:col: message (rule) lines from a log file and counts the lines it skipped', async () => {
    const dir = temp('errs-')
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

    const dir = temp('errs-')
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
    const dir = temp('errs-')
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
    const dir = temp('errs-')
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

describe('parseErrors: go, cargo, ruff and pytest', () => {
  test('go build and go vet: file, line, column and message', async () => {
    const build = parseErrors(await fixture('go-build.txt'))
    const vet = parseErrors(await fixture('go-vet.txt'))

    expect(build.unrecognised + vet.unrecognised).toBe(0)
    expect(build.errors).toEqual([
      { tool: 'go', file: './main.go', line: 6, column: 6, severity: 'error', message: 'declared and not used: a' },
      { tool: 'go', file: './main.go', line: 6, column: 14, severity: 'error', message: 'cannot use "s" (untyped string constant) as int value in variable declaration' },
      { tool: 'go', file: './main.go', line: 8, column: 2, severity: 'error', message: 'undefined: undefinedFn' },
    ])
    expect(vet.errors).toHaveLength(1)
  })

  test('cargo: the error code as the rule, the code frame skipped, warnings told apart', async () => {
    const failed = parseErrors(await fixture('cargo.txt'))
    const warned = parseErrors(await fixture('cargo-warn.txt'))

    expect(failed.unrecognised + warned.unrecognised).toBe(0)
    expect(failed.errors).toEqual([
      { tool: 'cargo', file: 'src/main.rs', line: 2, column: 18, rule: 'E0308', severity: 'error', message: 'mismatched types' },
      { tool: 'cargo', file: 'src/main.rs', line: 4, column: 5, rule: 'E0425', severity: 'error', message: 'cannot find function `nope` in this scope' },
    ])
    expect(warned.errors).toEqual([{ tool: 'cargo', file: 'src/main.rs', line: 2, column: 9, rule: undefined, severity: 'warning', message: 'unused variable: `unused`' }])
  })

  // Printed by kay's own formatReport (kayjs src/compiler/frame.ts), as kay check prints each problem.
  test('kay check: a message running on under its header, kebab-case lint codes, the frame and summary skipped', async () => {
    const { errors, unrecognised } = parseErrors(await fixture('kay-check.txt'))

    expect(unrecognised).toBe(0)
    expect(errors).toEqual([
      { tool: 'kay check', file: 'src/lib/recommend.ts', line: 5, column: 27, rule: 'TS2345', severity: 'error', message: 'Argument of type \'number | undefined\' is not assignable to parameter of type \'number\'.' },
      { tool: 'kay check', file: 'src/routes/_actions.kay', line: 2, column: 9, rule: 'unread-name', severity: 'warning', message: '`HP` is never read' },
      { tool: 'kay check', file: 'src/routes/index.kay', line: 1, column: 1, rule: undefined, severity: 'error', message: 'a page needs one root element' },
    ])
  })

  // Hand-written from ruff's documented output, as ruff is not installed here.
  test('ruff: concise and full formats carry the same errors', async () => {
    const concise = parseErrors(await fixture('ruff-concise.txt'))
    const full = parseErrors(await fixture('ruff-full.txt'))

    expect(concise.unrecognised + full.unrecognised).toBe(0)
    expect(concise.errors).toEqual([
      { tool: 'ruff', file: 'src/a.py', line: 1, column: 8, rule: 'F401', severity: 'error', message: '`os` imported but unused' },
      { tool: 'ruff', file: 'src/a.py', line: 4, column: 89, rule: 'E501', severity: 'error', message: 'Line too long (101 > 88)' },
    ])
    expect(full.errors).toEqual(concise.errors)
  })

  // Hand-written from pytest's documented output, as pytest is not installed here.
  test('pytest: the failing location with the assertion message', async () => {
    const { errors, unrecognised } = parseErrors(await fixture('pytest.txt'))

    expect(unrecognised).toBe(0)
    expect(errors).toEqual([
      { tool: 'pytest', file: 'tests/test_calc.py', line: 4, column: 0, severity: 'error', message: 'AssertionError: assert 3 == 4' },
      { tool: 'pytest', file: 'src/calc.py', line: 3, column: 0, severity: 'error', message: 'ZeroDivisionError: division by zero' },
    ])
  })
})

describe('parseErrors: pytest frames', () => {
  test('--tb=short and a collection error report the frame with the E line, not the function name', async () => {
    const short = parseErrors(await fixture('pytest-short.txt'))
    const collection = parseErrors(await fixture('pytest-collection.txt'))

    expect(short.errors).toEqual([{ tool: 'pytest', file: 'tests/test_calc.py', line: 4, column: 0, severity: 'error', message: 'assert 3 == 4' }])
    expect(collection.errors).toEqual([{ tool: 'pytest', file: 'tests/test_calc.py', line: 1, column: 0, severity: 'error', message: 'ModuleNotFoundError: No module named \'calc\'' }])
  })

  // Hand-written from pytest's documented --tb=native output: a Python traceback, no `E` lines and no `file:line:` location.
  test('--tb=native takes each failure from its short summary line', async () => {
    const { errors, unrecognised } = parseErrors(await fixture('pytest-native.txt'))

    expect(unrecognised).toBe(0)
    expect(errors).toEqual([
      { tool: 'pytest', file: 't.py', line: 0, column: 0, severity: 'error', message: 'AssertionError: assert 1 == 2', test: 't.py::test_x' },
      { tool: 'pytest', file: 't.py', line: 0, column: 0, severity: 'error', message: 'ValueError: bad', test: 't.py::TestA::test_y' },
    ])
  })

  // Hand-written the same way: a parametrized id holding a space, a collection error, and setup and teardown errors.
  test('--tb=native finds the summary line of every kind of section', async () => {
    const { errors, unrecognised } = parseErrors(await fixture('pytest-native-errors.txt'))

    expect(unrecognised).toBe(0)
    expect(errors.map(error => [error.test, error.message])).toEqual([
      ['t.py::test_x[a b]', 'AssertionError: assert \'a b\' == \'c\''],
      ['u.py', 'ModuleNotFoundError: No module named \'nothing\''],
      ['t.py::test_s', 'RuntimeError: no db'],
      ['t.py::test_x[a b]', 'RuntimeError: left open'],
    ])
  })

  test('--tb=native splits a summary line at the dash leaving a parametrized id that holds one', () => {
    const { errors } = parseErrors([
      '=================================== FAILURES ===================================',
      '_________________________________ test_x[a - b] _________________________________',
      'Traceback (most recent call last):',
      '  File "/w/t.py", line 9, in test_x',
      '    assert value == "c"',
      'AssertionError: assert \'a - b\' == \'c\'',
      '=========================== short test summary info ============================',
      'FAILED t.py::test_x[a - b] - AssertionError: assert \'a - b\' == \'c\'',
      '============================== 1 failed in 0.02s ===============================',
    ].join('\n'))

    expect(errors.map(error => [error.test, error.message])).toEqual([['t.py::test_x[a - b]', 'AssertionError: assert \'a - b\' == \'c\'']])
  })
})

describe('parseErrors: the generic file:line:col matcher', () => {
  test('mypy: no column, the bracketed code as the rule, notes read but not listed', () => {
    const { errors, unrecognised } = parseErrors([
      'app/models.py:12: error: Incompatible types in assignment (expression has type "str", variable has type "int")  [assignment]',
      'app/models.py:12: note: Consider using a cast',
      'app/views.py:40: error: Name "missing" is not defined  [name-defined]',
      'Found 2 errors in 2 files (checked 5 source files)',
    ].join('\n'))

    expect(errors).toEqual([
      { tool: 'generic', file: 'app/models.py', line: 12, column: 0, rule: 'assignment', severity: 'error', message: 'Incompatible types in assignment (expression has type "str", variable has type "int")' },
      { tool: 'generic', file: 'app/views.py', line: 40, column: 0, rule: 'name-defined', severity: 'error', message: 'Name "missing" is not defined' },
    ])
    expect(unrecognised).toBe(0)
  })

  test('gcc and clang: a column, a warning severity, the warning flag as the rule and a fatal error', () => {
    const { errors } = parseErrors([
      'src/main.c: In function \'main\':',
      'src/main.c:5:9: warning: unused variable \'x\' [-Wunused-variable]',
      'src/main.c:9:3: error: expected \';\' before \'return\'',
      'src/util.h:1:10: fatal error: missing.h: No such file or directory',
    ].join('\n'))

    expect(errors.map(error => [error.file, error.line, error.column, error.severity, error.rule, error.message])).toEqual([
      ['src/main.c', 5, 9, 'warning', '-Wunused-variable', 'unused variable \'x\''],
      ['src/main.c', 9, 3, 'error', undefined, 'expected \';\' before \'return\''],
      ['src/util.h', 1, 10, 'error', undefined, 'missing.h: No such file or directory'],
    ])
  })

  test('shellcheck -f gcc: the SC code as the rule', () => {
    const { errors } = parseErrors('deploy.sh:7:8: warning: Double quote to prevent globbing and word splitting. [SC2086]')

    expect(errors).toEqual([{ tool: 'generic', file: 'deploy.sh', line: 7, column: 8, rule: 'SC2086', severity: 'warning', message: 'Double quote to prevent globbing and word splitting.' }])
  })

  test('golangci-lint: the linter in parentheses as the rule, on go\'s own line shape', () => {
    const { errors } = parseErrors('cmd/main.go:21:2: Error return value of `f.Close` is not checked (errcheck)')

    expect(errors).toEqual([{ tool: 'go', file: 'cmd/main.go', line: 21, column: 2, rule: 'errcheck', severity: 'error', message: 'Error return value of `f.Close` is not checked' }])
  })

  test('a line a specific parser took is not read again, and identical errors print once', () => {
    const { errors } = parseErrors(['a.py:1:1: E501 line too long', 'b.c:2:3: error: bad', 'b.c:2:3: error: bad', 'b.c:2:4: error: bad'].join('\n'))

    expect(errors.map(error => [error.tool, error.file, error.column])).toEqual([['ruff', 'a.py', 1], ['generic', 'b.c', 3], ['generic', 'b.c', 4]])
  })
})
