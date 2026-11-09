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

// A desktop notification in kitty's escape codes, shown only while the window is out of focus (`o=unfocused`), the title and the body sent apart under one id; under tmux each goes through its passthrough, which needs `allow-passthrough on`.
export function notification(title: string, body: string, env: Env = process.env): string {
  const id = `kit${process.pid}`
  const codes = [`\x1B]99;i=${id}:d=0:o=unfocused:e=1;${base64(title)}\x1B\\`, `\x1B]99;i=${id}:p=body:e=1;${base64(body)}\x1B\\`]

  return codes.map(code => env.TMUX === undefined || env.TMUX === '' ? code : `\x1BPtmux;${code.replaceAll('\x1B', '\x1B\x1B')}\x1B\\`).join('')
}

// Once a command run on a terminal ends after NOTIFY_AFTER_MS or more, tells the desktop it is done or failed, for whoever went to another window meanwhile; nothing for an agent, CI or a pipe, nor for a command cancelled.
export function notifyEnd(command: string, code: number, ms: number, { stream = process.stderr, env = process.env }: { stream?: { isTTY?: boolean, write: (text: string) => unknown }, env?: Env } = {}): void {
  if (ms < NOTIFY_AFTER_MS || code === CANCELLED || outputMode(stream, env) !== 'terminal')
    return

  stream.write(notification(command, code === 0 ? `done in ${formatDuration(ms)}` : `failed with exit ${code} after ${formatDuration(ms)}`, env))
}
