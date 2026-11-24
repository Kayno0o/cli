import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { format } from 'node:util'
import { afterAll } from 'bun:test'

export interface Captured<T> {
  result: T
  // Everything printed to stdout (console.log, console.info and process.stdout.write).
  out: string
  // Everything printed to stderr (console.error, console.warn and process.stderr.write).
  err: string
}

export interface TerminalRun {
  // Everything the command wrote, escape codes included: for what must never be drawn, even for a moment.
  raw: () => string
  // What the terminal shows once the output so far is drawn, scrollback included, a wrapped line joined back and trailing blanks left out.
  screen: () => Promise<string>
  // Waits until the screen shows one of `texts`, failing with the screen after `ms` so a prompt that never shows is not mistaken for a slow one.
  until: (texts: string | string[], ms?: number) => Promise<void>
  // Sends keys as the user would type them.
  type: (keys: string) => void
  exited: Promise<number>
}

export interface TerminalOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  cols?: number
  rows?: number
}

// Runs `argv` under a pseudo-terminal drawn by a headless xterm, hands it to `use`, then kills the command and closes the terminal whichever way `use` ends.
export async function onTerminal<T>(argv: string[], use: (run: TerminalRun) => Promise<T>, { cols = 80, rows = 24, ...spawn }: TerminalOptions = {}): Promise<T> {
  // Loaded here so the test files using the other helpers do not parse xterm.
  const { Terminal } = await import('@xterm/headless')
  // The headless build counts reading the buffer as a proposed API.
  const drawn = new Terminal({ cols, rows, allowProposedApi: true })
  const decoder = new TextDecoder()
  let raw = ''
  let closed = false
  const proc = Bun.spawn(argv, {
    ...spawn,
    env: spawn.env ?? process.env,
    terminal: {
      cols,
      rows,
      data: (_, data) => {
        if (closed)
          return

        raw += decoder.decode(data, { stream: true })
        drawn.write(data)
      },
    },
  })

  async function screen(): Promise<string> {
    await new Promise<void>(resolve => drawn.write('', resolve))
    const buffer = drawn.buffer.active
    let text = ''

    for (let row = 0; row < buffer.length; row++) {
      const line = buffer.getLine(row)!

      if (row > 0 && !line.isWrapped)
        text += '\n'

      text += line.translateToString(true)
    }

    return text.trimEnd()
  }

  async function until(texts: string | string[], ms = 5000): Promise<void> {
    const wanted = typeof texts === 'string' ? [texts] : texts

    for (const deadline = Date.now() + ms; ;) {
      const shown = await screen()

      if (wanted.some(text => shown.includes(text)))
        return

      if (Date.now() > deadline)
        throw new Error(`the terminal never showed ${wanted.map(text => JSON.stringify(text)).join(' or ')}:\n${shown}`)

      await Bun.sleep(20)
    }
  }

  try {
    return await use({ raw: () => raw, screen, until, type: keys => void proc.terminal?.write(keys), exited: proc.exited })
  }
  finally {
    closed = true
    proc.kill()
    proc.terminal?.close()
    drawn.dispose()
  }
}

// Called at the top of a test file, answers a maker of fresh folders under the system temp folder, each removed with its content once the file's tests are done.
export function tempDirs(): (prefix?: string) => string {
  const made: string[] = []

  afterAll(() => {
    for (const dir of made.splice(0))
      rmSync(dir, { recursive: true, force: true })
  })

  return (prefix = 'test-') => {
    const dir = mkdtempSync(join(tmpdir(), prefix))

    made.push(dir)

    return dir
  }
}

// Runs a command in-process and returns what it printed, so a test needs no spy on console. Output is restored even when the command throws.
export async function capture<T>(run: () => Promise<T> | T): Promise<Captured<T>> {
  const written = { out: '', err: '' }
  const saved = { log: console.log, info: console.info, error: console.error, warn: console.warn, stdout: process.stdout.write.bind(process.stdout), stderr: process.stderr.write.bind(process.stderr) }
  const line = (name: 'out' | 'err') => (...parts: unknown[]) => {
    written[name] += `${format(...parts)}\n`
  }
  const chunk = (name: 'out' | 'err') => (data: string | Uint8Array) => {
    written[name] += typeof data === 'string' ? data : Buffer.from(data).toString()

    return true
  }

  console.log = line('out')
  console.info = line('out')
  console.error = line('err')
  console.warn = line('err')
  process.stdout.write = chunk('out')
  process.stderr.write = chunk('err')

  try {
    const result = await run()

    return { result, ...written }
  }
  finally {
    Object.assign(console, { log: saved.log, info: saved.info, error: saved.error, warn: saved.warn })
    process.stdout.write = saved.stdout
    process.stderr.write = saved.stderr
  }
}
