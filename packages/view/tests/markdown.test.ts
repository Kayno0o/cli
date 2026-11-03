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
    expect(show('**bold** *em* ~~gone~~ `code` [site](https://a.b)')).toBe('bold em gone code site (https://a.b)\n')
    expect(show('[https://a.b](https://a.b)')).toBe('https://a.b\n')
    expect(show('![logo](x.png) ![](y.png)')).toBe('[image: logo] [image: y.png]\n')
  })

  test('draws bullets by depth, numbers, and task boxes, wrapping behind the marker', () => {
    expect(show('- one\n  - nested\n- two\n\n1. first\n2. second\n\n- [x] done\n- [ ] todo')).toBe('• one\n  ◦ nested\n• two\n\n1. first\n2. second\n\n✓ done\n○ todo\n')
    expect(show('1. an ordered item with long text that wraps around\n   - nested with long text that wraps around as well', 30)).toBe('1. an ordered item with long\n   text that wraps around\n   ◦ nested with long text\n     that wraps around as well\n')
  })

  test('bars a quote and a code block, the code left unwrapped', () => {
    expect(show('> a quote with a very long line that needs to wrap around too', 30)).toBe('▎ a quote with a very long\n▎ line that needs to wrap\n▎ around too\n')
    expect(show('```ts\nconst a = 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10\n```', 20)).toBe('│ const a = 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10\n')
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
    expect(out).toContain('\u001B[33mcode\u001B[39m')
    expect(out).toContain('\u001B[1mbold\u001B[22m')
    expect(Bun.stripANSI(out)).toBe('# Title\n\nsome code and bold\n')
  })
})
