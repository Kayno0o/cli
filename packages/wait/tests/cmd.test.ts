import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { waitforHarness } from './waitfor'

const { dir, waitfor } = waitforHarness()

describe('waitfor --cmd', () => {
  test('re-runs the command until it exits 0', async () => {
    const result = await waitfor(['--cmd', 'test -f ready', '--interval', '100ms', '-t', '5s'], async () => {
      await Bun.sleep(400)
      writeFileSync(join(dir(), 'ready'), '')
    })

    expect(result.code).toBe(0)
    expect(result.out).toMatch(/^`test -f ready` exited 0 after \d+\.\ds\n$/)
  })

  test('times out naming the last exit code and output line', async () => {
    const result = await waitfor(['--cmd', 'echo not yet; exit 3', '--interval', '100ms', '-t', '500ms'])

    expect(result.code).toBe(2)
    expect(result.err).toContain('`echo not yet; exit 3` exited 3 (not yet)')
  })

  test('a command that cannot run is a timeout reason, not a crash', async () => {
    expect((await waitfor(['--cmd', 'no-such-command-here', '--interval', '100ms', '-t', '500ms'])).code).toBe(2)
  })
})

describe('waitfor --any', () => {
  test('one met condition of several ends the wait', async () => {
    const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: socket => void socket.end() } })
    const result = await waitfor(['--any', '--cmd', 'false', '-p', String(server.port), '--url', 'http://127.0.0.1:1/', '--interval', '100ms', '-t', '5s'])

    server.stop(true)
    expect(result.code).toBe(0)
    expect(result.out).toContain(`127.0.0.1:${server.port} listening after`)
  })

  test('times out listing every condition when none is met', async () => {
    const result = await waitfor(['--any', '--cmd', 'false', '--pid', String(process.pid), '-t', '500ms'])

    expect(result.code).toBe(2)
    expect(result.err).toContain('none met')
    expect(result.err).toContain('`false` exited 1')
    expect(result.err).toContain(`pid ${process.pid} is still running`)
  })

  test('needs two conditions', async () => {
    const result = await waitfor(['--any', '--cmd', 'true'])

    expect(result.code).toBe(2)
    expect(result.err).toContain('--any')
  })
})
