import { describe, expect, test } from 'bun:test'
import { parseHead, parseOptions } from '../src/man'
import { explain } from '../src/match'
import { parseLine } from '../src/shell'

const PAGE = `
NAME
       demo - a demo

OPTIONS
       -a, --all
              Do not ignore hidden entries.

       -f, --file=ARCHIVE
              Use ARCHIVE. Other-
              wise stdin.

       -e PATTERN, --regexp=PATTERN
              Use PATTERN.

       --color[=WHEN]
              Colour the output.

       -name pattern
              Match a name.

       -x
              Extract. Also
              -x inside the text is not an option.

SEE ALSO
       -z, nothing
`

const options = parseOptions(PAGE)

function notes(line: string) {
  const [step] = parseLine(line)

  return explain(step!.command.words.slice(1), options).map(note => [note.kind, note.token])
}

describe('parseHead', () => {
  test('reads flags and the placeholder', () => {
    expect(parseHead('-f, --file=ARCHIVE')).toEqual({ flags: ['-f', '--file'], argument: 'ARCHIVE', optional: false })
    expect(parseHead('--color[=WHEN]')).toEqual({ flags: ['--color'], argument: 'WHEN', optional: true })
    expect(parseHead('-e PATTERN, --regexp=PATTERN')).toMatchObject({ flags: ['-e', '--regexp'], argument: 'PATTERN' })
    expect(parseHead('-a')).toMatchObject({ flags: ['-a'], argument: undefined })
  })

  test('refuses text that is not an option list', () => {
    expect(parseHead('-z, nothing')).toBeUndefined()
    expect(parseHead('- a sentence')).toBeUndefined()
  })
})

describe('parseOptions', () => {
  test('keeps each description, joins hyphenated lines and stops at a section', () => {
    expect(options.map(option => option.flags)).toEqual([['-a', '--all'], ['-f', '--file'], ['-e', '--regexp'], ['--color'], ['-name'], ['-x']])
    expect(options[1]?.text).toBe('Use ARCHIVE. Otherwise stdin.')
    expect(options[5]?.text).toBe('Extract. Also -x inside the text is not an option.')
  })
})

describe('explain', () => {
  test('bundles short flags and takes the next word as a value', () => {
    expect(notes('demo -axf a.tar b')).toEqual([['option', '-a'], ['option', '-x'], ['option', '-f'], ['value', 'a.tar'], ['argument', 'b']])
  })

  test('reads an inline value of a short or long option', () => {
    expect(notes('demo -fa.tar --file=b.tar')).toEqual([['option', '-f'], ['value', 'a.tar'], ['option', '--file=b.tar']])
  })

  test('accepts a unique abbreviation of a long option and flags an unknown one', () => {
    expect(notes('demo --al --nope')).toEqual([['option', '--al'], ['unknown', '--nope']])
  })

  test('reads a single-dash long option whole and an optional value inline only', () => {
    expect(notes('demo -name "*.ts" --color x')).toEqual([['option', '-name'], ['value', '*.ts'], ['option', '--color'], ['argument', 'x']])
  })

  test('treats what follows -- as arguments', () => {
    expect(notes('demo -a -- -x')).toEqual([['option', '-a'], ['option', '--'], ['argument', '-x']])
  })

  test('gives the offsets of each flag in a bundle', () => {
    const [step] = parseLine('demo -ax')

    expect(explain(step!.command.words.slice(1), options).map(note => [note.start, note.end])).toEqual([[6, 7], [7, 8]])
  })
})
