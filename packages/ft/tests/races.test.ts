import { describe, expect, test } from 'bun:test'
import { take } from '../src/commands/board'
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
  test('fails when another session claimed the issue at the same moment', async () => {
    const state = await withFakeTea({ issues: [open(5, 'x')], afterComment: { 5: ['Taken by session other-1.'] } }, async () => {
      expect(await refusal(take(['5', '--as', 'a-1']))).toContain('#5 was taken by other-1 at the same moment')
    })

    expect(state.comments?.[5]).toEqual(['Taken by session a-1.', 'Taken by session other-1.'])
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
