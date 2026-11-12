import type { Milestone } from '../src/milestones'
import { capture } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'
import { board } from '../src/commands/board'
import { edit, newIssue } from '../src/commands/issue'
import { milestone, milestones } from '../src/commands/milestone'
import { settleMilestone } from '../src/commands/release'
import { dueDate, dueOn, progress } from '../src/milestones'
import { refusal, withFakeTea } from './fake-tea'

const v1 = { id: 1, title: '1.0.0', state: 'open', due_on: '2026-12-01T00:00:00Z' }
const v2 = { id: 2, title: '2.0.0', state: 'open', due_on: '9999-12-31T00:00:00Z' }
const old = { id: 3, title: '0.9.0', state: 'closed', due_on: null }
const inV1 = { id: 1, title: '1.0.0' }

function issue(number: number, title: string, state: string, milestone?: typeof inV1) {
  return { number, title, body: '- [ ] a\n- [x] b', state, milestone }
}

describe('progress', () => {
  test('reads 100% only once every issue is closed', () => {
    expect(progress({ open_issues: 1, closed_issues: 250 } as Milestone)).toBe('99%')
    expect(progress({ open_issues: 0, closed_issues: 3 } as Milestone)).toBe('100%')
  })
})

describe('dueOn', () => {
  test('turns a date into the timestamp Forgejo takes and refuses a zero or malformed one', () => {
    expect(dueOn('2026-12-01')).toBe('2026-12-01T00:00:00.000Z')
    expect(() => dueOn('0001-01-01')).toThrow('YYYY-MM-DD')
    expect(() => dueOn('2026-02-30')).toThrow('YYYY-MM-DD')
    expect(() => dueOn('tomorrow')).toThrow('YYYY-MM-DD')
  })

  test('reads year 9999 and null as no due date', () => {
    expect([v1, v2, old].map(each => dueDate({ description: '', open_issues: 0, closed_issues: 0, ...each }))).toEqual(['2026-12-01', '', ''])
  })
})

describe('ft milestones', () => {
  const issues = [issue(1, 'one', 'closed', inV1), issue(2, 'two', 'closed', inV1), issue(3, 'three', 'open', inV1)]

  test('lists the open ones with counts, progress and due date', async () => {
    await withFakeTea({ issues, milestones: [v1, v2, old] }, async () => {
      const { out } = await capture(async () => milestones([]))

      expect(out).toContain('1.0.0')
      expect(out).toContain('1 open')
      expect(out).toContain('2 closed')
      expect(out).toContain('66%')
      expect(out).toContain('due 2026-12-01')
      expect(out).toContain('2.0.0')
      expect(out).not.toContain('due 9999')
      expect(out).not.toContain('0.9.0')
    })
  })

  test('--issues lists the open and closed issues of each milestone by title', async () => {
    await withFakeTea({ issues, milestones: [v1, v2] }, async () => {
      const { out } = await capture(async () => milestones(['--issues']))

      expect(out).toContain('1.0.0')
      expect(out).toContain('#3  three')
      expect(out).toContain('#1  one (closed)')
      expect(out).toContain('#2  two (closed)')
      expect(out.indexOf('#1')).toBeLessThan(out.indexOf('#2'))
      expect(await refusal(milestones(['--issues', '--json']))).toContain('--issues')
    })
  })

  test('--state closed and --json', async () => {
    await withFakeTea({ issues, milestones: [v1, old] }, async () => {
      expect((await capture(async () => milestones(['--state', 'closed']))).out).toContain('0.9.0')
      expect(JSON.parse((await capture(async () => milestones(['--json']))).out)).toEqual([{ id: 1, title: '1.0.0', state: 'open', description: '', open: 1, closed: 2, due: '2026-12-01' }])
      expect(await refusal(milestones(['--state', 'half']))).toContain('--state')
    })
  })
})

describe('--json with --limit', () => {
  const many = [v1, { ...v1, id: 4, title: '1.1.0' }, { ...v1, id: 5, title: '1.2.0' }]
  const open = [issue(1, 'a', 'open'), issue(2, 'b', 'open'), issue(3, 'c', 'open')]

  test('ft milestones --json is cut only by an explicit --limit', async () => {
    await withFakeTea({ issues: [], milestones: many }, async () => {
      expect(JSON.parse((await capture(async () => milestones(['--json']))).out)).toHaveLength(3)
      expect(JSON.parse((await capture(async () => milestones(['--json', '--limit', '2']))).out)).toHaveLength(2)
    })
  })

  test('ft board --json is cut only by an explicit --limit', async () => {
    await withFakeTea({ issues: open, milestones: [] }, async () => {
      expect(JSON.parse((await capture(async () => board(['--json']))).out)).toHaveLength(3)
      expect(JSON.parse((await capture(async () => board(['--json', '--limit', '2']))).out)).toHaveLength(2)
    })
  })
})

