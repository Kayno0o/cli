import { describe, expect, test } from 'bun:test'
import { tick } from '../src/commands/issue'
import { withFakeTea } from './fake-tea'

describe('tick', () => {
  test('rewrites the body without tea\'s --description-file, which tea 0.15 lacks', async () => {
    const state = await withFakeTea({ issues: [{ number: 5, title: 'x', body: '- [ ] one\n- [ ] two `$HOME`', state: 'open' }] }, async () => {
      expect(await tick(['5', '2'])).toBe(0)
    })

    expect(state.issues[0]?.body).toBe('- [ ] one\n- [x] two `$HOME`')
  })
})
