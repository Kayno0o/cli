import { describe, expect, test } from 'bun:test'
import { bar, barChart, keyValue, sparkline, tree } from '../src/chart'

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
    expect(bar(0.5, { stream: { isTTY: true }, env: {}, width: 2 })).toBe('\x1B[36m━\x1B[39m\x1B[2m━\x1B[22m')
  })

  test('keyValue pads labels to the longest', () => {
    expect(keyValue([['state', 'open'], ['labels', 'a, b']], { stream: {}, env: {} })).toBe('state   open\nlabels  a, b')
  })

  test('barChart scales to the largest value and right-aligns the numbers', () => {
    expect(barChart([['ft', 40], ['db', 4]], { width: 10, stream: {}, env: {} })).toBe('ft  ━━━━━━━━━━  40\ndb  ━─────────   4')
  })
})

describe('tree', () => {
  const roots = [{ label: 'packages', children: [{ label: 'kit', children: [{ label: 'src' }, { label: 'tests' }] }, { label: 'ft' }] }, { label: 'README.md' }]

  test('hangs each child on a branch under its parent', () => {
    expect(tree(roots, { stream: {}, env: {} })).toBe('packages\n├─ kit\n│  ├─ src\n│  └─ tests\n└─ ft\nREADME.md')
  })

  test('dims the branches on a terminal', () => {
    expect(tree([{ label: 'a', children: [{ label: 'b' }] }], { stream: { isTTY: true }, env: {} })).toBe('a\n\x1B[2m└─\x1B[22m b')
  })
})
