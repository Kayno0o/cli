import type { Gloss, Line } from './analyze'
import type { Note, NoteKind } from './match'
import type { Operator } from './shell'
import { paint, role } from '@kaynooo/cli-kit'

const OPERATORS: Record<Operator, string> = {
  '|': 'pipes the output into the next command',
  '|&': 'pipes the output and the errors into the next command',
  '&&': 'runs the next command only if this one succeeds',
  '||': 'runs the next command only if this one fails',
  ';': 'then runs the next command',
  '&': 'runs in the background',
}

const MAX_TEXT = 320
const INDENT = '  '

interface Stream { isTTY?: boolean, columns?: number }

function clip(text: string): string {
  if (text.length <= MAX_TEXT)
    return text

  const cut = text.slice(0, MAX_TEXT)
  const sentence = cut.lastIndexOf('. ')

  return sentence > MAX_TEXT / 2 ? cut.slice(0, sentence + 1) : `${cut.trimEnd()}...`
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  let current = ''

  for (const word of text.split(' ')) {
    if (current !== '' && current.length + 1 + word.length > width) {
      lines.push(current)
      current = word
    }
    else {
      current = current === '' ? word : `${current} ${word}`
    }
  }

  return current === '' ? lines : [...lines, current]
}

function rows(entries: { token: string, paintToken: (text: string) => string, text: string }[], stream: Stream, depth: number): string[] {
  const colors = paint(stream)
  const margin = INDENT.repeat(depth + 1)
  const gutter = Math.min(Math.max(...entries.map(entry => entry.token.length)), 28)
  const width = Math.max((stream.columns ?? 100) - margin.length - gutter - 2, 30)
  const out: string[] = []

  for (const entry of entries) {
    const [first = '', ...more] = wrap(clip(entry.text), width)
    const pad = ' '.repeat(Math.max(gutter - entry.token.length, 0))

    out.push(`${margin}${entry.paintToken(entry.token)}${pad}  ${first === '' ? '' : colors.dim(first)}`.trimEnd())

    for (const line of more)
      out.push(`${margin}${' '.repeat(gutter)}  ${colors.dim(line)}`)
  }

  return out
}

function painter(kind: NoteKind, stream: Stream): (text: string) => string {
  const roles: Record<NoteKind, Parameters<typeof role>[0]> = { option: 'label', value: 'value', argument: 'path', unknown: 'warn' }

  return role(roles[kind], stream)
}

function noteText(note: Note): string {
  if (note.text !== undefined)
    return note.text

  if (note.kind === 'unknown')
    return 'not in the man page'

  return note.kind === 'argument' ? 'argument' : ''
}

function block(gloss: Gloss, stream: Stream, depth: number): string[] {
  const colors = paint(stream)
  const margin = INDENT.repeat(depth)
  const out: string[] = []
  const summary = gloss.summary ?? (gloss.page === undefined ? 'no man page found' : undefined)
  const origin = gloss.source === 'help' ? '  (from --help)' : ''

  out.push(`${margin}${role('accent', stream)(colors.bold(gloss.name))}${summary === undefined ? '' : colors.dim(`  ${summary}`)}${colors.dim(origin)}`)

  const entries = [
    ...gloss.assigns.map(assign => ({ token: assign, paintToken: role('id', stream), text: 'sets this variable for the command only' })),
    ...gloss.notes.map(note => ({ token: note.token, paintToken: painter(note.kind, stream), text: noteText(note) })),
    ...gloss.redirects.map(redirect => ({ ...redirect, paintToken: role('path', stream) })),
  ]

  out.push(...rows(entries, stream, depth))

  for (const inner of gloss.substitutions) {
    out.push(`${margin}${INDENT}${colors.dim('$(')}${colors.dim(inner.line)}${colors.dim(')')}`)
    out.push(...render(inner, stream, depth + 2))
  }

  return out
}

export function render(line: Line, stream: Stream = process.stdout, depth = 0): string[] {
  const colors = paint(stream)
  const out: string[] = []

  for (const gloss of line.commands) {
    out.push(...block(gloss, stream, depth))

    if (gloss.next !== undefined)
      out.push(`${INDENT.repeat(depth)}${colors.dim(`${gloss.next} ${OPERATORS[gloss.next]}`)}`)
  }

  return out
}
