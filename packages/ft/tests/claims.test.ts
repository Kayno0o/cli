import type { Session } from '@kaynooo/cli-kit'
import type { Issue } from '../src/issues'
import process from 'node:process'
import { currentSession } from '@kaynooo/cli-kit'
import { describe, expect, test } from 'bun:test'
import { claimable, firstClaimSince, holderSession, laneSuffix, latestClaim, latestNote, releasedComment, takenComment, withdrawnComment } from '../src/claims'
import { heldBy, renderBoard, standing } from '../src/commands/board'

const session = (name: string, pid = 1): Session => ({ name, pid, status: 'busy', cwd: '/w' })
const at = (minute: number) => `2026-10-22T21:${String(minute).padStart(2, '0')}:00+02:00`

describe('latestClaim', () => {
  test('takes the latest claim, in date order whatever the list order', () => {
    expect(latestClaim([
      { body: takenComment('kayjs-80'), created_at: at(30) },
      { body: 'Taken by session kayjs-60.', created_at: at(10) },
    ])).toEqual({ holder: 'kayjs-80', at: at(30) })
  })

  test('drops a claim its holder released, but not one released by another', () => {
    expect(latestClaim([{ body: takenComment('a-1'), created_at: at(1) }, { body: releasedComment('a-1'), created_at: at(2) }])).toBeUndefined()
    expect(latestClaim([{ body: takenComment('a-1'), created_at: at(1) }, { body: releasedComment('b-2'), created_at: at(2) }])?.holder).toBe('a-1')
  })

  test('reads a comment that is the claim alone, and ignores one quoted, fenced or inside a longer comment', () => {
    expect(latestClaim([{ body: 'Taken by session lane-80-1978.\r\n', created_at: at(1) }])?.holder).toBe('lane-80-1978')
    expect(latestClaim([{ body: 'Picking this up.\nTaken by session lane-80-1978.', created_at: at(1) }])).toBeUndefined()
    expect(latestClaim([{ body: '```\nTaken by session x-1.\n```', created_at: at(1) }])).toBeUndefined()
    expect(latestClaim([{ body: 'as the "Taken by session x-1." comment said', created_at: at(1) }])).toBeUndefined()
    expect(latestClaim([{ body: 'Taken by session cli-6b over from cli-6a, see above.', created_at: at(1) }])).toBeUndefined()
  })

  test('reads back a name holding a space, an accent, a slash or a final dot', () => {
    for (const name of ['fix login', 'café-1', 'a/b', 'v1.'])
      expect(latestClaim([{ body: takenComment(name), created_at: at(1) }])?.holder).toBe(name)

    expect(latestClaim([{ body: takenComment('fix login'), created_at: at(1) }, { body: releasedComment('fix login'), created_at: at(2) }])).toBeUndefined()
  })

  test('counts only the claims of the given author', () => {
    const comments = [{ body: takenComment('a-1'), created_at: at(1), user: { login: 'kaynooo' } }, { body: takenComment('b-2'), created_at: at(2), user: { login: 'stranger' } }]

    expect(latestClaim(comments, 'kaynooo')?.holder).toBe('a-1')
    expect(latestClaim(comments)?.holder).toBe('b-2')
  })
})

describe('claimable', () => {
  test('refuses a name a claim would not read back as it is', () => {
    expect(['fix login', 'café-1', 'a/b'].every(claimable)).toBe(true)
    expect(['', ' a', 'a ', 'a\nb', `a${String.fromCharCode(0x2028)}b`, 'a, b', 'a: b'].some(claimable)).toBe(false)
  })
})

describe('holderSession', () => {
  const sessions = [session('kayjs-60'), session('kayjs-80')]

  test('finds the session by its name, or a lane by the session it runs in', () => {
    expect(holderSession('kayjs-60', sessions)?.name).toBe('kayjs-60')
    expect(holderSession('lane-80-1978', sessions)?.name).toBe('kayjs-80')
    expect(holderSession('lane-fum-1922', sessions)).toBeUndefined()
    expect(holderSession('kayjs-12', sessions)).toBeUndefined()
  })
})

describe('laneSuffix', () => {
  test('names a lane after the end of the session name, which holderSession reads back', () => {
    expect(laneSuffix('kayjs-60')).toBe('60')
    expect(holderSession(`lane-${laneSuffix('cli-46')}-12`, [session('kayjs-46'), session('cli-46', 2)])?.name).toBe('kayjs-46')
    expect(laneSuffix('kayjs')).toBeUndefined()
    expect(laneSuffix('kayjs-')).toBeUndefined()
  })
})

describe('standing', () => {
  test('is available, taken by a live session, or away when no session here holds it', () => {
    const claim = { holder: 'kayjs-12', at: at(1) }

    expect(standing(undefined, []).state).toBe('available')
    expect(standing(claim, [session('kayjs-12')]).state).toBe('taken')
    expect(standing(claim, [session('kayjs-60')]).state).toBe('away')
  })
})

