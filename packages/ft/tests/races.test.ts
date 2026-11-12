import { Exit } from '@kaynooo/cli-kit'
import { describe, expect, test } from 'bun:test'
import { latestClaim } from '../src/claims'
import { drop, take } from '../src/commands/board'
import { edit, tick } from '../src/commands/issue'
import { comment, createIssue, editBody } from '../src/issues'
import { refusal, withFakeTea } from './fake-tea'

const open = (number: number, body: string) => ({ number, title: `issue ${number}`, body, state: 'open' })

describe('a lost update', () => {
  test('is written again from the body that replaced ours', async () => {
    const state = await withFakeTea({ issues: [open(5, '- [ ] one\n- [ ] two')], clobber: { 5: '- [ ] one\n- [ ] two\n- [ ] three' } }, async () => {
      expect(await tick(['5', '2'])).toBe(0)
    })

    expect(state.issues[0]?.body).toBe('- [ ] one\n- [x] two\n- [ ] three')
  })

  test('is not written to the wrong box when one was added above since the numbers were read', async () => {
    const state = await withFakeTea({ issues: [open(5, '- [ ] one\n- [ ] two')], clobber: { 5: '- [ ] zero\n- [ ] one\n- [ ] two' } }, async () => {
      expect(await refusal(tick(['5', '2:two']))).toContain('no box matches 2:two')
    })

    expect(state.issues[0]?.body).toBe('- [ ] zero\n- [ ] one\n- [ ] two')
  })

  test('--add-box adds to the body as it is right before the write', async () => {
    const state = await withFakeTea({ issues: [open(5, '- [ ] one')], clobber: { 5: '- [ ] one\n- [x] two' } }, async () => {
      expect(await edit(['5', '--add-box', 'three'])).toBe(0)
    })

    expect(state.issues[0]?.body).toBe('- [ ] one\n- [x] two\n- [ ] three')
  })
})

describe('take', () => {
  test('fails and withdraws when another session claimed the issue just before', async () => {
    const state = await withFakeTea({ issues: [open(5, 'x')], beforeComment: { 5: ['Taken by session other-1.'] } }, async () => {
      expect(await refusal(take(['5', '--as', 'a-1']))).toContain('#5 was taken by other-1 at the same moment')
    })

    expect(state.comments?.[5]).toEqual(['Taken by session other-1.', 'Taken by session a-1.', 'Withdrawn by session a-1.'])
    expect(latestClaim((state.comments?.[5] ?? []).map(body => ({ body, created_at: '2026-10-23T10:00:00Z' })))?.holder).toBe('other-1')
  })

  test('says how to withdraw its claim by hand when posting the withdrawal fails', async () => {
    await withFakeTea({ issues: [open(5, 'x')], beforeComment: { 5: ['Taken by session other-1.'] }, failures: [{ match: 'Withdrawn', message: 'boom', times: 1 }] }, async () => {
      let refused: unknown

      try {
        await take(['5', '--as', 'a-1'])
      }
      catch (error) {
        refused = error
      }

      expect(refused).toBeInstanceOf(Exit)
      expect((refused as Exit).message).toContain('#5 was taken by other-1 at the same moment, and withdrawing this claim failed: tea api repos/{owner}/{repo}/issues/5/comments: boom')
      expect((refused as Exit).hint).toContain('ft comment 5 \'Withdrawn by session a-1.\'')
    })
  })

  test('holds the issue when another session claimed it just after, as that one sees this claim first', async () => {
    const state = await withFakeTea({ issues: [open(5, 'x')], afterComment: { 5: ['Taken by session other-1.'] } }, async () => {
      expect(await take(['5', '--as', 'a-1'])).toBe(0)
    })

    expect(state.comments?.[5]).toEqual(['Taken by session a-1.', 'Taken by session other-1.'])
  })

  test('lets exactly one of two sessions take an issue they both check as free', async () => {
    let refusals: string[] = []

    const state = await withFakeTea({ issues: [open(5, 'x')], barrier: { match: 'issues/5/comments', method: 'POST', parties: 2 } }, async () => {
      refusals = await Promise.all([refusal(take(['5', '--as', 'a-1'])), refusal(take(['5', '--as', 'b-2']))])
    })

    const winner = refusals[0] === '' ? 'a-1' : 'b-2'

    expect(refusals.filter(each => each !== '')).toHaveLength(1)
    expect(refusals.join('')).toContain(`taken by ${winner} at the same moment`)
    expect(latestClaim((state.comments?.[5] ?? []).map(body => ({ body, created_at: '2026-10-23T10:00:00Z' })))?.holder).toBe(winner)
  })

  test('takes an issue nobody raced for', async () => {
    const state = await withFakeTea({ issues: [open(5, 'x')] }, async () => {
      expect(await take(['5', '--as', 'a-1'])).toBe(0)
    })

    expect(state.comments?.[5]).toEqual(['Taken by session a-1.'])
  })
})

