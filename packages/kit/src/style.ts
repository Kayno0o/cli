import process from 'node:process'
import { createColors } from '@kaynooo/utils/tools/colors'

export type Colors = ReturnType<typeof createColors>

export type Mark = 'ok' | 'warn' | 'problem' | 'note'

// The symbol each mark draws on a terminal, and the word it prints as anywhere else, so a log stays greppable.
const MARKS: Record<Mark, { symbol: string, word: string, paint: (colors: Colors) => (text: string) => string }> = {
  ok: { symbol: '✓', word: 'ok:', paint: colors => colors.green },
  warn: { symbol: '!', word: 'warning:', paint: colors => colors.yellow },
  problem: { symbol: '✗', word: 'error:', paint: colors => colors.red },
  note: { symbol: '·', word: 'note:', paint: colors => colors.dim },
}

// A terminal that draws in place: not a log or a pipe, and not asked for plain output by `NO_COLOR` or a dumb `TERM`.
export function takesControlCodes(stream: { isTTY?: boolean }, env: Record<string, string | undefined> = process.env): boolean {
  return stream.isTTY === true && env.NO_COLOR === undefined && env.NODE_DISABLE_COLORS === undefined && env.TERM !== 'dumb'
}

// Colours that write escapes only to a stream taking control codes.
export function paint(stream: { isTTY?: boolean }, env: Record<string, string | undefined> = process.env): Colors {
  return createColors({ stream: { isTTY: takesControlCodes(stream, env) }, env })
}

// `✓ text` on a terminal, `ok: text` elsewhere; `detail` follows dimmed.
export function marked(mark: Mark, text: string, stream: { isTTY?: boolean }, detail?: string, env: Record<string, string | undefined> = process.env): string {
  const colors = paint(stream, env)
  const { symbol, word, paint: tint } = MARKS[mark]
  const head = takesControlCodes(stream, env) ? tint(colors)(symbol) : word

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

export type Role = 'accent' | 'id' | 'path' | 'label' | 'value'

// The tint each kind of data is drawn in, so every CLI colours the same things the same way.
const ROLES: Record<Role, (colors: Colors) => (text: string) => string> = {
  accent: colors => colors.cyan,
  id: colors => colors.yellow,
  path: colors => colors.blue,
  label: colors => colors.dim,
  value: colors => colors.bold,
}

// `role('id', process.stdout)('#49')`: plain text on a stream that takes no control codes.
export function role(name: Role, stream: { isTTY?: boolean }, env: Record<string, string | undefined> = process.env): (text: string) => string {
  return ROLES[name](paint(stream, env))
}

// A clickable OSC 8 link on a terminal; elsewhere `text (url)`, or the text alone when it is the url.
export function link(text: string, url: string, stream: { isTTY?: boolean }, env: Record<string, string | undefined> = process.env): string {
  if (takesControlCodes(stream, env))
    return `\x1B]8;;${url}\x1B\\${text}\x1B]8;;\x1B\\`

  return text === url ? text : `${text} (${url})`
}
