import { describe, expect, test } from 'bun:test'
import { excerpt, failedTests, traceLines } from '../src/trace'

const ESC = String.fromCharCode(27)

// A runner trace: each line prefixed with its time and stream, sections marked, colours and carriage returns left in.
function trace(...lines: string[]): string {
  return lines.map(line => `2026-10-29T15:32:31.127568Z 01O ${line}`).join('\n')
}

describe('traceLines', () => {
  test('drops prefixes, colours, overwritten text and section markers, tagging each line with its section', () => {
    const lines = traceLines([
      `2026-10-29T15:32:57.124302Z 00O+section_start:1793287977:step_script\r${ESC}[0K`,
      `2026-10-29T15:32:57.490461Z 01O ${ESC}[32;1m$ cd api${ESC}[0;m`,
      '2026-10-29T15:32:58.016367Z 01E 10%\r50%\r100%',
      '2026-10-29T15:36:24.447515Z 00O section_end:1793288184:step_script\r',
      'an untimed line',
    ].join('\n'))

    expect(lines).toEqual([
      { text: '$ cd api', section: 'step_script' },
      { text: '100%', section: 'step_script' },
      { text: 'an untimed line', section: '' },
    ])
  })
})

describe('failedTests', () => {
  test('lists each failed PHPUnit test without its dependency frames, then the verdict', () => {
    expect(failedTests([
      'Time: 00:01.000, Memory: 10 MB',
      'There was 1 PHPUnit test runner warning:',
      '1) a warning that is not a failure',
      'There were 2 errors:',
      '',
      '1) App\\Tests\\ATest::testA',
      'RuntimeException: boom',
      '/builds/app/vendor/symfony/x/Y.php:12',
      '/builds/app/tests/ATest.php:9',
      '',
      '2) App\\Tests\\BTest::testB',
      'Failed asserting that false is true.',
      '',
      'ERRORS!',
      'Tests: 4, Assertions: 4, Errors: 2.',
      'Faker seed used: 1',
    ])).toEqual([
      'There were 2 errors:',
      '1) App\\Tests\\ATest::testA\nRuntimeException: boom\n/builds/app/tests/ATest.php:9',
      '2) App\\Tests\\BTest::testB\nFailed asserting that false is true.',
      'ERRORS!\nTests: 4, Assertions: 4, Errors: 2.',
    ])
  })

  test('cuts a long test and counts the tests past ten', () => {
    const tests = Array.from({ length: 12 }, (_, index) => [`${index + 1}) T::t${index + 1}`, ...Array.from({ length: 20 }, (__, line) => `line ${line}`)]).flat()
    const parts = failedTests(['There were 12 failures:', ...tests, 'FAILURES!', 'Tests: 12, Failures: 12.'])

    expect(parts).toHaveLength(13)
    expect(parts[1]?.split('\n')).toHaveLength(16)
    expect(parts[1]?.split('\n').at(-1)).toBe('… 6 more lines')
    expect(parts.at(-2)).toBe('and 2 more failed tests')
  })

  test('is empty for a trace listing no failed test', () => {
    expect(failedTests(['There was 1 PHPUnit test runner warning:', '1) a warning', 'OK (3 tests)'])).toEqual([])
  })
})

describe('excerpt', () => {
  test('is the last lines of the script that failed, not the cleanup after it, then the runner\'s verdict', () => {
    const text = excerpt(trace(
      `section_start:1:step_script\r${ESC}[0K`,
      ...Array.from({ length: 50 }, (_, index) => `script line ${index}`),
      `section_end:2:step_script\r${ESC}[0K`,
      `section_start:2:cleanup_file_variables\r${ESC}[0K`,
      'Cleaning up project directory and file based variables',
      `section_end:3:cleanup_file_variables\r${ESC}[0K`,
      `${ESC}[31;1mERROR: Job failed: exit code 1${ESC}[0;m`,
    ))

    expect(text.split('\n')).toEqual([...Array.from({ length: 40 }, (_, index) => `script line ${index + 10}`), '', 'ERROR: Job failed: exit code 1'])
  })

  test('is the failed tests when the trace lists some', () => {
    const text = excerpt(trace('There was 1 failure:', '1) T::t', 'Failed.', 'FAILURES!', 'Tests: 1, Failures: 1.', 'ERROR: Job failed: exit code 2'))

    expect(text).toBe('There was 1 failure:\n\n1) T::t\nFailed.\n\nFAILURES!\nTests: 1, Failures: 1.\n\nERROR: Job failed: exit code 2')
  })

  test('falls back on the trace\'s last lines when a job failed before its script ran', () => {
    expect(excerpt(trace(`section_start:1:prepare_executor\r${ESC}[0K`, 'pull access denied', 'ERROR: Job failed: image pull failed'))).toBe('pull access denied\n\nERROR: Job failed: image pull failed')
  })
})
