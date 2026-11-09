import process from 'node:process'
import { describe, expect, test } from 'bun:test'

// What would mark the run as an agent's, CI's or tmux's, left out so the fixture runs as a person's command on a bare terminal.
const LEFT_OUT = new Set(['CLAUDECODE', 'AI_AGENT', 'CI', 'KIT_MODE', 'TMUX'])
// eslint-disable-next-line no-control-regex -- the notification's escape codes are what it reads
const NOTIFICATION = /\x1B\]99;[^;]*;([^\x1B]*)\x1B\\/g

// Runs the fixture under a pseudo-terminal, as a person would, and returns the title and body of the notifications it sent.
async function notified(which: 'cli' | 'main'): Promise<string[]> {
  const decoder = new TextDecoder()
  let screen = ''
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !LEFT_OUT.has(name)))
  const proc = Bun.spawn([process.execPath, `${import.meta.dir}/fixtures/slow-run.ts`, which], { env, terminal: { data: (_, data) => void (screen += decoder.decode(data, { stream: true })) } })

  await proc.exited
  proc.terminal?.close()

  return [...screen.matchAll(NOTIFICATION)].map(([, payload]) => Buffer.from(payload!, 'base64').toString())
}

describe('the notification at the end of a long run', () => {
  test('runCli names the bin and the command', async () => {
    expect(await notified('cli')).toEqual(['slowcli build', 'done in 11.0s'])
  })

  test('runMain names the bin and its failure', async () => {
    expect(await notified('main')).toEqual(['slowmain', 'failed with exit 3 after 11.0s'])
  })
})
