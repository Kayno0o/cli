import { describe, expect, test } from 'bun:test'
import { render, shape } from '../src/output'

const rows = [{ id: 1, note: 'a\tb\nc\\d', name: 'say "hi", ok' }, { id: 2, note: null, name: 'x'.repeat(200) }]

describe('render formats', () => {
  test('tsv escapes tabs, newlines and backslashes and keeps long cells whole', () => {
    const lines = render(shape(rows, 5, true), false, 'tsv').split('\n')

    expect(lines).toEqual(['id\tnote\tname', '1\ta\\tb\\nc\\\\d\tsay "hi", ok', `2\tNULL\t${'x'.repeat(200)}`])
  })

  test('csv quotes a cell holding a comma, a quote or a line break', () => {
    expect(render(shape(rows, 1, true), false, 'csv')).toBe('id,note,name\n1,"a\tb\nc\\d","say ""hi"", ok"')
  })

  test('vertical prints one padded column | value block per row', () => {
    expect(render(shape([{ id: 1, email: 'a@b' }, { id: 2, email: 'c@d' }], 5, true), false, 'vertical')).toBe('-[ RECORD 1 ]\nid    | 1\nemail | a@b\n-[ RECORD 2 ]\nid    | 2\nemail | c@d')
  })

  test('json wins over a format, and no rows print nothing in tsv', () => {
    expect((JSON.parse(render(shape(rows, 5, true), true, 'csv')) as { rows: unknown[] }).rows).toHaveLength(2)
    expect(render(shape([], 5, true), false, 'tsv')).toBe('')
  })
})