describe('heldBy', () => {
  test('keeps the issues taken by this session or its lanes, not another live session\'s', () => {
    const mine = session('cli-25', 7)
    const sessions = [mine, session('cli-26', 8)]
    const row = (number: number, holder?: string) => ({ issue: { number } as Issue, standing: standing(holder === undefined ? undefined : { holder, at: at(1) }, sessions), comments: [] })

    expect(heldBy([row(1, 'cli-25'), row(2, 'cli-26'), row(3), row(4, 'lane-25-4'), row(5, 'cli-9')], mine)).toEqual([1, 4])
  })
})

describe('currentSession', () => {
  test('finds the session among this process\'s ancestors', async () => {
    expect((await currentSession([session('other', 999_999_999), session('parent', process.ppid)]))?.name).toBe('parent')
    expect(await currentSession([session('other', 999_999_999)])).toBeUndefined()
  })
})

describe('latestNote', () => {
  test('is the latest comment that neither takes nor gives back the issue', () => {
    const comments = [
      { body: 'Partly landed in a384daa.', created_at: at(2) },
      { body: 'Taken by session kayjs-12.', created_at: at(3) },
      { body: 'Decisions: one box left.', created_at: at(1) },
      { body: 'Released by session kayjs-12.', created_at: at(4) },
    ]

    expect(latestNote(comments)?.body).toBe('Partly landed in a384daa.')
    expect(latestNote([{ body: 'Taken by session kayjs-12.', created_at: at(1) }])).toBeUndefined()
    expect(latestNote([{ body: withdrawnComment('kayjs-12'), created_at: at(1) }])).toBeUndefined()
  })
})

describe('a withdrawn take', () => {
  const race = [
    { body: takenComment('a-1'), created_at: at(1) },
    { body: takenComment('b-2'), created_at: at(1) },
    { body: takenComment('c-3'), created_at: at(1) },
    { body: withdrawnComment('b-2'), created_at: at(2) },
  ]

  test('reads as never made, the claim before it standing again', () => {
    expect(latestClaim(race)?.holder).toBe('c-3')
    expect(latestClaim([...race, { body: withdrawnComment('c-3'), created_at: at(3) }])?.holder).toBe('a-1')
    expect(latestClaim([{ body: withdrawnComment('a-1'), created_at: at(1) }])).toBeUndefined()
  })

  test('leaves the first claim posted after the checked comments as the race winner', () => {
    expect(firstClaimSince(race, 0)).toBe('a-1')
    expect(firstClaimSince(race, 1)).toBe('c-3')
    expect(firstClaimSince(race.slice(0, 1), 1)).toBeUndefined()
    expect(firstClaimSince([race[1]!, race[3]!, race[2]!], 0)).toBe('c-3')
  })
})

describe('renderBoard', () => {
  const issue = (number: number, body: string): Issue => ({ number, title: `issue ${number}`, body, state: 'open', html_url: '', comments: 0, labels: [{ name: 'kind/chore' }] })

  test('lists at most the limit of each section, counting the rest', () => {
    const rows = [1, 2, 3].map(number => ({ issue: issue(number, ''), standing: { state: 'available' } as const, comments: [] }))

    expect(renderBoard(rows, Date.now(), 2)).toBe('available (3)\n  #1  issue 1  kind/chore\n  #2  issue 2  kind/chore\n  1 more, rerun with --full')
    expect(renderBoard(rows, Date.now(), 3)).not.toContain('more')
  })
  const comment = (body: string, minute: number) => ({ body, created_at: at(minute), user: { login: 'kaynooo' } })

  test('shows boxes left on claims, and the latest note under one no live session holds', () => {
    const claim = { holder: 'lane-fum-7', at: at(1) }
    const text = renderBoard([
      { issue: issue(9, ''), standing: { state: 'available' }, comments: [] },
      { issue: issue(8, '- [x] a\n- [ ] b'), standing: { state: 'taken', claim: { holder: 'kayjs-12', at: at(1) }, session: session('kayjs-12') }, comments: [] },
      { issue: issue(7, '- [ ] a\n- [ ] b\n- [x] c'), standing: { state: 'away', claim }, comments: [comment('Taken by session lane-fum-7.', 1), comment('\nPartly landed in a384daa.\nmore', 2)] },
    ], Date.parse(at(1)) + 3_600_000)

    expect(text).toBe([
      'available (1)',
      '  #9  issue 9  kind/chore',
      '',
      'taken (1)',
      '  #8  kayjs-12 (busy)  1h ago  1/2 left  issue 8',
      '',
      'claimed, no live session here (1)',
      '  #7  lane-fum-7  1h ago  2/3 left  issue 7',
      '      kaynooo 59m ago: Partly landed in a384daa.',
    ].join('\n'))
  })
})
