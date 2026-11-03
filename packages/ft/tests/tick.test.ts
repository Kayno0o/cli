import { describe, expect, test } from 'bun:test'
import { chooseTarget, commentOn, fixed, tick } from '../src/commands/issue'
import { withFakeTea } from './fake-tea'

describe('tick --closed', () => {
  test('ticks the boxes listing a closed issue and leaves the open ones', async () => {
    const issues = [
      { number: 1, title: 'plan', body: '- [ ] #2 two\n- [ ] #3 three\n- [ ] #20 twenty\n- [x] #4 four\n- [ ] #99 gone', state: 'open' },
      { number: 2, title: 'two', body: '', state: 'closed' },
      { number: 3, title: 'three', body: '', state: 'open' },
      { number: 20, title: 'twenty', body: '', state: 'closed' },
    ]
    const state = await withFakeTea({ issues }, async () => {
      expect(await tick(['1', '--closed'])).toBe(0)
    })

    expect(state.issues[0]?.body).toBe('- [x] #2 two\n- [ ] #3 three\n- [x] #20 twenty\n- [x] #4 four\n- [ ] #99 gone')
  })
})

describe('tick', () => {
  test('rewrites the body without tea\'s --description-file, which tea 0.15 lacks', async () => {
    const state = await withFakeTea({ issues: [{ number: 5, title: 'x', body: '- [ ] one\n- [ ] two `$HOME`', state: 'open' }] }, async () => {
      expect(await tick(['5', '2'])).toBe(0)
    })

    expect(state.issues[0]?.body).toBe('- [ ] one\n- [x] two `$HOME`')
  })
})

describe('chooseTarget', () => {
  const held = (...numbers: number[]) => async () => numbers

  test('takes a leading number as the issue and keeps the rest', async () => {
    expect(await chooseTarget(['12', 'apples'], held(7), 'usage')).toEqual({ number: 12, rest: ['apples'], defaulted: false })
    expect(await chooseTarget(['#12'], held(), 'usage')).toEqual({ number: 12, rest: [], defaulted: false })
  })

  test('takes the one held issue otherwise, with every argument kept', async () => {
    expect(await chooseTarget(['one', 'two'], held(7), 'usage')).toEqual({ number: 7, rest: ['one', 'two'], defaulted: true })
    expect(await chooseTarget([], held(7), 'usage')).toEqual({ number: 7, rest: [], defaulted: true })
  })

  test('refuses when the session holds none or several', async () => {
    const runs = await Promise.allSettled([chooseTarget(['one'], held(), 'usage'), chooseTarget(['one'], held(7, 8), 'usage')])

    expect(runs.map(run => run.status === 'rejected' ? String(run.reason) : '')).toEqual(['holds none', 'holds several'].map(text => expect.stringContaining(text) as string))
  })
})

describe('a writer without an issue number', () => {
  test('exits 2 when the session holds no issue', async () => {
    await withFakeTea({ issues: [{ number: 5, title: 'x', body: '- [ ] one', state: 'open' }] }, async () => {
      const runs = await Promise.allSettled([tick(['one']), commentOn(['hello']), fixed([])])

      for (const run of runs) {
        expect(run.status).toBe('rejected')
        expect(String((run as PromiseRejectedResult).reason)).toContain('this session holds none')
      }
    })
  })
})