describe('creating an issue', () => {
  test('finds the new one even when an older open issue has the same title and body', async () => {
    const issues = [open(1, 'same')]
    let created = 0

    await withFakeTea({ issues: issues.map(each => ({ ...each, title: 'twin' })) }, async () => {
      created = (await createIssue('twin', 'same', undefined, undefined)).number
    })

    expect(created).toBe(2)
  })
})

describe('tea arguments', () => {
  test('a comment starting with a dash is posted whole', async () => {
    const state = await withFakeTea({ issues: [open(5, 'x')] }, async () => {
      await comment(5, '- [ ] --force', 'owner/name')
    })

    expect(state.comments?.[5]).toEqual(['- [ ] --force'])
  })

  test('--repo goes before the issue number', async () => {
    const state = await withFakeTea({ issues: [open(5, 'x')] }, async () => {
      await editBody(5, () => 'y', 'owner/name')
    })

    expect(state.issues[0]?.body).toBe('y')
    expect(state.calls?.find(call => call[0] === 'issues')).toEqual(['issues', 'edit', '5', '-d', 'y'])
  })
})

describe('drop --stale', () => {
  test('refuses a claim of another session without --stale, naming the flag', async () => {
    const state = await withFakeTea({ issues: [open(5, 'x')], comments: { 5: ['Taken by session ghost-9.'] } }, async () => {
      expect(await refusal(drop(['5', '--as', 'a-1']))).toContain('taken by ghost-9, not a-1')
    })

    expect(state.comments?.[5]).toEqual(['Taken by session ghost-9.'])
  })

  test('releases a claim no live session answers to, in its holder\'s name, then says who did it', async () => {
    const state = await withFakeTea({ issues: [open(5, 'x')], comments: { 5: ['Taken by session ghost-9.'] } }, async () => {
      expect(await drop(['5', '--stale', '--as', 'a-1'])).toBe(0)
    })

    expect(state.comments?.[5]?.[1]).toBe('Released by session ghost-9.')
    expect(state.comments?.[5]?.[2]).toContain('released as stale by session a-1')
  })

  test('--dry-run without --all-stale is a usage error that writes nothing', async () => {
    const state = await withFakeTea({ issues: [open(5, 'x')], comments: { 5: ['Taken by session ghost-9.'] } }, async () => {
      expect(await refusal(drop(['5', '--stale', '--dry-run', '--as', 'a-1']))).toContain('--all-stale')
    })

    expect(state.comments?.[5]).toEqual(['Taken by session ghost-9.'])
  })

  test('--all-stale --dry-run lists them and writes nothing, and the real run releases each', async () => {
    const issues = [open(5, 'x'), open(6, 'y'), open(7, 'z')]
    const comments = { 5: ['Taken by session ghost-9.'], 6: ['Taken by session ghost-8.', 'Released by session ghost-8.'] }
    const dry = await withFakeTea({ issues, comments }, async () => {
      expect(await drop(['--all-stale', '--dry-run', '--as', 'a-1'])).toBe(0)
    })

    expect(dry.comments?.[5]).toEqual(['Taken by session ghost-9.'])

    const real = await withFakeTea({ issues, comments }, async () => {
      expect(await drop(['--all-stale', '--as', 'a-1'])).toBe(0)
    })

    expect(real.comments?.[5]?.[1]).toBe('Released by session ghost-9.')
    expect(real.comments?.[6]).toHaveLength(2)
  })
})
