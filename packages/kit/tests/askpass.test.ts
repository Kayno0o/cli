import process from 'node:process'
import { afterEach, describe, expect, test } from 'bun:test'
import { askpass } from '../src/askpass'

const FIXTURE = `${import.meta.dir}/fixtures/askpass-git.ts`

let server: ReturnType<typeof Bun.serve> | undefined

afterEach(() => {
  void server?.stop(true)
})

// Fails rather than going on once five seconds have passed, so a prompt that never shows is not mistaken for a slow one.
async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; !done(); tries++) {
    if (tries === 250)
      throw new Error('the terminal never showed what the test waits for')

    await Bun.sleep(20)
  }
}

describe('askpass', () => {
  test('off a terminal it leaves git and ssh to ask as they always do', () => {
    expect(askpass(() => () => undefined)).toBeUndefined()
  })

  test('git asks through the paused progress line, the password masked, and the server gets what was typed', async () => {
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

    const decoder = new TextDecoder()
    let screen = ''
    const proc = Bun.spawn([process.execPath, FIXTURE, `http://127.0.0.1:${server.port}/repo.git`], { env: { ...process.env, NO_COLOR: undefined, KIT_MODE: 'terminal' }, terminal: { cols: 100, rows: 24, data: (_, data) => void (screen += decoder.decode(data, { stream: true })) } })

    try {
      await until(() => screen.includes('Username for'))
      // Two frames of the spinner, which would erase the prompt were the line not paused.
      await Bun.sleep(450)
      expect(screen.slice(screen.lastIndexOf('Username for'))).not.toContain('fetching')
      proc.terminal?.write('alice\r')
      await until(() => screen.includes('Password for'))
      proc.terminal?.write('s3cret\r')
      await until(() => screen.includes('git done'))
    }
    finally {
      proc.kill()
      proc.terminal?.close()
    }

    expect(sent).toEqual([`Basic ${btoa('alice:s3cret')}`])
    expect(screen).toContain('alice')
    expect(screen).not.toContain('s3cret')
  })
})
