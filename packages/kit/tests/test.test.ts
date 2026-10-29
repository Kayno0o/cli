import { expect, test } from 'bun:test'
import { capture } from '../src/test'

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
