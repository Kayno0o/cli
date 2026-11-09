import { $ } from 'bun'
import { describe, expect, test } from 'bun:test'

const ROOT = new URL('..', import.meta.url).pathname

describe('the test preload', () => {
  test('makes this checkout\'s remotes unpushable from the git a test starts', async () => {
    const dry = await $`git push --dry-run origin HEAD:refs/heads/never`.cwd(ROOT).nothrow().quiet()

    expect(dry.exitCode).not.toBe(0)
    expect(dry.stderr.toString()).toContain('push-refused-in-tests')
  })
})
