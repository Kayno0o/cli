import process from 'node:process'
import { describe, expect, test } from 'bun:test'
import { onTerminal } from '../../src/test'

const FIXTURE = `${import.meta.dir}/fixtures/pick-then-read.ts`

async function hung(ms: number): Promise<'hung'> {
  await Bun.sleep(ms)

  return 'hung'
}

// Runs the fixture under a pseudo-terminal, typing `keys` once the picker is drawn and `next` once it has ended.
async function run(keys: string, next: string): Promise<{ code: number | 'hung', screen: string }> {
  return onTerminal([process.execPath, FIXTURE], async ({ until, type, exited, screen }) => {
    await until('install')
    type(keys)
    await until(['cancelled', 'picked'])
    type(next)
    const code = await Promise.race([exited, hung(2000)])

    return { code, screen: await screen() }
  })
}

describe('select on a real terminal', () => {
  test('esc gives the terminal back: the frame is erased, the process exits and the next key reaches what reads after', async () => {
    const { code, screen } = await run('\x1B', 'x')

    expect(screen).toBe('cancelled\nnext key x')
    expect(code).toBe(0)
  })

  // Fails once Bun fixes oven-sh/bun#47964: openTerminal can then read keys from the tty.ReadStream again.
  test('bun still holds the process when a tty.ReadStream is destroyed outside its data callback', async () => {
    await onTerminal([process.execPath, `${import.meta.dir}/fixtures/destroy-later.ts`], async ({ type, exited }) => {
      await Bun.sleep(300)
      type('a')
      expect(await Promise.race([exited, hung(500)])).toBe('hung')
    })
  })

  test('enter leaves the next key to the command run after the pick', async () => {
    const { code, screen } = await run('\r', 'y')

    expect(screen).toBe('picked id-1\nnext key y')
    expect(code).toBe(0)
  })

  // The fixture leads its own session, where no shell could resume a stopped job, so the kernel drops the stop and ctrl-z hands the keys straight back.
  test('ctrl-z where nothing could resume the process goes on picking', async () => {
    const { code, screen } = await run('\x1A\r', 'y')

    expect(screen).toBe('picked id-1\nnext key y')
    expect(code).toBe(0)
  })
})
