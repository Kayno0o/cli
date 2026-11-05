import { describe, expect, test } from 'bun:test'
import { bar, barChart, keyValue, sparkline, tree } from '../src/chart'
import { stripAnsi } from '../src/text'

describe('chart', () => {
  test('sparkline scales between the smallest and largest value', () => {
    expect(sparkline([1, 2, 3, 4, 5, 6, 7, 8])).toBe('▁▂▃▄▅▆▇█')
    expect(sparkline([5, 5, 5])).toBe('▄▄▄')
    expect(sparkline([])).toBe('')
  })

  test('bar fills in proportion and clamps', () => {
    const plain = { stream: {}, env: {}, width: 10 }

    expect(bar(0.5, plain)).toBe('━━━━━─────')
    expect(bar(2, plain)).toBe('━━━━━━━━━━')
    expect(bar(-1, plain)).toBe('──────────')
    expect(bar(0.5, { stream: { isTTY: true }, env: {}, width: 2 })).toBe('\x1B[38;5;141m━\x1B[39m\x1B[2m━\x1B[22m')
    // A full bar shows the whole shift from the first end of the gradient to the second, a part of one only the start of it.
    expect(bar(1, { stream: { isTTY: true }, env: { COLORTERM: 'truecolor' }, width: 2 })).toBe('\x1B[38;2;192;132;252m━\x1B[39m\x1B[38;2;103;232;249m━\x1B[39m\x1B[2m\x1B[22m')
  })

  test('keyValue pads labels to the longest', () => {
    expect(keyValue([['state', 'open'], ['labels', 'a, b']], { stream: {}, env: {} })).toBe('state   open\nlabels  a, b')
  })

  test('barChart draws no bars off a terminal and right-aligns the numbers', () => {
    expect(barChart([['ft', 40], ['db', 4]], { width: 10, stream: {}, env: {} })).toBe('ft  40\ndb   4')
  })

  test('draws nothing an agent cannot read: fractions, numbers, tabs and indents', () => {
    const agent = { stream: { isTTY: true }, env: { CLAUDECODE: '1' } }

    expect(barChart([['ft', 42], ['db', 30], ['pick', 7]], agent)).toBe('ft\t42/42\ndb\t30/42\npick\t7/42')
    expect(bar(0.5, agent)).toBe('50%')
    expect(sparkline([1, 5, 3], agent)).toBe('1 5 3')
    expect(keyValue([['state', 'open'], ['labels', 'ux']], agent)).toBe('state\topen\nlabels\tux')
    expect(tree([{ label: 'packages', children: [{ label: 'kit', children: [{ label: 'src' }] }, { label: 'ft' }] }], agent)).toBe('packages\n  kit\n    src\n  ft')
  })

  test('barChart scales to the largest value on a terminal', () => {
    const drawn = stripAnsi(barChart([['ft', 40], ['db', 4]], { width: 10, stream: { isTTY: true }, env: {} }))

    expect(drawn).toBe('ft  ━━━━━━━━━━  40\ndb  ━━━━━━━━━━   4')
  })
})

describe('tree', () => {
  const roots = [{ label: 'packages', children: [{ label: 'kit', children: [{ label: 'src' }, { label: 'tests' }] }, { label: 'ft' }] }, { label: 'README.md' }]

  test('marks a folder with a dot and a slash and a file with a small one, a guide per level above', () => {
    expect(tree(roots, { stream: {}, env: {} })).toBe('• packages/\n│ • kit/\n│ │ · src\n│ │ · tests\n│ · ft\n· README.md')
  })

  test('shades the folder dots by depth along the gradient, dims the guides and the file dots on a terminal', () => {
    const drawn = tree([{ label: 'a', children: [{ label: 'b' }] }], { stream: { isTTY: true }, env: {} })

    expect(drawn).toBe('\x1B[38;5;141m•\x1B[39m \x1B[36m\x1B[1ma/\x1B[22m\x1B[39m\n\x1B[2m│ \x1B[22m\x1B[2m·\x1B[22m b')
    expect(sparkline([1, 2], { stream: { isTTY: true }, env: {} })).toBe('\x1B[38;5;141m▁\x1B[39m\x1B[38;5;81m█\x1B[39m')
    expect(sparkline([1, 2], { stream: {}, env: {} })).toBe('▁█')
  })
})
