import type { TerminalRun } from '../src/test'
import process from 'node:process'
import { afterEach, describe, expect, test } from 'bun:test'
import { askpass } from '../src/askpass'
import { onTerminal } from '../src/test'

const FIXTURE = `${import.meta.dir}/fixtures/askpass-git.ts`

let server: ReturnType<typeof Bun.serve> | undefined

afterEach(() => {
  void server?.stop(true)
})

// Runs the askpass fixture against the test server under a pseudo-terminal, colours and the terminal mode on as a person's run would have them.
async function onFixtureTerminal<T>(use: (run: TerminalRun) => Promise<T>): Promise<T> {
  return onTerminal([process.execPath, FIXTURE, `http://127.0.0.1:${server!.port}/repo.git`], use, { env: { ...process.env, NO_COLOR: undefined, KIT_MODE: 'terminal' }, cols: 100 })
}

describe('askpass', () => {
  test('off a terminal git and ssh are kept from asking, through a terminal or a desktop askpass', () => {
    expect(askpass(() => () => undefined).env).toEqual({ GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never' })
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

    const { screen, raw } = await onFixtureTerminal(async ({ until, type, screen, raw }) => {
      await until('Username for')
      // Two frames of the spinner, which would erase the prompt were the line not paused.
      await Bun.sleep(450)
      expect(raw().slice(raw().lastIndexOf('Username for'))).not.toContain('fetching')
      type('alice\r')
      await until('Password for')
      type('s3cret\r')
      await until('git done')

      return { screen: await screen(), raw: raw() }
    })

    expect(sent).toEqual([`Basic ${btoa('alice:s3cret')}`])
    expect(screen).toContain('alice')
    expect(raw).not.toContain('s3cret')
  })

  test('a cancelled prompt ends git, which does not ask again on the bare terminal', async () => {
    server = Bun.serve({ port: 0, fetch: () => new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="test"' } }) })

    const raw = await onFixtureTerminal(async ({ until, type, raw }) => {
      await until('Username for')
      type('\u0003')
      await until('git done')

      return raw()
    })

    expect(raw.slice(raw.indexOf('cancelled'))).not.toContain('Username for')
  })
})
