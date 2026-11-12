import { describe, expect, test } from 'bun:test'
import { pool } from '../src/pool'

describe('pool', () => {
  test('answers in the order of the items and never exceeds the limit in flight', async () => {
    let flying = 0
    let peak = 0
    const result = await pool([30, 1, 20, 1, 10], 2, async (ms) => {
      flying++
      peak = Math.max(peak, flying)
      await Bun.sleep(ms)
      flying--

      return ms * 2
    })

    expect(result).toEqual([60, 2, 40, 2, 20])
    expect(peak).toBe(2)
  })

  test('tells how many have finished out of all, once per item', async () => {
    const heard: [number, number][] = []

    await pool([30, 10, 20], 2, async ms => Bun.sleep(ms), (done, total) => void heard.push([done, total]))

    expect(heard).toEqual([[1, 3], [2, 3], [3, 3]])
  })

  test('answers empty for no items', async () => {
    expect(await pool([], 4, async x => x)).toEqual([])
  })
})
