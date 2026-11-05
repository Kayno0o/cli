import { stripAnsi } from '@kaynooo/cli-kit'
import { describe, expect, test } from 'bun:test'
import { renderMarkdown } from '../src/markdown'
import { themeFor } from '../src/theme'

const plain = themeFor({ isTTY: false }, {})
const colour = themeFor({ isTTY: true }, {})
const show = (source: string, width = 40) => renderMarkdown(source, { theme: plain, width })

describe('renderMarkdown', () => {
  test('marks headings by level and wraps a paragraph to the width', () => {
    expect(show('# Title\n\n## Sub\n\nOne two three four five six seven eight nine ten eleven twelve thirteen.', 30)).toBe('# Title\n\n## Sub\n\nOne two three four five six\nseven eight nine ten eleven\ntwelve thirteen.\n')
  })

  test('keeps emphasis, code and a link readable without colour', () => {
    expect(show('**bold** *em* ~~gone~~ `code` [site](https://a.b)')).toBe('bold em gone `code` site (https://a.b)\n')
    expect(show('[https://a.b](https://a.b)')).toBe('https://a.b\n')
    expect(show('![logo](x.png) ![](y.png)')).toBe('[image: logo] [image: y.png]\n')
  })

  test('draws bullets by depth, numbers, and task boxes, wrapping behind the marker', () => {
    expect(show('- one\n  - nested\n- two\n\n1. first\n2. second\n\n- [x] done\n- [ ] todo')).toBe('- one\n  - nested\n- two\n\n1. first\n2. second\n\n✓ done\n○ todo\n')
    expect(show('1. an ordered item with long text that wraps around\n   - nested with long text that wraps around as well', 30)).toBe('1. an ordered item with long\n   text that wraps around\n   - nested with long text\n     that wraps around as well\n')
  })

  test('opens a quote with a mark and hangs the rest, and puts a code block between rules with no mark before its lines', () => {
    expect(show('> a quote with a very long line that needs to wrap around too', 30)).toBe('❝ a quote with a very long\n  line that needs to wrap\n  around too\n')
    expect(show('```ts\nconst a = 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10\n```', 80)).toBe(`ts ${'─'.repeat(2)}\nconst a = 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10\n${'─'.repeat(5)}\n`)
    expect(show('```\nx\n```', 30)).toBe(`${'─'.repeat(4)}\nx\n${'─'.repeat(4)}\n`)
  })

  test('lays a table out in columns with a rule under the header, wrapping cells that do not fit', () => {
    expect(show('| a | b |\n|---|--:|\n| 1 | 22 |')).toBe('a   b\n─────\n1  22\n')

    const narrow = show('| name | what it does |\n|---|---|\n| one | a description that is much too long for one line |', 30)

    expect(narrow.split('\n').every(line => Bun.stringWidth(line) <= 30)).toBe(true)
    expect(narrow).toContain('description')
  })

  test('draws a rule for a thematic break', () => {
    expect(show('a\n\n---\n\nb', 20)).toBe(`a\n\n${'─'.repeat(20)}\n\nb\n`)
  })

  test('colours on a terminal with the roles of the other CLIs', () => {
    const out = renderMarkdown('# Title\n\nsome `code` and **bold**', { theme: colour, width: 40 })

    expect(out).toContain('\u001B[36m')
    expect(out).toContain('\u001B[36mcode\u001B[39m')
    expect(out).toContain('\u001B[1mbold\u001B[22m')
    expect(Bun.stripANSI(out)).toBe('# Title\n\nsome `code` and bold\n')
  })
})

describe('block content and control characters', () => {
  test('a quote inside a tight list item stays on its own lines', () => {
    const out = stripAnsi(renderMarkdown('- item\n  > quoted\n- next\n', { theme: plain, width: 40 }))

    expect(Array.from(out).some(char => char < ' ' && char !== '\n')).toBe(false)
    expect(out).toContain('quoted')
    expect(out).toContain('next')
  })

  test('control characters in the source never reach the output', () => {
    const out = renderMarkdown('hello \u0001\u0005 world \u001B]0;title\u0007\n', { theme: plain, width: 40 })

    expect(Array.from(out).some(char => char < ' ' && char !== '\n')).toBe(false)
    expect(stripAnsi(out)).toContain('hello')
  })
})

describe('tables with wrapped cells', () => {
  test('put a blank line between the rows once one wraps, and stay compact otherwise', () => {
    const rows = '| name | what it does |\n|---|---|\n| one | a description that is much too long for one line |\n| two | short |'

    expect(show(rows, 30)).toContain('\n\ntwo')
    expect(show('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |')).toBe('a  b\n────\n1  2\n3  4\n')
  })
})

describe('table column sizing', () => {
  test('a long first cell wraps on its spaces while the description keeps the room it needs', () => {
    const table = '| Command | What it does |\n|---|---|\n| `ft runs` | recent runs |\n| `ft plan add <plan> <n>...` / `ft plan carry <from> <to>` | adds lines to a release plan checklist, or copies one plan unticked lines into the next |'
    const first = show(table, 90).split('\n').map(line => line.slice(0, 30).trimEnd())

    expect(first).toContain('`ft plan add <plan> <n>...` /')
  })
})
