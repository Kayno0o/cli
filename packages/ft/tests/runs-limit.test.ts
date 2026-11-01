import type { Run } from '../src/runs'
import { capture } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'
import { runs } from '../src/commands/runs'
import { withFakeTea } from './fake-tea'

function run(id: number): Record<string, unknown> {
  const found: Run = { id, status: 'success', workflow_id: 'test.yml', event: 'push', index_in_repo: id, title: '', commit_sha: 'abc', html_url: '', prettyref: 'main', started: '', stopped: '', duration: 0 }

  return { ...found }
}

describe('ft runs', () => {
  test('lists ten runs and counts the rest, --full and --json showing them all', async () => {
    await withFakeTea({ issues: [], runs: Array.from({ length: 12 }, (_, index) => run(index + 1)) }, async () => {
      const limited = await capture(async () => runs([]))

      expect(limited.out.split('\n').filter(line => line.includes('success'))).toHaveLength(10)
      expect(limited.out).toEndWith('2 more, rerun with --full\n')
      expect((await capture(async () => runs(['--full']))).out).not.toContain('more')
      expect((JSON.parse((await capture(async () => runs(['--json']))).out) as unknown[]).length).toBe(12)
    })
  })
})
