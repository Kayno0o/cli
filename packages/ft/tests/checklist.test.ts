import { describe, expect, test } from 'bun:test'
import { boxes, setBoxes } from '../src/checklist'

const body = [
  '**Checklist:**',
  '- [ ] scaffold the package',
  '- [x] `ft runs` lists runs',
  '  * [ ] nested box',
  '```md',
  '- [ ] a box inside code',
  '```',
  '- [ ] `ft board` lists claims',
].join('\n')

describe('boxes', () => {
  test('numbers the boxes from 1, nested ones included and fenced ones left out', () => {
    expect(boxes(body).map(box => [box.number, box.done, box.text])).toEqual([
      [1, false, 'scaffold the package'],
      [2, true, '`ft runs` lists runs'],
      [3, false, 'nested box'],
      [4, false, '`ft board` lists claims'],
    ])
  })
})

describe('boxes in code and odd text', () => {
  const texts = (text: string) => boxes(text).map(box => box.text)

  test('a fence closes on its own character only, and a longer fence holds a shorter one', () => {
    expect(texts('```\n~~~\n- [ ] inside\n```\n- [ ] out')).toEqual(['out'])
    expect(texts('````\n```\n- [ ] inside\n```\n````\n- [ ] out')).toEqual(['out'])
    expect(texts('~~~\n```\n- [ ] inside\n~~~\n- [ ] out')).toEqual(['out'])
  })

  test('four spaces after a paragraph are code, but under a list item they nest', () => {
    expect(texts('text\n\n    - [ ] code')).toEqual([])
    expect(texts('- [ ] a\n    - [ ] nested')).toEqual(['a', 'nested'])
  })

  test('keeps a line separator inside the text', () => {
    expect(texts('- [ ] one\u2028two')).toEqual(['one\u2028two'])
  })
})

describe('setBoxes', () => {
  test('ticks by number and by text, changing nothing else', () => {
    const result = setBoxes(body, ['1', 'BOARD'], true)

    expect(result.changed.map(box => box.number)).toEqual([1, 4])
    expect(result.body).toBe(body.replace('- [ ] scaffold', '- [x] scaffold').replace('- [ ] `ft board`', '- [x] `ft board`'))
  })

  test('leaves a box already in the asked state alone', () => {
    expect(setBoxes(body, ['2'], true).changed).toEqual([])
  })

  test('unticks', () => {
    expect(setBoxes(body, ['2'], false).body).toContain('- [ ] `ft runs`')
  })

  test('keeps a Windows line end', () => {
    const crlf = body.replaceAll('\n', '\r\n')

    expect(setBoxes(crlf, ['1'], true).body).toBe(crlf.replace('- [ ] scaffold', '- [x] scaffold'))
  })

  test('ticks box N only when its text starts with the text given after the colon', () => {
    expect(setBoxes(body, ['4:`ft board`'], true).changed.map(box => box.number)).toEqual([4])
    expect(() => setBoxes(body, ['1:`ft board`'], true)).toThrow('no box matches 1:`ft board`')
  })

  test('reads N:text as text when box N does not start with it', () => {
    const times = '- [ ] a\n- [ ] b\n- [ ] 3:30 deploy'

    expect(setBoxes(times, ['3:30 deploy'], true).changed.map(box => box.number)).toEqual([3])
  })

  test('refuses an empty pick instead of matching every box', () => {
    expect(() => setBoxes('- [ ] only', [''], true)).toThrow('empty box pick')
    expect(() => setBoxes('- [ ] only', ['  '], true)).toThrow('empty box pick')
  })

  test('refuses an unknown or ambiguous pick', () => {
    expect(() => setBoxes(body, ['9'], true)).toThrow('no box matches 9')
    expect(() => setBoxes(body, ['ft'], true)).toThrow('ft matches 2 boxes: 2, 4')
  })
})
