import process from 'node:process'
import { describe, expect, test } from 'bun:test'

const FIXTURE = `${import.meta.dir}/fixtures/pick-then-read.ts`

async function hung(ms: number): Promise<'hung'> {
  await Bun.sleep(ms)

  return 'hung'
}

// Fails rather than going on once two seconds have passed, so a screen that never shows what is awaited is not mistaken for a slow one.
async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; !done(); tries++) {
    if (tries === 100)
      throw new Error('the terminal never showed what the test waits for')

    await Bun.sleep(20)
  }
}

// Runs the fixture under a pseudo-terminal, typing `keys` once the picker is drawn and `next` once it has ended.
async function run(keys: string, next: string): Promise<{ code: number | 'hung', screen: string }> {
  const decoder = new TextDecoder()
  let screen = ''
  const proc = Bun.spawn([process.execPath, FIXTURE], { terminal: { cols: 80, rows: 24, data: (_, data) => void (screen += decoder.decode(data, { stream: true })) } })

  try {
    // Where colours are on, the picker draws each letter of a match in its own style, so the screen is read without them
    await until(() => Bun.stripANSI(screen).includes('install'))
    proc.terminal?.write(keys)
    await until(() => screen.includes('cancelled') || screen.includes('picked'))
    proc.terminal?.write(next)
    const code = await Promise.race([proc.exited, hung(2000)])

    return { code, screen }
  }
  finally {
    proc.kill()
    proc.terminal?.close()
  }
}

describe('select on a real terminal', () => {
  test('esc gives the terminal back: the process exits and the next key reaches what reads after', async () => {
    const { code, screen } = await run('\x1B', 'x')

    expect(screen).toContain('cancelled')
    expect(screen).toContain('next key x')
    expect(code).toBe(0)
  })

  // Fails once Bun fixes oven-sh/bun#47964: openTerminal can then read keys from the tty.ReadStream again.
  test('bun still holds the process when a tty.ReadStream is destroyed outside its data callback', async () => {
    const proc = Bun.spawn([process.execPath, `${import.meta.dir}/fixtures/destroy-later.ts`], { terminal: {} })

    try {
      await Bun.sleep(300)
      proc.terminal?.write('a')
      expect(await Promise.race([proc.exited, hung(500)])).toBe('hung')
    }
    finally {
      proc.kill()
      proc.terminal?.close()
    }
  })

  test('enter leaves the next key to the command run after the pick', async () => {
    const { code, screen } = await run('\r', 'y')

    expect(screen).toContain('picked id-1')
    expect(screen).toContain('next key y')
    expect(code).toBe(0)
  })
})
