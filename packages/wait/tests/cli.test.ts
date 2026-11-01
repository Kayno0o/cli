import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'bun:test'
import { version } from '../package.json'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname

let dir = ''

async function waitfor(args: string[], meanwhile?: () => Promise<void>) {
  const child = Bun.spawn([process.execPath, CLI, ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })

  await meanwhile?.()

  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])

  return { code, out, err }
}

function log(text: string): string {
  const path = join(dir, 'app.log')

  writeFileSync(path, text)

  return path
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'waitfor-test-'))
})

describe('waitfor --file', () => {
  test('prints its version and its help', async () => {
    expect((await waitfor(['--version'])).out.trim()).toBe(version)
    expect((await waitfor(['--help'])).out).toContain('waitfor [options]')
  })

  test('waits for the file to exist and for a line written later, colours stripped', async () => {
    const path = join(dir, 'app.log')
    const result = await waitfor(['-f', path, '-u', '^ready on \\d+', '-t', '5s'], async () => {
      await Bun.sleep(400)
      writeFileSync(path, 'booting\n')
      await Bun.sleep(300)
      appendFileSync(path, '\u001B[32mready\u001B[0m on 8000\nafter\n')
    })

    expect(result).toEqual({ code: 0, out: 'app.log:2: ready on 8000\n'.replace('app.log', path), err: '' })
  })

  test('matches a line already in the file at once', async () => {
    const path = log('a\nServer listening\n')

    expect((await waitfor(['--file', path, '--until', 'listening'])).out).toBe(`${path}:2: Server listening\n`)
  })

  test('ends with 1 on a --fail line, printing the lines around it', async () => {
    const path = log(`${Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n')}\nFATAL: no database\n  at connect\n  at boot\n`)
    const result = await waitfor(['-f', path, '-u', 'ready', '-e', 'FATAL', '-t', '5s'])

    expect(result.code).toBe(1)
    expect(result.out).toBe('')
    expect(result.err).toContain(`waitfor: ${path}:9 matched --fail after`)
    expect(result.err).toContain('   4  line 4\n')
    expect(result.err).toContain('   8  line 8\n>  9  FATAL: no database\n  10    at connect\n  11    at boot\n')
    expect(result.err).not.toContain('line 3')
  })

  test('a --until line before the --fail one wins', async () => {
    expect((await waitfor(['-f', log('ready\nFATAL\n'), '-u', 'ready', '-e', 'FATAL'])).code).toBe(0)
  })

  test('ends with 2 on a timeout, printing the last lines', async () => {
    const path = log('one\ntwo\n')
    const result = await waitfor(['-f', path, '-u', 'ready', '-t', '600ms'])

    expect(result.code).toBe(2)
    expect(result.err).toBe(`error: waitfor: gave up after 0.6s: no line of ${path} matched --until\nlast lines of ${path}:\n  1  one\n  2  two\n`)
  })

  test('says when the file never appeared', async () => {
    expect((await waitfor(['-f', join(dir, 'none.log'), '-u', 'x', '-t', '300ms'])).err).toContain('none.log does not exist')
  })
})

describe('waitfor --port and --url', () => {
  test('waits for a port to listen', async () => {
    const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: socket => void socket.end() } })
    const port = server.port
    const result = await waitfor(['-p', String(port), '-t', '5s'])

    server.stop(true)
    expect(result.code).toBe(0)
    expect(result.out).toMatch(new RegExp(`^127\\.0\\.0\\.1:${port} listening after \\d+\\.\\ds\\n$`))
  })

  test('times out on a closed port, naming the error', async () => {
    const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: socket => void socket.end() } })
    const port = server.port

    server.stop(true)

    const result = await waitfor(['-p', String(port), '-t', '500ms'])

    expect(result.code).toBe(2)
    expect(result.err).toContain(`127.0.0.1:${port} is not listening (ECONNREFUSED)`)
  })

  test('waits for a URL to answer 2xx, every condition together', async () => {
    let calls = 0
    const server = Bun.serve({ port: 0, fetch: () => new Response('', { status: ++calls < 3 ? 503 : 204 }) })
    const url = `http://127.0.0.1:${server.port}/health`
    const result = await waitfor(['--url', url, '-f', log('ready\n'), '-u', 'ready', '-p', String(server.port), '-t', '5s'])

    await server.stop(true)
    expect(result.code).toBe(0)
    expect(result.out).toContain(`${url} answered 204 after`)
    expect(result.out.split('\n')).toHaveLength(4)
  })

  test('times out on a URL answering an error, naming the status', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('', { status: 500 }) })
    // Long enough for a first answer on a loaded CI runner, where 500ms has run out before it.
    const result = await waitfor(['--url', `http://127.0.0.1:${server.port}/`, '-t', '2s'])

    await server.stop(true)
    expect(result.code).toBe(2)
    expect(result.err).toContain('answered 500')
  })
})

describe('waitfor usage', () => {
  test('refuses what cannot be waited for', async () => {
    expect((await waitfor([])).err).toContain('give --until with --file, --port or --url')
    expect((await waitfor(['-u', 'x'])).err).toContain('--file needs one of them')
    expect((await waitfor(['-f', 'a.log', '-p', '80'])).err).toContain('--file needs one of them')
    expect((await waitfor(['-f', 'a.log', '-u', '('])).err).toContain('--until is no valid regular expression')
    expect((await waitfor(['-p', '70000'])).err).toContain('up to 65535')
    expect((await waitfor(['-p', '80', '-t', 'soon'])).err).toContain('--timeout takes a duration')
    expect((await waitfor(['--url', 'nope'])).code).toBe(2)
  })
})
