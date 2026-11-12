import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $ } from 'bun'
import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test'
import { HELD_ENV, Jobs, logTail } from '../src/jobs'

const scratch = mkdtempSync(join(tmpdir(), 'wt-jobs-'))
const stack = { ref: 'booki/planning', slug: 'booki--planning' }
const DEAD_PID = '999999999'

let count = 0
const jobsIn = (words?: ConstructorParameters<typeof Jobs>[0]['words']) => new Jobs({ dir: join(scratch, String(count++)), app: 'test', ...words && { words } })

afterAll(() => rmSync(scratch, { recursive: true, force: true }))
afterEach(() => {
  delete process.env[HELD_ENV]
  delete process.env.TEST_JOB
})

describe('Jobs', () => {
  test('refuses a second action on a stack while one runs, and lets the next one in once it ended', () => {
    const jobs = jobsIn()
    const job = jobs.claim(stack, 'up', false)

    expect(() => jobs.claim(stack, 'down', false)).toThrow('booki/planning is already coming up')
    expect(jobs.states().get(stack.slug)?.running?.verb).toBe('up')

    jobs.finish(stack, job, 1)

    expect(jobs.states().get(stack.slug)?.last).toMatchObject({ verb: 'up', code: 1 })
    expect(() => jobs.claim(stack, 'down', false)).not.toThrow()
  })

  test('sums a stack\'s job up in a few words: what runs, else how the last one ended and when', () => {
    const jobs = jobsIn()
    const now = 10 * 60_000
    const started = { ref: stack.ref, pid: 1, startedAt: 0, log: '' }
    const ended = { ...started, endedAt: now - 5 * 60_000 }

    expect(jobs.summary({})).toBe('')
    expect(jobs.summary({ running: { ...started, verb: 'up' } })).toBe('coming up')
    expect(jobs.summary({ last: { ...ended, verb: 'up', code: 0 } }, now)).toBe('up ok 5m ago')
    expect(jobs.summary({ last: { ...ended, verb: 'restart', service: 'php', code: 1 } }, now)).toBe('restart php failed 5m ago')
    expect(jobs.summary({ last: { ...ended, verb: 'rm', code: null } }, now)).toBe('rm killed 5m ago')
  })

  test('holds the lock of a detached job before its process has started', () => {
    const jobs = jobsIn()

    jobs.claim(stack, 'add', true)

    expect(() => jobs.claim(stack, 'up', false)).toThrow('already being made')
  })

  test('releases the lock at once when a detached job\'s log cannot be opened', () => {
    const jobs = jobsIn()

    mkdirSync(jobs.paths(stack.slug).log, { recursive: true })

    expect(() => jobs.detach(stack, 'up', ['-e', ''])).toThrow('EISDIR')
    expect(jobs.states().get(stack.slug)?.last).toMatchObject({ verb: 'up', code: 1 })
    expect(() => jobs.claim(stack, 'down', false)).not.toThrow()
  })

  test('takes over a lock its process left behind, and reads its job as killed', () => {
    const jobs = jobsIn()
    const { job, lock } = jobs.paths(stack.slug)

    jobs.claim(stack, 'up', false)
    writeFileSync(lock, DEAD_PID)
    writeFileSync(job, JSON.stringify({ ref: stack.ref, verb: 'up', pid: Number(DEAD_PID), startedAt: 1, log: '' }))

    expect(jobs.states().get(stack.slug)?.last).toMatchObject({ verb: 'up', code: null, endedAt: expect.any(Number) })
    expect(() => jobs.claim(stack, 'down', false)).not.toThrow()
  })

  test('takes over a lock written before the last boot, whose pid may name another process since', () => {
    const jobs = jobsIn()
    const { lock } = jobs.paths(stack.slug)

    jobs.claim(stack, 'up', false)
    utimesSync(lock, 1, 1)

    expect(() => jobs.claim(stack, 'up', false)).not.toThrow()
  })

  test('refuses while another claimer is taking an abandoned lock over', () => {
    const jobs = jobsIn()
    const { lock } = jobs.paths(stack.slug)

    jobs.claim(stack, 'up', false)
    writeFileSync(lock, DEAD_PID)
    writeFileSync(`${lock}.takeover`, '')

    expect(() => jobs.claim(stack, 'up', false)).toThrow('booki/planning is already coming up')
  })

  test('prints a failed command as what it said, with no stack trace', async () => {
    const printed: unknown[] = []
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      printed.push(...args)
    })

    try {
      expect(await jobsIn().run(stack, 'down', async () => {
        await $`sh -c ${'echo cannot reach docker >&2; exit 3'}`.quiet()
      })).toBe(1)
    }
    finally {
      spy.mockRestore()
    }

    expect(printed).toEqual(['error: test down: cannot reach docker'])
  })

  test('records how an action ended, its lock let go either way', async () => {
    const jobs = jobsIn()

    expect(await jobs.run(stack, 'down', async () => {
      await Bun.sleep(0)

      throw new Error('boom')
    })).toBe(1)
    expect(jobs.states().get(stack.slug)?.last).toMatchObject({ verb: 'down', code: 1 })
    expect(await jobs.run(stack, 'down', async () => Bun.sleep(0))).toBe(0)
  })

  test('hands a detached job to the process it starts, which runs it as its own', async () => {
    const jobs = jobsIn()
    const job = jobs.claim(stack, 'down', true)
    let seen: boolean | undefined

    process.env.TEST_JOB = stack.slug

    expect(await jobs.run(stack, 'down', async (detached) => {
      seen = detached
      await Bun.sleep(0)
    })).toBe(0)
    expect(seen).toBe(true)
    expect(jobs.states().get(stack.slug)?.last).toMatchObject({ verb: 'down', code: 0, startedAt: job.startedAt })
  })

  test('runs a job its own job starts inside the lock it holds, and lets the env go after', async () => {
    const jobs = jobsIn()
    let inner: number | undefined

    expect(await jobs.run(stack, 'rm', async () => {
      inner = await jobs.run(stack, 'down', async () => Bun.sleep(0))
    })).toBe(0)
    expect(inner).toBe(0)
    expect(jobs.states().get(stack.slug)?.last).toMatchObject({ verb: 'rm', code: 0 })
    expect(process.env[HELD_ENV]).toBeUndefined()
  })

  test('does not count a lock as held here once another process holds it, its env entry left over', () => {
    const jobs = jobsIn()
    const { lock } = jobs.paths(stack.slug)

    jobs.claim(stack, 'up', false)
    process.env[HELD_ENV] = `${process.pid} ${lock}`

    expect(jobs.holds(stack)).toBe(true)

    // Another live process took the lock over since: the parent of the test runner stands in for it
    writeFileSync(lock, String(process.ppid))

    expect(jobs.holds(stack)).toBe(false)

    writeFileSync(lock, DEAD_PID)
    process.env[HELD_ENV] = `${DEAD_PID} ${lock}`

    expect(jobs.holds(stack)).toBe(false)
  })

  test('forgets every file of a stack\'s jobs', () => {
    const jobs = jobsIn()

    jobs.finish(stack, jobs.claim(stack, 'rm', false), 0)
    jobs.forget(stack)

    expect(jobs.states().size).toBe(0)
  })

  test('names the service a job acts on, and a verb it has no words for, in its refusal and in what ls reads', () => {
    const jobs = jobsIn()

    jobs.claim(stack, 'panes', false, 'php')

    expect(() => jobs.claim(stack, 'up', false)).toThrow('booki/planning is already busy with panes php')
    expect(jobs.states().get(stack.slug)?.running).toMatchObject({ verb: 'panes', service: 'php' })
    expect(jobs.what({ verb: 'restart', ref: 'booki', service: 'php' })).toBe('test restart booki php')
  })

  test('takes the words of another tool\'s verbs from its caller', () => {
    const jobs = jobsIn({ doing: { restart: 'restarting' } })

    jobs.claim(stack, 'restart', false)

    expect(() => jobs.claim(stack, 'up', false)).toThrow('booki/planning is already restarting')
  })
})

describe('logTail', () => {
  test('reads the last lines of a log from its end, and nothing for a log gone', () => {
    const log = join(scratch, 'up.log')

    writeFileSync(log, `${'x'.repeat(10_000)}\n${['a', 'b', 'c', 'd', 'e', 'f'].join('\n')}\n`)

    expect(logTail(log)).toBe('b\nc\nd\ne\nf')
    expect(logTail(`${log}.gone`)).toBe('')
  })
})
