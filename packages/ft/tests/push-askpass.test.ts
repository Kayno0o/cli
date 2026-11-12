import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
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

// Fails rather than going on once five seconds have passed, so a prompt that never shows is not mistaken for a slow one.
async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; !done(); tries++) {
    if (tries === 250)
      throw new Error('the terminal never showed what the test waits for')

    await Bun.sleep(20)
  }
}

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

  const decoder = new TextDecoder()
  let screen = ''
  const proc = Bun.spawn([process.execPath, FIXTURE], { cwd: root, env, terminal: { cols: 100, rows: 24, data: (_, data) => void (screen += decoder.decode(data, { stream: true })) } })

  try {
    await until(() => screen.includes('Username for') || screen.includes('push ended'))
    proc.terminal?.write('alice\r')
    await until(() => screen.includes('Password for') || screen.includes('push ended'))
    proc.terminal?.write('s3cret\r')
    await until(() => screen.includes('push ended'))
  }
  finally {
    proc.kill()
    proc.terminal?.close()
  }

  expect(sent).toEqual([`Basic ${btoa('alice:s3cret')}`])
  expect(screen).not.toContain('s3cret')
})
