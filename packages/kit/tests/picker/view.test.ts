import type { Theme } from '../../src/picker/view'
import { describe, expect, test } from 'bun:test'
import { createState, press } from '../../src/picker/state'
import { caretColumn, layoutFor, parseHeight, render } from '../../src/picker/view'

const plain: Theme = { accent: text => text, label: text => text, value: text => text, id: text => text }
const tagged: Theme = { accent: text => `<${text}>`, label: text => `~${text}~`, value: text => `*${text}*`, id: text => `#${text}#` }

describe('parseHeight', () => {
  test('reads lines and percentages', () => {
    expect(parseHeight('12')).toEqual({ lines: 12 })
    expect(parseHeight('50%')).toEqual({ percent: 50 })
    expect(parseHeight('250%')).toEqual({ percent: 100 })
    expect(parseHeight('0')).toBeUndefined()
    expect(parseHeight('tall')).toBeUndefined()
    expect(parseHeight('-3')).toBeUndefined()
  })
})

describe('layoutFor', () => {
  test('takes the height from lines or percent, kept between four lines and the terminal', () => {
    expect(layoutFor({ columns: 60, rows: 50 }, { percent: 40 }, false).height).toBe(20)
    expect(layoutFor({ columns: 60, rows: 50 }, { lines: 2 }, false).height).toBe(4)
    expect(layoutFor({ columns: 60, rows: 10 }, { lines: 30 }, false).height).toBe(10)
    expect(layoutFor({ columns: 60, rows: 3 }, { lines: 30 }, false).height).toBe(3)
  })

  test('splits for a preview only when the terminal is wide enough', () => {
    expect(layoutFor({ columns: 100, rows: 30 }, { lines: 10 }, true)).toEqual({ height: 10, listHeight: 10, listWidth: 50, previewWidth: 47, previewHeight: 0 })
    expect(layoutFor({ columns: 79, rows: 30 }, { lines: 10 }, true).previewWidth).toBe(0)
    expect(layoutFor({ columns: 100, rows: 30 }, { lines: 10 }, false).previewWidth).toBe(0)
  })
})

describe('render', () => {
  const layout = layoutFor({ columns: 40, rows: 20 }, { lines: 6 }, false)

  test('draws the key legend in place of the list while help is open, any key closing it', () => {
    const opened = press(createState(['one', 'two']), 'help')
    const lines = render(opened, layout, plain)

    expect(lines[0]).toBe('keys, any key closes this help')
    expect(lines.join('\n')).toContain('type to filter')
    expect(lines.join('\n')).not.toContain('❯')
    expect(press(opened, { text: 'x' }).help).toBe(false)
    expect(press(opened, { text: 'x' }).query).toBe('')
  })

  test('draws the prompt, the counts and the list with a pointer, exactly height lines', () => {
    const lines = render(createState(['one', 'two', 'three'], { prompt: '? ' }), layout, plain)

    expect(lines).toEqual(['? ', '  3/3  ctrl-/ keys', '❯ one', '  two', '  three', ''])
  })

  test('highlights the matched characters and the current line', () => {
    const lines = render(createState(['foo-bar', 'xbxax'], { query: 'ba' }), layout, tagged)

    expect(lines[0]).toBe('<> >ba')
    expect(lines[2]).toBe('<❯> *f**o**o**-*<b><a>*r*')
  })

  test('draws the matched characters with the match style of the theme when it has one', () => {
    const lines = render(createState(['foo-bar'], { query: 'ba' }), layout, { ...tagged, match: text => `_${text}_` })

    expect(lines[2]).toBe('<❯> *f**o**o**-*_b__a_*r*')
  })

  test('shows marks in --multi and counts them', () => {
    const state = press(createState(['one', 'two'], { multi: true }), 'tab')
    const lines = render(state, layout, plain)

    expect(lines[1]).toBe('  2/2 (1 marked)  ctrl-/ keys')
    expect(lines[2]).toBe('  ● one')
    expect(lines[3]).toBe('❯   two')
  })

  test('says so on an empty match list', () => {
    const lines = render(createState(['one'], { query: 'zz' }), layout, plain)

    expect(lines.slice(0, 3)).toEqual(['> zz', '  0/1  ctrl-/ keys', '  no match'])
  })

  test('scrolls to keep the highlighted line in view', () => {
    const items = Array.from({ length: 30 }, (_, index) => `item${index}`)
    let state = createState(items)

    for (let step = 0; step < 20; step++)
      state = press(state, 'down')

    const lines = render(state, layout, plain)

    expect(lines.filter(line => line.startsWith('❯'))).toEqual(['❯ item20'])
    expect(lines).toHaveLength(6)
  })

  test('cuts a long line to the width with an ellipsis', () => {
    const lines = render(createState(['a'.repeat(100)]), layout, plain)

    expect(lines[2]).toBe(`❯ ${'a'.repeat(37)}…`)
  })

  test('draws the preview in a right pane, cut to its width and height', () => {
    const wide = layoutFor({ columns: 80, rows: 20 }, { lines: 4 }, true)
    const lines = render(createState(['one']), wide, plain, ['line a', 'b'.repeat(100)])

    expect(lines).toHaveLength(4)
    expect(lines[0]).toBe(`>${' '.repeat(39)} │ line a`)
    expect(lines[1]).toBe(`  1/1  ctrl-/ keys${' '.repeat(22)} │ ${'b'.repeat(36)}…`)
    expect(lines[3]).toBe(`${' '.repeat(40)} │ `)
  })

  test('the caret sits after the query', () => {
    expect(caretColumn(createState(['a'], { query: 'ab' }), layout)).toBe(5)
  })
})

describe('render with a header, colors and a preview below', () => {
  test('the header sits under the counts and takes room from the list', () => {
    const layout = layoutFor({ columns: 40, rows: 20 }, { lines: 6 }, false)
    const lines = render(createState(['one', 'two', 'three', 'four'], { header: 'first\nsecond' }), layout, plain)

    expect(lines).toEqual(['> ', '  4/4 (1 of 4)  ctrl-/ keys', 'first', 'second', '❯ one', '  two'])
  })

  test('the colors of a cell survive, the matched characters being drawn by the theme', () => {
    const layout = layoutFor({ columns: 40, rows: 20 }, { lines: 6 }, false)
    const state = createState([{ hidden: [], cells: ['\x1B[31mred\x1B[0m', 'x'] }], { query: 'e' })
    const line = render(state, layout, tagged)[2]!

    expect(line).toBe('<❯> \x1B[31mr\x1B[0m<e>\x1B[31md\x1B[0m* ** **x*')
  })

  test('below, the preview takes 40% of the height under a rule, when the terminal is tall enough', () => {
    const layout = layoutFor({ columns: 30, rows: 30 }, { lines: 20 }, true, 'down')

    expect(layout).toMatchObject({ height: 20, listHeight: 12, previewHeight: 8, previewWidth: 0 })

    const lines = render(createState(['one']), layout, plain, ['p1', 'p2'])

    expect(lines).toHaveLength(20)
    expect(lines[12]).toBe('─'.repeat(30))
    expect(lines.slice(13, 15)).toEqual(['p1', 'p2'])
    expect(layoutFor({ columns: 30, rows: 8 }, { lines: 8 }, true, 'down').previewHeight).toBe(0)
  })
})
