import { describe, expect, test } from 'bun:test'
import { fold, lineCount, shouldFold } from '../src/fold'

const LOG = '/tmp/out-test.log'

async function fixture(name: string): Promise<string> {
  return Bun.file(new URL(`fixtures/${name}`, import.meta.url)).text()
}

function folded(text: string, threshold = 150): string {
  return fold(text, { threshold, logPath: LOG })
}

describe('lineCount', () => {
  test('counts lines, a trailing newline and carriage-return rewrites included', () => {
    expect(lineCount('')).toBe(0)
    expect(lineCount('a\nb\n')).toBe(2)
    expect(lineCount('a\nb')).toBe(2)
    expect(lineCount('10%\r50%\r100%\n')).toBe(3)
    expect(lineCount('a\r\nb\r\n')).toBe(2)
    expect(shouldFold('x\n'.repeat(150), 150)).toBe(false)
    expect(shouldFold('x\n'.repeat(151), 150)).toBe(true)
  })
})

describe('fold', () => {
  test('puts the line count, the log path and what was left out in the header', async () => {
    const text = Array.from({ length: 400 }, (_, i) => `unique${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + (Math.floor(i / 26) % 26))} words here and there`).join('\n')
    const out = folded(`${text}\n`)

    expect(out).toStartWith('[out: 400 lines, ')
    expect(out).toContain(`full log: ${LOG}`)
    expect(out).toContain('lines left out]')
    expect(out.split('\n').length).toBeLessThan(150)
  })

  test('folds lines alike in shape into one with a count and the last line', async () => {
    const out = folded(await fixture('build.txt'))

    expect(out).toContain('[1/300] compiling a0.ts in 1ms (x300, last: [300/300] compiling')
    expect(out).toContain('bun build v1.4.3')
    expect(out).toContain('Build complete in 2.4s')
    expect(out.split('\n').length).toBeLessThan(10)
  })

  test('folds a block repeated back to back, compared by shape', async () => {
    const out = folded(await fixture('warnings.txt'))

    expect(out).toContain('warning: unused variable \'x0\' in src/mod0/file.ts:10:3')
    expect(out).toContain('(block repeated 60 times)')
    expect(out).not.toContain('x1\'')
    expect(out).toContain('done')
  })

  test('turns 50 identical errors into one line with a count, and never drops them', async () => {
    const out = folded(await fixture('errors.txt'))

    expect(out).toContain('error: connection refused to db at 10.0.0.5 (x50)')
    expect(out).toContain('step 0 ok (x120')
  })

  test('replaces a duplicate far from its first occurrence with a back-reference, and lists the most repeated', async () => {
    const out = folded(await fixture('far.txt'))
    const lines = out.split('\n')

    expect(out).toContain('(same as line 1)')
    expect(lines.filter(line => line.startsWith('Downloading registry'))).toHaveLength(1)
    expect(out).toContain('line numbers in "same as line N" refer to it')
    expect(out).toContain('most repeated: 2x Downloading')
  })

  test('keeps error, warning and stack frame lines of the middle', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `plain output number ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + (Math.floor(i / 26) % 26))} continues`)

    lines[150] = 'ERROR in the middle'
    lines[151] = '    at handler (server.ts:12:5)'
    lines[160] = 'a Warning about something'
    lines[170] = 'test foo FAILED'

    const out = folded(`${lines.join('\n')}\n`)

    expect(out).toContain('ERROR in the middle')
    expect(out).toContain('    at handler (server.ts:12:5)')
    expect(out).toContain('a Warning about something')
    expect(out).toContain('test foo FAILED')
    expect(out).toContain('lines left out]')
    expect(out).not.toContain(lines[100] ?? '')
  })

  test('keeps only the final state of carriage-return progress', () => {
    const progress = Array.from({ length: 200 }, (_, i) => `\rDownloading ${i}%`).join('')
    const out = folded(`start\n${progress}\rDownloading done\ndone\n`)

    expect(out).toContain('Downloading done')
    expect(out).not.toContain('Downloading 50%')
    expect(out).toContain('start')
  })

  test('strips ansi codes when comparing but keeps the line as printed', () => {
    const text = Array.from({ length: 200 }, (_, i) => `\x1B[32m[${i}/200]\x1B[0m building`).join('\n')

    expect(folded(`${text}\n`)).toContain('building (x200, last: ')
  })
})

describe('long lines and many errors', () => {
  test('shapes 40k character lines in well under a second', () => {
    const started = performance.now()

    folded(`${'a.'.repeat(20_000)}\n${'/a'.repeat(20_000)}\n`.repeat(3), 1)
    expect(performance.now() - started).toBeLessThan(500)
  })

  test('never drops an error, however many come', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `step ${i}\nerror: failure number ${'x'.repeat(i % 7)}${i} in ${i % 2 === 0 ? 'a' : 'b'}.ts`)
    const output = folded(`${lines.join('\n')}\n`, 50)

    expect(output).toContain('failure number 399')
    expect(output).toContain('failure number xxxxx')
  })
})

describe('fold by bytes and width', () => {
  test('folds output with few lines but many bytes', () => {
    const text = Array.from({ length: 120 }, (_, i) => `row${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))} ${'word '.repeat(30)}`).join('\n')

    expect(shouldFold(`${text}\n`, 150)).toBe(true)
    expect(Buffer.byteLength(folded(`${text}\n`))).toBeLessThan(Buffer.byteLength(text) * 0.7)
  })

  test('clips lines wider than 300 characters', () => {
    const out = folded(`${'x'.repeat(1000)}\n`.repeat(1) + Array.from({ length: 200 }, (_, i) => `line ${'abc'.repeat(i % 7)}${String.fromCharCode(97 + (i % 26))}${i}z`).join('\n'))

    expect(out).toContain('... [+700 chars]')
  })

  test('keeps at most 40 important lines of the middle', () => {
    const text = Array.from({ length: 400 }, (_, i) => `step${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))} error in module ${'q'.repeat(i % 9)}`).join('\n')
    const out = folded(`${text}\n`)

    expect(out.split('\n').length).toBeLessThan(150)
  })
})
