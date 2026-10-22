import type { Issue } from '../src/issues'
import type { Session } from '../src/sessions'
import process from 'node:process'
import { describe, expect, test } from 'bun:test'
import { holderSession, latestClaim, latestNote, releasedComment, takenComment } from '../src/claims'
import { renderBoard, standing } from '../src/commands/board'
import { currentSession } from '../src/sessions'

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

  test('reads a claim inside a longer comment, and ignores one quoted mid-line', () => {
    expect(latestClaim([{ body: 'Picking this up.\nTaken by session lane-80-1978.', created_at: at(1) }])?.holder).toBe('lane-80-1978')
    expect(latestClaim([{ body: 'as the "Taken by session x-1." comment said', created_at: at(1) }])).toBeUndefined()
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

describe('standing', () => {
  test('is available, taken by a live session, or away when no session here holds it', () => {
    const claim = { holder: 'kayjs-12', at: at(1) }

    expect(standing(undefined, []).state).toBe('available')
    expect(standing(claim, [session('kayjs-12')]).state).toBe('taken')
    expect(standing(claim, [session('kayjs-60')]).state).toBe('away')
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
  })
})

describe('renderBoard', () => {
  const issue = (number: number, body: string): Issue => ({ number, title: `issue ${number}`, body, state: 'open', html_url: '', comments: 0, labels: [{ name: 'kind/chore' }] })
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
