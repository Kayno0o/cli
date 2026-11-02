import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { waitforHarness } from './waitfor'

const { dir, log, waitfor } = waitforHarness()

describe('waitfor task', () => {
  // A background Bash task's output where Claude Code keeps it, under CLAUDE_CODE_TMPDIR.
  function taskOutput(id: string, text: string): Record<string, string | undefined> {
    const tasks = join(dir(), `claude-${process.getuid?.() ?? 0}`, '-home-me-repo', 'session', 'tasks')

    mkdirSync(tasks, { recursive: true })
    writeFileSync(join(tasks, `${id}.output`), text)

    return { ...process.env, CLAUDE_CODE_TMPDIR: dir() }
  }

  test('waits for the exit line, then prints the code and the last lines', async () => {
    const path = log('building\n')
    const result = await waitfor(['task', path, '-n', '2', '-t', '5s'], async () => {
      await Bun.sleep(400)
      appendFileSync(path, 'step 2\n\u001B[32mdone\u001B[0m\n\n[exited with code 0]\n')
    })

    expect(result.code).toBe(0)
    expect(result.out).toMatch(/^task .+app\.log exited with code 0, waited \d+\.\ds\nlast lines of .+app\.log:\n {2}2 {2}step 2\n {2}3 {2}done\n$/)
  })

  test('finds a task by its id, exits 1 on another code and lists the failure lines above the tail', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)

    lines[4] = '(fail) cli > parses [2ms]'
    lines[9] = 'error: expect(received).toBe(expected)'

    const env = taskOutput('b1x2', `${lines.join('\n')}\n\n[exited with code 1]\n`)
    const result = await waitfor(['task', 'b1x2', '-n', '3'], undefined, env)

    expect(result.code).toBe(1)
    expect(result.out).toContain('task b1x2 exited with code 1')
    expect(result.out).toContain('(fail) and error: lines above them:\n   5  (fail) cli > parses [2ms]\n  10  error: expect(received).toBe(expected)\n')
    expect(result.out).toEndWith('  28  line 28\n  29  line 29\n  30  line 30\n')

    const json = JSON.parse((await waitfor(['task', 'b1x2', '-n', '1', '--json'], undefined, env)).out) as { code: number, failures: unknown[], tail: unknown[] }

    expect([json.code, json.failures.length, json.tail]).toEqual([1, 2, [{ number: 30, text: 'line 30' }]])
  })

  test('times out with 2 and the last lines', async () => {
    const result = await waitfor(['task', log('still going\n'), '-t', '500ms'])

    expect(result.code).toBe(2)
    expect(result.err).toContain('is still running')
    expect(result.err).toContain('1  still going')
  })

  test('fails at once with 2 on an output file that does not exist', async () => {
    const started = Date.now()
    const result = await waitfor(['task', join(dir(), 'typo.output'), '-t', '1m'])

    expect(result.code).toBe(2)
    expect(result.err).toContain('no output file')
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  test('refuses an unknown id and a subagent', async () => {
    const env = taskOutput('b1x2', '')

    expect((await waitfor(['task', 'nope'], undefined, env)).err).toContain('no background task nope')

    const tasks = join(dir(), `claude-${process.getuid?.() ?? 0}`, '-home-me-repo', 'session', 'tasks')

    writeFileSync(join(dir(), 'agent.jsonl'), '{}\n')
    symlinkSync(join(dir(), 'agent.jsonl'), join(tasks, 'a9f.output'))
    expect((await waitfor(['task', 'a9f'], undefined, env)).err).toContain('a9f is a subagent')
  })
})
