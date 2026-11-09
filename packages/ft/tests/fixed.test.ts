import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { $ } from 'bun'
import { describe, expect, test } from 'bun:test'
import { fixed, joinShas } from '../src/commands/issue'
import { hintOf, refusal, withFakeTea } from './fake-tea'

// A clone of a bare origin holding one pushed commit per message, the shas returned oldest first.
async function withClone(messages: string[], run: (shas: string[]) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ft-fixed-')))
  const clone = join(root, 'clone')
  const home = process.cwd()
  const shas: string[] = []

  try {
    await $`git init -q --bare -b main ${join(root, 'origin.git')} && git clone -q ${join(root, 'origin.git')} ${clone}`.quiet()
    process.chdir(clone)
    // Each git call names the clone, so a timed-out test chdir-ing back under this one cannot send them to the real checkout.
    await $`git config user.name t && git config user.email t@t`.cwd(clone).quiet()

    for (const message of messages) {
      await $`git commit -q --allow-empty -m ${message}`.cwd(clone).quiet()
      shas.push((await $`git rev-parse HEAD`.cwd(clone).text()).trim())
    }

    await $`git push -q origin main && git remote set-head origin -a`.cwd(clone).quiet()
    await run(shas)
  }
  finally {
    process.chdir(home)
    await rm(root, { recursive: true, force: true })
  }
}

const issues = [{ number: 7, title: 'seven', body: '- [x] a\n- [ ] b', state: 'open' }]

describe('joinShas', () => {
  test('lists one, two or several commits', () => {
    expect(joinShas(['a'])).toBe('a')
    expect(joinShas(['a', 'b'])).toBe('a and b')
    expect(joinShas(['a', 'b', 'c'])).toBe('a, b and c')
  })
})

describe('fixed', () => {
  test('finds the commits on origin naming the issue, and ticks the boxes left with --tick', async () => {
    await withClone(['fix(x): the fix\n\n#7 - seven', 'chore: unrelated\n\n#70 - other', 'fix(x): its review follow-up\n\n#7 - seven', 'chore: later'], async (shas) => {
      const state = await withFakeTea({ issues }, async () => {
        expect(await fixed(['7', '--tick'])).toBe(0)
      })

      expect(state.issues[0]).toMatchObject({ state: 'closed', body: '- [x] a\n- [x] b' })
      expect(state.comments?.[7]).toEqual([`Fixed in ${shas[0]?.slice(0, 7)} and ${shas[2]?.slice(0, 7)}: fix(x): the fix`])
    })
  })

  test('skips commits that name the issue only as owner/repo#N', async () => {
    await withClone(['fix(x): the fix\n\n#7 - seven', 'chore: elsewhere\n\nSee other/repo#7 for this'], async (shas) => {
      const state = await withFakeTea({ issues }, async () => {
        expect(await fixed(['7', '--tick'])).toBe(0)
      })

      expect(state.comments?.[7]).toEqual([`Fixed in ${shas[0]?.slice(0, 7)}: fix(x): the fix`])
    })
  })

  test('ticks the line listing the issue in every open issue\'s checklist', async () => {
    const plan = '- [ ] #7 seven\n- [ ] #70 seventy\n- [ ] #8 eight\n- [ ] see #7 later'

    await withClone(['one'], async () => {
      const state = await withFakeTea({ issues: [{ number: 7, title: 'seven', body: 'done', state: 'open' }, { number: 9, title: 'plan', body: plan, state: 'open' }] }, async () => {
        expect(await fixed(['7', 'HEAD'])).toBe(0)
      })

      expect(state.issues[1]?.body).toBe('- [x] #7 seven\n- [ ] #70 seventy\n- [ ] #8 eight\n- [ ] see #7 later')
    })
  })

  test('does not post its comment twice when a rerun finds it already last', async () => {
    await withClone(['one'], async (shas) => {
      const line = `Fixed in ${shas[0]?.slice(0, 7)}: done`
      const state = await withFakeTea({ issues: [{ number: 7, title: 'seven', body: 'x', state: 'open' }], comments: { 7: [line] } }, async () => {
        expect(await fixed(['7', 'HEAD', '-m', 'done'])).toBe(0)
      })

      expect(state.comments?.[7]).toEqual([line])
      expect(state.issues[0]?.state).toBe('closed')
    })
  })

  test('names the commits given, and refuses boxes left without --tick', async () => {
    await withClone(['one', 'two'], async (shas) => {
      const state = await withFakeTea({ issues }, async () => {
        expect(await refusal(fixed(['7', 'HEAD~1', 'HEAD']))).toContain('1 boxes left')
        expect(await hintOf(fixed(['7', 'HEAD~1', 'HEAD']))).toBe('run `ft fixed 7 --tick` to tick them and close, or run `ft fixed 7 --force` to close with them left')
        expect(await fixed(['7', 'HEAD~1', 'HEAD', '--force', '-m', 'done'])).toBe(0)
      })

      expect(state.comments?.[7]).toEqual([`Fixed in ${shas[0]?.slice(0, 7)} and ${shas[1]?.slice(0, 7)}: done`])
      expect(state.issues[0]?.body).toBe('- [x] a\n- [ ] b')
    })
  })
})
