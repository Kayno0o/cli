import process from 'node:process'
import { formatDuration } from './format'
import { outputMode } from './mode'

type Env = Record<string, string | undefined>

// How long a command runs before its end is worth a notification.
export const NOTIFY_AFTER_MS = 10_000
// What a command stopped with Ctrl+C or cancelled exits with, an end the user saw.
const CANCELLED = 130

function base64(text: string): string {
  return Buffer.from(text).toString('base64')
}

function sanitizeOsc(text: string): string {
  // eslint-disable-next-line no-control-regex -- control characters and semicolons would break OSC framing
  return text.replaceAll(/[\x00-\x1F\x7F;]/g, ' ')
}

function wrapTmux(codes: string[], env: Env): string {
  return codes.map(code => env.TMUX === undefined || env.TMUX === '' ? code : `\x1BPtmux;${code.replaceAll('\x1B', '\x1B\x1B')}\x1B\\`).join('')
}

// A desktop notification in the terminal's escape codes: OSC 777 on WezTerm/foot/rxvt, OSC 9 on iTerm2/Windows Terminal, and Kitty's OSC 99 (`o=unfocused`) everywhere else; under tmux each goes through its passthrough, which needs `allow-passthrough on`.
export function notification(title: string, body: string, env: Env = process.env): string {
  const program = env.TERM_PROGRAM ?? ''
  const term = env.TERM ?? ''

  if (program === 'WezTerm' || term.startsWith('foot') || term.startsWith('rxvt'))
    return wrapTmux([`\x1B]777;notify;${sanitizeOsc(title)};${sanitizeOsc(body)}\x1B\\`], env)

  if (program === 'iTerm.app' || (env.WT_SESSION !== undefined && env.WT_SESSION !== ''))
    return wrapTmux([`\x1B]9;${sanitizeOsc(title)}: ${sanitizeOsc(body)}\x1B\\`], env)

  const id = `kit${process.pid}`
  const codes = [`\x1B]99;i=${id}:d=0:o=unfocused:e=1;${base64(title)}\x1B\\`, `\x1B]99;i=${id}:p=body:e=1;${base64(body)}\x1B\\`]

  return wrapTmux(codes, env)
}

// Once a command run on a terminal ends after NOTIFY_AFTER_MS or more, tells the desktop it is done or failed, for whoever went to another window meanwhile; nothing for an agent, CI or a pipe, nor for a command cancelled.
export function notifyEnd(command: string, code: number, ms: number, { stream = process.stderr, env = process.env }: { stream?: { isTTY?: boolean, write: (text: string) => unknown }, env?: Env } = {}): void {
  if (ms < NOTIFY_AFTER_MS || code === CANCELLED || outputMode(stream, env) !== 'terminal')
    return

  stream.write(notification(command, code === 0 ? `done in ${formatDuration(ms)}` : `failed with exit ${code} after ${formatDuration(ms)}`, env))
}
