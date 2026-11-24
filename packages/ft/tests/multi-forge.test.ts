import { capture } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'
import { take } from '../src/commands/board'
import { digest } from '../src/commands/digest'
import { dispatch } from '../src/commands/dispatch'
import { logs } from '../src/commands/logs'
import { pr } from '../src/commands/pr'
import { play, retry } from '../src/commands/retry'
import { runs } from '../src/commands/runs'
import { withFakeForge } from './fake-tea'

describe('multi-forge CI, logs, retry, and play', () => {
  test('GitLab pipelines list, structured errs log parsing, retry, play, and dispatch', async () => {
    await withFakeForge('gitlab', {
      issues: [],
      runs: [
        { id: 700, iid: 12, sha: 'abc1234', ref: 'main', status: 'failed', source: 'push', web_url: 'https://gitlab/pipelines/700', duration: 42, started_at: '2026-10-23T10:00:00Z' },
      ],
      jobs: {
        700: [
          { id: 901, name: 'typecheck', stage: 'test', status: 'failed', allow_failure: false, tag_list: ['docker'], web_url: 'https://gitlab/jobs/901' },
          { id: 902, name: 'deploy-prod', stage: 'deploy', status: 'manual', allow_failure: false, tag_list: [], web_url: 'https://gitlab/jobs/902' },
        ],
      },
      logs: {
        901: '2026-10-23T10:00:01Z 00O src/app.ts(14,5): error TS2322: Type \'string\' is not assignable to type \'number\'.\nERROR: Job failed: exit code 1\n',
      },
    }, async () => {
      const listed = await capture(async () => runs(['--json']))

      expect(listed.result).toBe(0)
      expect(JSON.parse(listed.out)).toMatchObject([{ id: 700, status: 'failure', ref: 'main' }])

      const logged = await capture(async () => logs(['700', '--json']))
      const logJson = JSON.parse(logged.out) as { failedJobs: { excerpt: string }[] }

      expect(logJson.failedJobs[0]?.excerpt).toContain('src/app.ts:14:5: Type \'string\' is not assignable to type \'number\'. (TS2322)')

      const retried = await capture(async () => retry(['700', '--json']))

      expect(retried.result).toBe(0)
      expect(JSON.parse(retried.out)).toMatchObject({ id: 700, status: 'running' })

      const played = await capture(async () => play(['700', '-j', 'deploy-prod', '--json']))

      expect(played.result).toBe(0)
      expect(JSON.parse(played.out)).toMatchObject({ id: 902, name: 'deploy-prod', status: 'running' })

      const triggered = await capture(async () => dispatch(['--ref', 'main', '-i', 'ENV=staging', '--json']))

      expect(triggered.result).toBe(0)
      expect(JSON.parse(triggered.out)).toMatchObject({ ref: 'main', workflow: 'pipeline' })
    })
  })

  test('GitHub Actions runs list, logs, and rerun', async () => {
    await withFakeForge('github', {
      issues: [],
      runs: [
        { id: 400, run_number: 8, name: 'CI', path: '.github/workflows/ci.yml', head_sha: 'def5678', head_branch: 'main', event: 'push', status: 'completed', conclusion: 'failure', html_url: 'https://github/runs/400', run_started_at: '2026-10-23T10:00:00Z', updated_at: '2026-10-23T10:01:00Z' },
      ],
      jobs: {
        400: [{ id: 501, name: 'lint', status: 'completed', conclusion: 'failure', labels: ['ubuntu-latest'], html_url: 'https://github/jobs/501' }],
      },
      logs: {
        501: '2026-10-23T10:00:05Z src/index.ts(2,1): error TS2304: Cannot find name \'foo\'.\n',
      },
    }, async () => {
      const listed = await capture(async () => runs(['--json']))

      expect(JSON.parse(listed.out)).toMatchObject([{ id: 400, workflow: 'ci.yml', status: 'failure' }])

      const logged = await capture(async () => logs(['400', '--json']))
      const ghLogJson = JSON.parse(logged.out) as { failedJobs: { excerpt: string }[] }

      expect(ghLogJson.failedJobs[0]?.excerpt).toContain('Cannot find name \'foo\'')

      const retried = await capture(async () => retry(['400', '--json']))

      expect(retried.result).toBe(0)
    })
  })
})

describe('fg pr across Forgejo, GitHub, and GitLab', () => {
  test.each(['forgejo', 'github', 'gitlab'] as const)('%s lists, views, creates, and merges PRs/MRs', async (provider) => {
    const final = await withFakeForge(provider, {
      issues: [],
      pulls: [
        { number: 3, title: 'Add unified forge', body: 'Details here', state: 'open', head: 'feat/forge', base: 'main', comments: ['LGTM'] },
      ],
    }, async () => {
      const listed = await capture(async () => pr(['list', '--json']))

      expect(listed.result).toBe(0)
      expect(JSON.parse(listed.out)).toMatchObject([{ number: 3, title: 'Add unified forge', state: 'open', head: 'feat/forge', base: 'main' }])

      const viewed = await capture(async () => pr(['view', '3', '-c', '--diff', '--json']))
      const viewJson = JSON.parse(viewed.out) as { number: number, body: string, comments: unknown[], diff: string }

      expect(viewJson).toMatchObject({ number: 3, body: 'Details here' })
      expect(viewJson.comments).toHaveLength(1)
      expect(viewJson.diff).toContain('+new')

      const created = await capture(async () => pr(['create', '-t', 'Second PR', '-b', 'Body', '--head', 'feat/two', '--base', 'main', '--draft', '--json']))

      expect(created.result).toBe(0)
      expect(JSON.parse(created.out)).toMatchObject({ number: 4, head: 'feat/two', base: 'main', draft: true })

      const merged = await capture(async () => pr(['merge', '3', '--squash', '--delete-branch', '--json']))

      expect(merged.result).toBe(0)
      expect(JSON.parse(merged.out)).toEqual({ number: 3, merged: true, method: 'squash', deletedBranch: true })
    })

    expect(final.pulls?.find(each => each.number === 3)?.state).toBe('merged')
    expect(final.pulls?.find(each => each.number === 4)?.head).toBe('feat/two')
  })
})

describe('digest -r isolation and non-Claude claims', () => {
  test('digest -r skips cwd dirty/unpushed state for another repository', async () => {
    await withFakeForge('forgejo', { issues: [], runs: [], defaultBranch: 'main' }, async () => {
      const res = await capture(async () => digest(['-r', 'other/unrelated-repo', '--json']))
      const data = JSON.parse(res.out) as { dirty: unknown[], unpushed: unknown[], stale: unknown[] }

      expect(res.result).toBe(0)
      expect(data.dirty).toEqual([])
      expect(data.unpushed).toEqual([])
      expect(data.stale).toEqual([])
    })
  })

  test('take works via FORGE_SESSION without Claude Code session', async () => {
    const saved = process.env.FORGE_SESSION

    process.env.FORGE_SESSION = 'codex-worker-1'

    try {
      const state = await withFakeForge('forgejo', {
        issues: [{ number: 5, title: 'Fix bug', body: '', state: 'open' }],
      }, async () => {
        const res = await capture(async () => take(['5']))

        expect(res.result).toBe(0)
        expect(res.out).toContain('took #5 as codex-worker-1')
      })

      expect(state.comments?.[5]).toContain('Taken by session codex-worker-1.')
    }
    finally {
      if (saved === undefined)
        Reflect.deleteProperty(process.env, 'FORGE_SESSION')
      else
        process.env.FORGE_SESSION = saved
    }
  })
})
