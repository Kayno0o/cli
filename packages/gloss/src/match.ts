import type { OptionDoc } from './man'
import type { Word } from './shell'

export type NoteKind = 'option' | 'value' | 'argument' | 'unknown'

export interface Note {
  kind: NoteKind
  // What was typed: `-x`, `--file=a.tar`, `a.tar`.
  token: string
  start: number
  end: number
  // The man page's description for an option, or what the word is for a value.
  text: string | undefined
}

function takesValue(option: OptionDoc): boolean {
  return option.argument !== undefined && !option.optional
}

function findFlag(options: OptionDoc[], flag: string): OptionDoc | undefined {
  return options.find(option => option.flags.includes(flag))
}

// A long option typed shorter, accepted when exactly one long option starts with it.
function findAbbreviation(options: OptionDoc[], flag: string): OptionDoc | undefined {
  const matching = options.filter(option => option.flags.some(candidate => candidate.startsWith('--') && candidate.startsWith(flag)))

  return matching.length === 1 ? matching[0] : undefined
}

// Explains the words after the command name: options (bundled short ones and `--long=value` included) with what the page says about them, the values they take, and the remaining arguments.
export function explain(words: Word[], options: OptionDoc[]): Note[] {
  const notes: Note[] = []
  let optionsEnded = false

  for (let index = 0; index < words.length; index++) {
    const word = words[index]!
    const { text, start, end } = word

    const valueOf = (option: OptionDoc, flag: string): void => {
      const next = words[index + 1]

      if (next === undefined)
        return

      notes.push({ kind: 'value', token: next.text, start: next.start, end: next.end, text: `the ${option.argument ?? 'value'} for ${flag}` })
      index++
    }

    if (optionsEnded || !text.startsWith('-') || text === '-') {
      notes.push({ kind: 'argument', token: text, start, end, text: undefined })

      continue
    }

    if (text === '--') {
      optionsEnded = true
      notes.push({ kind: 'option', token: text, start, end, text: 'ends the options: what follows is an argument, even when it starts with a dash' })

      continue
    }

    if (text.startsWith('--')) {
      const equals = text.indexOf('=')
      const flag = equals === -1 ? text : text.slice(0, equals)
      const option = findFlag(options, flag) ?? findAbbreviation(options, flag)

      notes.push({ kind: option === undefined ? 'unknown' : 'option', token: text, start, end, text: option?.text })

      if (option !== undefined && equals === -1 && takesValue(option))
        valueOf(option, flag)

      continue
    }

    // `-name` as a single-dash long option (find, java), before reading it as bundled short flags.
    const whole = findFlag(options, text)

    if (whole !== undefined && text.length > 2) {
      notes.push({ kind: 'option', token: text, start, end, text: whole.text })

      if (takesValue(whole))
        valueOf(whole, text)

      continue
    }

    for (let at = 1; at < text.length; at++) {
      const flag = `-${text[at]}`
      const option = findFlag(options, flag)

      if (option === undefined) {
        notes.push({ kind: 'unknown', token: flag, start: start + at, end: start + at + 1, text: undefined })

        continue
      }

      if (option.argument === undefined) {
        notes.push({ kind: 'option', token: flag, start: start + at, end: start + at + 1, text: option.text })

        continue
      }

      // The rest of the word is this option's value; without one, the next word is, unless the value is optional.
      const inline = text.slice(at + 1)

      notes.push({ kind: 'option', token: flag, start: start + at, end: start + at + 1, text: option.text })

      if (inline !== '')
        notes.push({ kind: 'value', token: inline, start: start + at + 1, end, text: `the ${option.argument} for ${flag}` })
      else if (takesValue(option))
        valueOf(option, flag)

      break
    }
  }

  return notes
}
