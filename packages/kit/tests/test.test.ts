import { expect, test } from 'bun:test'
import { capture, onTerminal } from '../src/test'

test('capture returns what a function printed and its result', async () => {
  const captured = await capture(async () => {
    console.log('a', 1)
    console.error('b')
    process.stdout.write('c')

    return 7
  })

  expect(captured).toEqual({ result: 7, out: 'a 1\nc', err: 'b\n' })
})

test('capture restores the output when the function throws', async () => {
  const log = console.log

  expect(capture(async () => {
    throw new Error('x')
  })).rejects.toThrow('x')
  await Bun.sleep(0)
  expect(console.log).toBe(log)
})

test('onTerminal reads the screen as drawn: a line erased by a redraw is gone, a line wider than the terminal comes back whole', async () => {
  // Spaces where the line wraps, kept when the rows are joined back.
  const wide = `${'w'.repeat(17)}   ${'x'.repeat(10)}`
  const script = `process.stdout.write('spinner\\r\\x1B[Kdone\\n${wide}\\n'); await Bun.sleep(5000)`

  const { screen, raw } = await onTerminal([process.execPath, '-e', script], async ({ until, screen, raw }) => {
    await until(wide)

    return { screen: await screen(), raw: raw() }
  }, { cols: 20 })

  expect(screen).toBe(`done\n${wide}`)
  expect(raw).toContain('spinner')
})

test('onTerminal fails with the screen once what it waits for never shows', async () => {
  // eslint-disable-next-line ts/await-thenable -- bun types .rejects as void
  await expect(onTerminal([process.execPath, '-e', `console.log('hello'); await Bun.sleep(5000)`], async ({ until }) => until('bye', 300))).rejects.toThrow('the terminal never showed "bye":\nhello')
})
