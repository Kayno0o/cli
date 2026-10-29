import { describe, expect, test } from 'bun:test'
import { plan } from '../src/commands/plan'
import { addLines } from '../src/plan'
import { withFakeTea } from './fake-tea'

const BODY = 'Release 1.72.\n\nBugs:\n- [ ] #1 one\n- [x] #2 two\n\nLarge features:\n- [ ] #3 three\n'

describe('addLines', () => {
  test('adds under the section\'s last box, or under its heading when it has none', () => {
    expect(addLines(BODY, ['- [ ] #9 nine'], 'Bugs:')).toBe('Release 1.72.\n\nBugs:\n- [ ] #1 one\n- [x] #2 two\n- [ ] #9 nine\n\nLarge features:\n- [ ] #3 three\n')
    expect(addLines('Notes\n\n**Bugs:**\n\nMore', ['- [ ] #9 nine'], 'bugs:')).toBe('Notes\n\n**Bugs:**\n- [ ] #9 nine\n\nMore')
  })

  test('creates a missing section at the end, and without a section follows the last box', () => {
    expect(addLines(BODY, ['- [ ] #9 nine'], 'Carried from 1.71.0:')).toBe(`${BODY}\nCarried from 1.71.0:\n- [ ] #9 nine\n`)
    expect(addLines(BODY, ['- [ ] #9 nine'])).toBe('Release 1.72.\n\nBugs:\n- [ ] #1 one\n- [x] #2 two\n\nLarge features:\n- [ ] #3 three\n- [ ] #9 nine\n')
    expect(addLines('Plain', ['- [ ] #9 nine'])).toBe('Plain\n\n- [ ] #9 nine')
  })

  test('keeps a Windows line end', () => {
    expect(addLines('Bugs:\r\n- [ ] #1 one\r\n', ['- [ ] #9 nine'], 'Bugs:')).toBe('Bugs:\r\n- [ ] #1 one\r\n- [ ] #9 nine\r\n')
  })
})

describe('plan', () => {
  test('adds issues with their titles under a section, skipping those listed', async () => {
    const issues = [
      { number: 10, title: 'plan', body: BODY, state: 'open' },
      { number: 1, title: 'one', body: '', state: 'open' },
      { number: 5, title: 'five', body: '', state: 'open' },
    ]
    const state = await withFakeTea({ issues }, async () => {
      expect(await plan(['add', '10', '1', '5', '--section', 'Bugs:'])).toBe(0)
    })

    expect(state.issues[0]?.body).toBe('Release 1.72.\n\nBugs:\n- [ ] #1 one\n- [x] #2 two\n- [ ] #5 five\n\nLarge features:\n- [ ] #3 three\n')
  })

  test('carries the unticked lines into the next plan, skipping those already there', async () => {
    const issues = [
      { number: 10, title: 'old', body: BODY, state: 'closed' },
      { number: 11, title: 'next', body: 'Next.\n\n- [ ] #3 three\n', state: 'open' },
    ]
    const state = await withFakeTea({ issues }, async () => {
      expect(await plan(['carry', '10', '11', '--section', 'Carried from 1.71.0:'])).toBe(0)
    })

    expect(state.issues[1]?.body).toBe('Next.\n\n- [ ] #3 three\n\nCarried from 1.71.0:\n- [ ] #1 one\n')
  })
})
