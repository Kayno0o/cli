import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

// Set only by the wrapper script, for the one process it starts: a kit bin started with it answers git or ssh instead of running.
const SOCKET_VARIABLE = 'KAYNOOO_ASKPASS_SOCKET'
// What git and ssh show in clear: a user name and a yes/no question; everything else is a secret.
const ECHOED = /username|yes\/no/i

interface Request { prompt: string, notice?: boolean }
interface Reply { answer?: string | undefined }

export interface Askpass {
  // To add to the environment of a git or ssh run, so its prompts come here.
  env: Record<string, string>
  close: () => void
}

const quoted = (text: string) => `'${text.replaceAll('\'', `'\\''`)}'`

/** While a live region is drawn, git and ssh cannot ask on the terminal: the region erases their prompt at its next frame and races them for the keys; run in their own session, as a timeout does, they have no terminal to ask on at all. Run them with `env` and each prompt is asked here instead, the region paused by `pause` until it is answered. Off a terminal it returns undefined and they ask as they always do. */
export function askpass(pause: () => () => void = () => () => undefined): Askpass | undefined {
  if (process.stdin.isTTY !== true || process.stderr.isTTY !== true || process.argv[1] === undefined)
    return undefined

  const dir = mkdtempSync(join(tmpdir(), 'kaynooo-askpass-'))
  const socketPath = join(dir, 'socket')
  const script = join(dir, 'askpass')
  // One question at a time, in the order they came.
  let turn = Promise.resolve()

  const answer = async ({ prompt, notice }: Request): Promise<Reply> => {
    const resume = pause()

    try {
      if (notice === true) {
        process.stderr.write(`${prompt.trim()}\n`)

        return {}
      }

      const { input } = await import('./prompt')

      return { answer: await input(prompt.trim(), { mask: !ECHOED.test(prompt) }) }
    }
    finally {
      resume()
    }
  }

  const respond = async (socket: { end: (text: string) => unknown }, request: Request) => {
    const { promise, resolve } = Promise.withResolvers<void>()
    const previous = turn
    let reply: Reply = {}

    turn = promise
    await previous

    try {
      reply = await answer(request)
    }
    catch {
      // Unanswered, git or ssh fails as it would with no terminal.
    }
    finally {
      socket.end(`${JSON.stringify(reply)}\n`)
      resolve()
    }
  }

  const server = Bun.listen<{ buffered: string }>({
    unix: socketPath,
    socket: {
      open: (socket) => {
        socket.data = { buffered: '' }
      },
      data: (socket, chunk) => {
        const before = socket.data.buffered

        socket.data.buffered += chunk.toString()

        if (before.includes('\n') || !socket.data.buffered.includes('\n'))
          return

        void respond(socket, JSON.parse(socket.data.buffered) as Request)
      },
    },
  })

  writeFileSync(script, `#!/bin/sh\n${SOCKET_VARIABLE}=${quoted(socketPath)} exec ${quoted(process.execPath)} --no-env-file --config=/dev/null ${quoted(process.argv[1])} "$@"\n`)
  chmodSync(script, 0o700)

  return {
    env: { GIT_ASKPASS: script, SSH_ASKPASS: script, SSH_ASKPASS_REQUIRE: 'force' },
    close: () => {
      server.stop(true)
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** In a process the askpass script started, asks the bin that set it up and prints the answer for git or ssh, then answers the exit code; elsewhere undefined, and the bin runs as usual. */
export async function askpassClient(argv: string[]): Promise<number | undefined> {
  const socketPath = process.env[SOCKET_VARIABLE]

  if (socketPath === undefined)
    return undefined

  // ssh sets `none` for a notice it takes back itself, a security key's touch request.
  const request: Request = { prompt: argv[0] ?? '', ...process.env.SSH_ASKPASS_PROMPT === 'none' ? { notice: true } : {} }
  const { promise, resolve } = Promise.withResolvers<string>()
  let received = ''

  try {
    await Bun.connect({
      unix: socketPath,
      socket: {
        open: socket => void socket.write(`${JSON.stringify(request)}\n`),
        data: (_, chunk) => {
          received += chunk.toString()
        },
        close: () => resolve(received),
        error: () => resolve(''),
      },
    })
  }
  catch {
    return 1
  }

  const reply = await promise

  if (reply === '')
    return 1

  const { answer } = JSON.parse(reply) as Reply

  if (request.notice === true)
    return 0

  if (answer === undefined)
    return 1

  process.stdout.write(`${answer}\n`)

  return 0
}
