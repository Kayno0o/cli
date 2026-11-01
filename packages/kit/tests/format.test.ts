import { describe, expect, test } from 'bun:test'
import { formatAge, formatChange, formatDelta, formatDuration, formatPercent, formatSeconds, printJson, table } from '../src/format'

describe('format', () => {
  test('gives the largest unit and the next one when not zero', () => {
    expect(formatSeconds(0)).toBe('0s')
    expect(formatSeconds(57)).toBe('57s')
    expect(formatSeconds(808)).toBe('13m 28s')
    expect(formatSeconds(3605)).toBe('1h')
    expect(formatSeconds(90_000)).toBe('1d 1h')
    expect(formatAge(Date.now() - 3 * 3600_000 - 60_000)).toBe('3h ago')
    expect(formatAge('not a date')).toBe('-')
  })

  test('pads every column but the last', () => {
    expect(table([['a', 'long', 'x'], ['bb', 'c', 'y']])).toBe('a   long  x\nbb  c     y')
  })

  test('formatDuration keeps a decimal under a minute', () => {
    expect(formatDuration(40)).toBe('0.0s')
    expect(formatDuration(1250)).toBe('1.3s')
    expect(formatDuration(59_900)).toBe('59.9s')
    expect(formatDuration(75_000)).toBe('1m 15s')
  })

  test('table flattens line breaks and cuts cells when given a width', () => {
    expect(table([['a', 'one\n  two three'], ['bb', 'x']], { cellWidth: 8 })).toBe('a   one two…\nbb  x')
  })
})

describe('table layout', () => {
  test('pads on the visible width, wide characters and colours included', () => {
    expect(table([['日本', 'x'], ['\x1B[31mab\x1B[0m', 'y']])).toBe('日本  x\n\x1B[31mab\x1B[0m    y')
  })

  test('right-aligns the columns asked for', () => {
    expect(table([['a', '1'], ['bb', '100']], { align: ['left', 'right'] })).toBe('a     1\nbb  100')
  })

  test('narrows the widest column to fit a width', () => {
    expect(table([['id', 'a very long title indeed'], ['x', 'short']], { fit: 20 })).toBe('id  a very long tit…\nx   short')
  })
})

describe('changes', () => {
  test('formats percentages and signed deltas', () => {
    expect(formatPercent(0.625)).toBe('63%')
    expect(formatDelta(3)).toBe('+3')
    expect(formatDelta(-3)).toBe('-3')
    expect(formatDelta(-0.2)).toBe('0')
  })

  test('paints a change by whether it improved', () => {
    expect(formatChange(10, 6, { stream: {}, env: {} })).toBe('-40%')
    expect(formatChange(0, 6, { stream: {} })).toBe('-')
    expect(formatChange(10, 6, { stream: { isTTY: true }, env: {} })).toBe('\x1B[32m-40%\x1B[39m')
    expect(formatChange(10, 6, { better: 'higher', stream: { isTTY: true }, env: {} })).toBe('\x1B[31m-40%\x1B[39m')
  })
})

describe('printJson', () => {
  test('prints the value indented on stdout', () => {
    const log = console.log
    const printed: unknown[] = []

    console.log = (text: unknown) => void printed.push(text)

    try {
      printJson({ a: [1] })
    }
    finally {
      console.log = log
    }

    expect(printed).toEqual(['{\n  "a": [\n    1\n  ]\n}'])
  })
})
