import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const real = { ...(await import('node:fs/promises')) }

// The first stat of a lock is held until `release`, so a second waiter can reap and take the lock in between.
let isHeld = false
const { promise: gate, resolve: release } = Promise.withResolvers<void>()

await mock.module('node:fs/promises', () => ({
  ...real,
  async stat(...args: Parameters<typeof real.stat>) {
    const result = await real.stat(...args)

    if (String(args[0]).endsWith('.lock') && !isHeld) {
      isHeld = true
      await gate
    }

    return result
  },
}))

const { withLocks } = await import('../src/files')

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp('/tmp/ev-locks-')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('withLocks', () => {
  test('keeps a waiter that saw a stale lock from removing the fresh lock a second waiter took after reaping it', async () => {
    const file = join(dir, 'counter')
    const lock = join(dir, '.counter.lock')
    let inside = 0
    let most = 0

    await writeFile(file, '0')
    await writeFile(lock, '1')
    await utimes(lock, 1, 1)

    const work = async () => withLocks([file], async () => {
      inside++
      most = Math.max(most, inside)
      await Bun.sleep(150)
      inside--
    })

    const first = work()

    await Bun.sleep(30)

    const second = work()

    await Bun.sleep(80)
    release()
    await Promise.all([first, second])

    expect(most).toBe(1)
  })

  test('takes over a stale lock whose reaper died and left its guard behind', async () => {
    const file = join(dir, 'value')

    await writeFile(file, '0')
    await writeFile(join(dir, '.value.lock'), '1')
    await writeFile(join(dir, '.value.lock.reap'), '1')
    await utimes(join(dir, '.value.lock'), 1, 1)
    await utimes(join(dir, '.value.lock.reap'), 1, 1)

    expect(await withLocks([file], async () => 'done')).toBe('done')
  })
})
