import { describe, expect, test } from 'bun:test'
import { waitforHarness } from './waitfor'

const { waitfor } = waitforHarness()

describe('waitfor --pid', () => {
  test('does not wait for a zombie to be reaped', async () => {
    const parent = Bun.spawn(['sh', '-c', 'sleep 0.2 & echo $!; sleep 30'], { stdout: 'pipe' })
    const reader = parent.stdout.getReader()
    const pid = Number(new TextDecoder().decode((await reader.read()).value).trim())
    const result = await waitfor(['--pid', String(pid), '-t', '5s'])

    parent.kill()
    expect(result.code).toBe(0)
  })

  test('waits for the process to exit', async () => {
    const child = Bun.spawn(['sleep', '0.5'])
    const result = await waitfor(['--pid', String(child.pid), '-t', '5s'])

    expect(result.code).toBe(0)
    expect(result.out).toMatch(new RegExp(`^pid ${child.pid} exited after \\d+\\.\\ds\\n$`))
  })

  test('times out on a process still running', async () => {
    const child = Bun.spawn(['sleep', '5'])
    const result = await waitfor(['--pid', String(child.pid), '-t', '300ms'])

    child.kill()
    expect(result.code).toBe(2)
    expect(result.err).toContain(`pid ${child.pid} is still running`)
  })
})
