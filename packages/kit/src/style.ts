import type { Mark, Role, Status } from './theme'
import process from 'node:process'
import { createColors } from '@kaynooo/utils/tools/colors'
import { outputMode } from './mode'
import { activeTheme, tinted } from './theme'

export type Colors = ReturnType<typeof createColors>

export type { Mark, Role, Status }

// The word each mark prints as off a terminal, so a log stays greppable whatever the theme draws on one.
const MARK_WORDS: Record<Mark, string> = { ok: 'ok:', warn: 'warning:', problem: 'error:', note: 'note:' }

// A terminal that draws in place: not a log or a pipe, not an agent that reads text and no drawing, nor a run that KIT_MODE says is CI or a pipe, and not asked for plain output by `NO_COLOR` or a dumb `TERM`.
export function takesControlCodes(stream: { isTTY?: boolean }, env: Record<string, string | undefined> = process.env): boolean {
  return stream.isTTY === true && env.NO_COLOR === undefined && env.NODE_DISABLE_COLORS === undefined && env.TERM !== 'dumb' && outputMode(stream, env) === 'terminal'
}

// Colours that write escapes only to a stream taking control codes.
export function paint(stream: { isTTY?: boolean }, env: Record<string, string | undefined> = process.env): Colors {
  return createColors({ stream: { isTTY: takesControlCodes(stream, env) }, env })
}

// `✓ text` on a terminal, `ok: text` elsewhere; `detail` follows dimmed.
export function marked(mark: Mark, text: string, stream: { isTTY?: boolean }, detail?: string, env: Record<string, string | undefined> = process.env): string {
  const colors = paint(stream, env)
  let head = MARK_WORDS[mark]

  if (takesControlCodes(stream, env)) {
    const { theme } = activeTheme()

    head = tinted(colors.bold, theme.colors[mark], env)(theme.glyphs[mark])
  }

  return `${head} ${text}${detail === undefined ? '' : ` ${colors.dim(detail)}`}`
}

export function ok(text: string, detail?: string): void {
  console.log(marked('ok', text, process.stdout, detail))
}

export function note(text: string, detail?: string): void {
  console.log(marked('note', text, process.stdout, detail))
}

export function warn(text: string, detail?: string): void {
  console.error(marked('warn', text, process.stderr, detail))
}

export function problem(text: string, detail?: string): void {
  console.error(marked('problem', text, process.stderr, detail))
}

// `role('id', process.stdout)('#49')`: plain text on a stream that takes no control codes.
export function role(name: Role, stream: { isTTY?: boolean }, env: Record<string, string | undefined> = process.env): (text: string) => string {
  const colors = paint(stream, env)

  return takesControlCodes(stream, env) ? tinted(colors, activeTheme().theme.colors[name], env) : colors
}

// The words CI services report each status by.
const STATUS_WORDS: Record<Status, string[]> = {
  passed: ['passed', 'success', 'succeeded', 'ok'],
  failed: ['failed', 'failure', 'error', 'errored'],
  running: ['running', 'in_progress', 'started', 'holding'],
  queued: ['queued', 'waiting', 'pending', 'created', 'blocked', 'scheduled'],
  skipped: ['skipped', 'cancelled', 'canceled', 'manual'],
}

const STATUS_OF = new Map(Object.entries(STATUS_WORDS).flatMap(([status, words]) => words.map(word => [word, status as Status])))

// The status a word such as `success` or `in_progress` stands for, undefined for one it does not know.
export function statusOf(word: string): Status | undefined {
  return STATUS_OF.get(word.toLowerCase())
}

// `✓ success` in green, `✗ failure` in red, `● running`, `○ waiting` or `- skipped` on a terminal; the word alone elsewhere, and a word of no known status as given.
export function badge(word: string, stream: { isTTY?: boolean }, env: Record<string, string | undefined> = process.env): string {
  const status = statusOf(word)

  if (status === undefined || !takesControlCodes(stream, env))
    return word

  const { theme } = activeTheme()

  return tinted(paint(stream, env), theme.colors[status], env)(`${theme.glyphs[status]} ${word}`)
}

// `check › cli · 4 steps` with the bin in its own accent, bold, and the context dimmed, the accent the theme gives the bin or one of its accents picked by the bin's name so each keeps one colour everywhere; empty off a terminal, where a log has no use for it.
export function header(bin: string, context: string | undefined, stream: { isTTY?: boolean }, env: Record<string, string | undefined> = process.env): string {
  if (!takesControlCodes(stream, env))
    return ''

  const colors = paint(stream, env)
  const hash = [...bin].reduce((sum, char) => sum + char.charCodeAt(0), 0)
  const { theme } = activeTheme()
  const spec = theme.bins[bin] ?? theme.accents[hash % theme.accents.length]!
  const accent = tinted(typeof spec === 'string' && spec.split(' ').includes('bold') ? colors : colors.bold, spec, env)

  return `${accent(bin)}${context === undefined ? '' : colors.dim(` › ${context}`)}`
}

// A clickable OSC 8 link on a terminal; elsewhere `text (url)`, or the text alone when it is the url.
export function link(text: string, url: string, stream: { isTTY?: boolean }, env: Record<string, string | undefined> = process.env): string {
  if (takesControlCodes(stream, env))
    return `\x1B]8;;${url}\x1B\\${text}\x1B]8;;\x1B\\`

  return text === url ? text : `${text} (${url})`
}
