import { describe, expect, test } from 'bun:test'
import { distance, exitCodeOf, runCommand, stripAnsi } from '../src'

describe('runCommand', () => {
  test('returns the output of both streams and the exit code', async () => {
    const ran = await runCommand(['sh', '-c', 'echo out; echo err >&2; exit 3'])

    expect(ran.code).toBe(3)
    expect(ran.text.split('\n').filter(Boolean).toSorted()).toEqual(['err', 'out'])
    expect(ran.chunks.map(chunk => chunk.stream).toSorted()).toEqual(['stderr', 'stdout'])
  })

  test('runs in a folder with an environment', async () => {
    expect((await runCommand(['sh', '-c', 'echo $WORD; pwd'], { cwd: '/', env: { WORD: 'hi' } })).text).toBe('hi\n/\n')
  })

  test('throws when the command cannot start', async () => {
    expect(runCommand(['/no/such/command'])).rejects.toThrow()
  })
})

describe('exitCodeOf', () => {
  test('a code, else 128 plus the signal', () => {
    expect(exitCodeOf(2, null)).toBe(2)
    expect(exitCodeOf(null, 'SIGTERM')).toBe(143)
    expect(exitCodeOf(null, 9)).toBe(137)
    expect(exitCodeOf(null, null)).toBe(129)
  })
})

describe('text', () => {
  test('stripAnsi removes colour and cursor codes', () => {
    expect(stripAnsi('\u001B[31mred\u001B[0m \u001B[2K ok')).toBe('red  ok')
  })

  test('distance counts edits', () => {
    expect(distance('kitten', 'sitting')).toBe(3)
    expect(distance('same', 'same')).toBe(0)
  })
})
