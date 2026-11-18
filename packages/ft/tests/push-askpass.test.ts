import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { onTerminal } from '@kaynooo/cli-kit/test'
import { afterEach, expect, test } from 'bun:test'

const FIXTURE = `${import.meta.dir}/fixtures/push-askpass.ts`
// The user's global hooks and credential helpers stay out of the test repository.
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

let server: ReturnType<typeof Bun.serve> | undefined
let root = ''

afterEach(() => {
  void server?.stop(true)
  rmSync(root, { recursive: true, force: true })
})

test('the release push, in its own session, asks a remote\'s password on the terminal', async () => {
  const sent: string[] = []

  server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const authorization = request.headers.get('authorization')

      if (authorization === null)
        return new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="test"' } })

      sent.push(authorization)

      return new Response('', { status: 403 })
    },
  })

  root = realpathSync(mkdtempSync(join(tmpdir(), 'ft-push-askpass-')))
  const env = { ...process.env, ...GIT_ENV }

  for (const argv of [['init', '-q', '-b', 'main'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'one'], ['remote', 'add', 'origin', `http://127.0.0.1:${server.port}/repo.git`]])
    Bun.spawnSync(['git', ...argv], { cwd: root, env })

  const raw = await onTerminal([process.execPath, FIXTURE], async ({ until, type, raw }) => {
    await until(['Username for', 'push ended'])
    type('alice\r')
    await until(['Password for', 'push ended'])
    type('s3cret\r')
    await until('push ended')

    return raw()
  }, { cwd: root, env, cols: 100 })

  expect(sent).toEqual([`Basic ${btoa('alice:s3cret')}`])
  expect(raw).not.toContain('s3cret')
})