describe('ft milestone new', () => {
  test('creates one with no due_on unless --due is given', async () => {
    const state = await withFakeTea({ issues: [] }, async () => {
      expect((await capture(async () => milestone(['new', '1.1.0', '-d', 'next']))).out).toBe('milestone 1 1.1.0\n')
      expect((await capture(async () => milestone(['new', '1.2.0', '--due', '2026-12-24']))).out).toBe('milestone 2 1.2.0, due 2026-12-24\n')
    })
    const posts = (state.calls ?? []).filter(call => call.includes('POST'))

    expect(posts[0]?.join(' ')).toBe('api -X POST -f title=1.1.0 -f description=next repos/{owner}/{repo}/milestones')
    expect(posts[0]?.join(' ')).not.toContain('due_on')
    expect(posts[1]?.join(' ')).toContain('due_on=2026-12-24T00:00:00.000Z')
  })

  test('refuses a zero date and a missing title before calling Forgejo', async () => {
    const state = await withFakeTea({ issues: [] }, async () => {
      expect(await refusal(milestone(['new', 'x', '--due', '0001-01-01']))).toContain('YYYY-MM-DD')
      expect(await refusal(milestone(['new']))).toContain('title')
    })

    expect(state.calls ?? []).toEqual([])
  })
})

describe('ft milestone <m>', () => {
  test('shows the open issues like the board, found by title or id', async () => {
    const issues = [issue(1, 'one', 'closed', inV1), issue(3, 'three', 'open', inV1), issue(4, 'elsewhere', 'open')]

    await withFakeTea({ issues, milestones: [v1] }, async () => {
      const byTitle = (await capture(async () => milestone(['1.0.0']))).out

      expect(byTitle).toStartWith('milestone 1.0.0 (open, 1 open, 1 closed, 50%, due 2026-12-01)\n')
      expect(byTitle).toContain('available (1)')
      expect(byTitle).toContain('#3')
      expect(byTitle).not.toContain('elsewhere')
      expect((await capture(async () => milestone(['1']))).out).toBe(byTitle)
      const shown = JSON.parse((await capture(async () => milestone(['1.0.0', '--json']))).out) as { issues: { number: number }[] }

      expect(shown.issues.map(each => each.number)).toEqual([3])
      expect(await refusal(milestone(['9.9.9']))).toContain('no milestone 9.9.9')
    })
  })
})

describe('milestone on issues', () => {
  test('ft new -m and ft edit -m set it and -m \'\' clears it', async () => {
    const state = await withFakeTea({ issues: [issue(1, 'one', 'open')], milestones: [v1, v2] }, async () => {
      await capture(async () => newIssue(['-t', 'fresh', '-m', '1.0.0']))
      await capture(async () => edit(['1', '-m', '2']))
      await capture(async () => edit(['2', '-m', '']))
    })

    expect(state.issues.map(each => each.milestone?.title ?? null)).toEqual(['2.0.0', null])
    expect(state.calls?.filter(call => call[0] === 'issues' && call[1] === 'edit').map(call => call.join(' '))).toEqual(['issues edit 1 -m 2.0.0', 'issues edit 2 -m '])
  })

  test('an unknown milestone is refused before anything is written', async () => {
    const state = await withFakeTea({ issues: [issue(1, 'one', 'open')], milestones: [v1] }, async () => {
      expect(await refusal(newIssue(['-t', 'x', '-m', 'nope']))).toContain('no milestone nope')
      expect(await refusal(edit(['1', '-m', 'nope']))).toContain('it has: 1.0.0')
    })

    expect(state.issues).toHaveLength(1)
  })

  test('ft board -m keeps the issues of one milestone', async () => {
    await withFakeTea({ issues: [issue(1, 'in it', 'open', inV1), issue(2, 'not in it', 'open')], milestones: [v1] }, async () => {
      const { out } = await capture(async () => board(['-m', '1.0.0']))

      expect(out).toContain('in it')
      expect(out).not.toContain('not in it')
    })
  })
})

describe('ft milestone close', () => {
  const open = [issue(3, 'still open', 'open', inV1), issue(4, 'also open', 'open', inV1)]

  test('refuses while issues are open, naming them, and --force closes anyway', async () => {
    const state = await withFakeTea({ issues: open, milestones: [v1] }, async () => {
      const message = await refusal(milestone(['close', '1.0.0']))

      expect(message).toContain('2 open issues')
      expect(message).toContain('#3 still open')
      expect(message).toContain('#4 also open')
      await capture(async () => milestone(['close', '1.0.0', '--force']))
    })

    expect(state.milestones?.[0]?.state).toBe('closed')
  })

  test('closes one with none open', async () => {
    const state = await withFakeTea({ issues: [issue(1, 'done', 'closed', inV1)], milestones: [v1] }, async () => {
      expect((await capture(async () => milestone(['close', '1']))).out).toBe('closed milestone 1.0.0\n')
    })

    expect(state.milestones?.[0]?.state).toBe('closed')
  })
})

describe('release milestone', () => {
  test('lists the closed issues of the milestone named like the version and closes it', async () => {
    const issues = [issue(1, 'shipped', 'closed', inV1), issue(2, 'unrelated', 'closed')]
    const state = await withFakeTea({ issues, milestones: [v1, v2] }, async () => {
      const { out } = await capture(async () => settleMilestone('1.0.0', 'v1.0.0'))

      expect(out).toBe('milestone 1.0.0: 1 closed issue\n  #1 shipped\nclosed milestone 1.0.0\n')
    })

    expect(state.milestones?.map(each => each.state)).toEqual(['closed', 'open'])
  })

  test('does nothing when no milestone is named like the version', async () => {
    const state = await withFakeTea({ issues: [], milestones: [v2] }, async () => {
      expect((await capture(async () => settleMilestone('1.0.0', 'v1.0.0'))).out).toBe('')
    })

    expect(state.milestones?.[0]?.state).toBe('open')
  })
})
