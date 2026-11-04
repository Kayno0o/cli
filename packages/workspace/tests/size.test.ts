import { linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'
import { pooled, sizeOf } from '../src/size'

const temp = tempDirs()

describe('sizeOf', () => {
  test('sums the files below, counts a symlink as itself and a hard link once', () => {
    const dir = temp('size-')
    const outside = temp('size-outside-')

    mkdirSync(join(dir, 'a', 'b'), { recursive: true })
    writeFileSync(join(dir, 'one'), 'x'.repeat(100))
    writeFileSync(join(dir, 'a', 'b', 'two'), 'x'.repeat(50))
    linkSync(join(dir, 'one'), join(dir, 'a', 'one-again'))
    writeFileSync(join(outside, 'big'), 'x'.repeat(100_000))
    symlinkSync(outside, join(dir, 'link'))

    const size = sizeOf(dir)

    expect(size).resolves.toBeGreaterThanOrEqual(150)
    expect(size).resolves.toBeLessThan(1000)
  })
})

describe('pooled', () => {
  test('keeps the order and the limit', async () => {
    let running = 0
    let peak = 0
    const results = await pooled([1, 2, 3, 4, 5, 6], 2, async (item) => {
      running++
      peak = Math.max(peak, running)
      await Bun.sleep(5)
      running--

      return item * 2
    })

    expect(results).toEqual([2, 4, 6, 8, 10, 12])
    expect(peak).toBe(2)
  })
})
