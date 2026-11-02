import { describe, expect, test } from 'bun:test'
import { failureExcerpt } from '../src/output'

async function fixture(name: string): Promise<string> {
  return Bun.file(new URL(`fixtures/${name}`, import.meta.url)).text()
}

describe('failureExcerpt', () => {
  test('bun test: the failed test with its output, then the totals', async () => {
    const text = failureExcerpt(await fixture('bun-test.txt'))

    expect(text).toContain('expect(1).toBe(2)')
    expect(text).toContain('(fail) one')
    expect(text).toContain('1 pass')
    expect(text).toContain('1 fail')
    expect(text).not.toContain('bun test v')
  })

  test('bun test: lists a failed test once and counts the ones past ten', () => {
    const fails = Array.from({ length: 12 }, (_, index) => `(fail) case ${index} [1.00ms]`)
    const text = failureExcerpt([...fails.flatMap(line => ['boom', line]), ...fails].join('\n'))

    expect(text.match(/\(fail\) case 0 /g)).toHaveLength(1)
    expect(text).toContain('and 2 more failed tests')
  })

  test('bun check: one line per error, without the source frame', async () => {
    const text = failureExcerpt(await fixture('bun-check.txt'))

    expect(text).toContain('a.ts:1:7 TS2322: Type \'string\' is not assignable to type \'number\'.')
    expect(text).toContain('Found 2 errors in 2 files')
    expect(text).not.toContain('<source>')
    expect(text).not.toContain('^')
  })

  test('tsc: plain errors with their continuation lines', async () => {
    const text = failureExcerpt(await fixture('tsc-plain.txt'))

    expect(text).toContain('src/b.ts(10,3): error TS2345')
    expect(text).toContain('  Property \'b\' is missing')
    expect(text.split('\n')).toHaveLength(4)
  })

  test('tsc: pretty errors without the code frames', async () => {
    const text = failureExcerpt(await fixture('tsc-pretty.txt'))

    expect(text).toContain('src/a.ts:1:7 - error TS2322')
    expect(text).toContain('  Property \'b\' is missing')
    expect(text).toContain('Found 2 errors in 2 files.')
    expect(text).not.toContain('~')
    expect(text).not.toContain('const x')
  })

  test('eslint: each file once with its problems and the totals', async () => {
    const text = failureExcerpt(await fixture('eslint.txt'))

    expect(text.match(/\/repo\/src\/a\.ts/g)).toHaveLength(1)
    expect(text).toContain('/repo/src/b.ts')
    expect(text).toContain('ts/no-unused-vars')
    expect(text).toContain('✖ 3 problems (2 errors, 1 warning)')
  })

  test('phpstan: the tables to the error count, without the progress bar', async () => {
    const text = failureExcerpt(await fixture('phpstan.txt'))

    expect(text).toContain('src/Service/Mailer.php')
    expect(text).toContain('[ERROR] Found 3 errors')
    expect(text).not.toContain('100%')
  })

  test('phpunit: from the failure listing', async () => {
    const text = failureExcerpt(await fixture('phpunit.txt'))

    expect(text).toStartWith('There was 1 failure:')
    expect(text).toContain('Tests\\MailerTest::testSends')
    expect(text).not.toContain('Runtime:')
  })

  test('paratest: from the first error listing, failures included', async () => {
    const text = failureExcerpt(await fixture('paratest.txt'))

    expect(text).toStartWith('There was 1 error:')
    expect(text).toContain('InvoiceTest::testExport')
    expect(text).toContain('NotificationTest::testEachRecipientGetsTheStatusIcon')
    expect(text).not.toContain('Processes:')
  })

  test('paratest: a crashed worker from its exception block', async () => {
    const text = failureExcerpt(await fixture('paratest-crash.txt'))

    expect(text).toStartWith('In WorkerCrashedException.php line 41:')
    expect(text).toContain('Allowed memory size of 134217728 bytes exhausted')
    expect(text).not.toContain('Runtime:')
  })

  test('pest: from the first failing file', async () => {
    const text = failureExcerpt(await fixture('pest.txt'))

    expect(text.trimStart()).toStartWith('FAIL  Tests\\Feature\\MailerTest')
    expect(text).toContain('Failed asserting that false is true.')
    expect(text).not.toContain('PASS')
  })

  test('vitest: from the first failed test, without the progress tree', async () => {
    const text = failureExcerpt(await fixture('errs/vitest.txt'))

    expect(text.trimStart()).toStartWith('FAIL  e2e/flow.spec.ts')
    expect(text).toContain('AssertionError: expected 3 to be 4')
    expect(text).toContain('Tests  3 failed | 1 passed (4)')
    expect(text).not.toContain('RUN  v')
  })

  test('playwright: from the first numbered failure, with the totals', async () => {
    const text = failureExcerpt(await fixture('errs/playwright-list.txt'))

    expect(text.trimStart()).toStartWith('1) e2e/flow.spec.ts:7:1 › fails on assertion')
    expect(text).toContain('1 flaky')
    expect(text).not.toContain('Running 4 tests')
  })

  test('php-cs-fixer: one line per file with its fixers, without the diffs', async () => {
    const text = failureExcerpt(await fixture('errs/php-cs-fixer-diff.txt'))
    const listing = failureExcerpt(await fixture('errs/php-cs-fixer-v.txt'))

    expect(text.split('\n').map(line => line.trim())).toEqual(['1) src/Calc.php', '2) src/Bad.php', 'Found 2 of 2 files that can be fixed in 0.007 seconds, 20.00 MB memory used'])
    expect(listing).toContain('1) src/Calc.php (blank_line_after_opening_tag, blank_lines_before_namespace)')
  })

  test('strips colours, and falls back to the last lines of a format it does not know', () => {
    const lines = Array.from({ length: 50 }, (_, index) => `\u001B[31mline ${index}\u001B[0m`)
    const text = failureExcerpt(lines.join('\n'))

    expect(text).toStartWith('line 20')
    expect(text).toEndWith('line 49')
    expect(text).not.toContain('\u001B')
  })

  test('caps a long excerpt', () => {
    const text = failureExcerpt(Array.from({ length: 150 }, (_, index) => `src/a.ts(${index},1): error TS1: bad`).join('\n'))

    expect(text.split('\n')).toHaveLength(101)
    expect(text).toEndWith('... 50 more lines')
  })
})
