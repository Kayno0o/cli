import { describe, expect, test } from 'bun:test'
import { highlight, languageOf, renderCode } from '../src/code'
import { renderMarkdown } from '../src/markdown'
import { themeFor } from '../src/theme'

const plain = themeFor({ isTTY: false }, {})
const tint = themeFor({ isTTY: true }, { FORCE_COLOR: '1' })

describe('languageOf', () => {
  test('reads an extension, a file name or a code block language', () => {
    expect(languageOf('src/a.ts')).toBe('script')
    expect(languageOf('config.YAML')).toBe('yaml')
    expect(languageOf('Dockerfile')).toBe('dockerfile')
    expect(languageOf('.editorconfig')).toBe('ini')
    expect(languageOf('json')).toBe('json')
    expect(languageOf('notes.txt')).toBeUndefined()
    expect(languageOf('')).toBeUndefined()
  })
})

describe('highlight', () => {
  test('leaves the text unchanged without colour', () => {
    const source = 'const a = "x" // note\nlet b = 12\n/* a\nb */\n'

    expect(highlight(source, 'script', plain)).toBe(source)
  })

  test('colours keywords, strings, numbers and comments', () => {
    const out = highlight('const a = "x" + 12 // c', 'script', tint)

    expect(out).toContain(tint.keyword('const'))
    expect(out).toContain(tint.string('"x"'))
    expect(out).toContain(tint.number('12'))
    expect(out).toContain(tint.dim('// c'))
  })

  test('draws json keys apart from string values', () => {
    const out = highlight('{"a": "b"}', 'json', tint)

    expect(out).toContain(tint.accent('"a"'))
    expect(out).toContain(tint.string('"b"'))
  })

  test('draws yaml keys and toml sections', () => {
    expect(highlight('name: x\n  - id: 1', 'yaml', tint)).toContain(tint.accent('id'))
    expect(highlight('[tool]\nkey = 1', 'toml', tint)).toContain(tint.heading('[tool]'))
  })

  test('paints a multi-line token a line at a time', () => {
    expect(highlight('/* a\nb */', 'script', tint)).toBe(`${tint.dim('/* a')}\n${tint.dim('b */')}`)
  })

  test('does not read a digit inside a word as a number', () => {
    expect(highlight('a1 b2', 'script', tint)).toBe('a1 b2')
  })
})

describe('renderCode', () => {
  test('numbers the lines when asked', () => {
    expect(renderCode('a\nb\n', 'script', plain, true)).toBe('1 │ a\n2 │ b\n')
    expect(renderCode('a\nb\n', 'script', plain, false)).toBe('a\nb\n')
  })

  test('shows the control characters of the file instead of sending them, a CRLF ending read as a line break', () => {
    expect(renderCode('x // \u001B]0;pwned\u0007\r\ny \u001B[2J\r\u009B\n', languageOf('a.ts'), plain, false)).toBe('x // ^[]0;pwned^G\ny ^[[2J^MM-^[\n')
    expect(renderCode('a\u0008\n', undefined, tint, true)).toContain('a^H')
  })
})

describe('markdown code blocks', () => {
  test('are highlighted by their language', () => {
    expect(renderMarkdown('```ts\nconst a = 1\n```\n', { theme: tint, width: 80 })).toContain(tint.keyword('const'))
    expect(renderMarkdown('```nope\nconst a = 1\n```\n', { theme: tint, width: 80 })).not.toContain(tint.keyword('const'))
  })
})

describe('shell commands', () => {
  test('draws the command of each pipeline step and the flags, and leaves the arguments', () => {
    const out = highlight('$ bun install -g pkg | tee out && ft ci --json', 'shell', tint)

    expect(Bun.stripANSI(out)).toBe('$ bun install -g pkg | tee out && ft ci --json')
    expect(out).toContain('\x1B[36mbun\x1B[39m install')
    expect(out).toContain('\x1B[36mtee\x1B[39m out')
    expect(out).toContain('\x1B[36mft\x1B[39m ci')
    expect(out).toContain('\x1B[33m-g\x1B[39m')
    expect(out).toContain('\x1B[33m--json\x1B[39m')
    expect(out).not.toContain('\x1B[36m$')
  })
})
