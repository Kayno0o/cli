import type { Subprocess } from 'bun'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { version } from '../package.json'

const temp = tempDirs()

const CLI = new URL('../src/slot-cli.ts', import.meta.url).pathname

interface Listed { slots: number, busy: number, entries: { state: string, resource: string, pid: number, command: string }[] }

let dir = ''
let started: Subprocess[] = []

function slot(args: string[]): Subprocess<'ignore', 'pipe', 'pipe'> {
  const child = Bun.spawn([process.execPath, CLI, ...args], { cwd: dir, env: { ...process.env, SLOT_DIR: join(dir, 'state') }, stdout: 'pipe', stderr: 'pipe' })

  started.push(child)

  return child
}

async function finished(child: Subprocess<'ignore', 'pipe', 'pipe'>) {
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])

  return { code, out, err }
}

async function listed(): Promise<Listed> {
  return JSON.parse((await finished(slot(['ls', '--json', '-n', '1']))).out) as Listed
}

async function until(done: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await done())
      return

    await Bun.sleep(50)
  }

  throw new Error('condition not met in 5s')
}

// A command that writes its pid to a file, then sleeps, so the test can end it if the slot's own death leaves it behind.
function sleeper(name: string): string[] {
  return ['--', 'sh', '-c', `echo $$ > ${join(dir, name)}; exec sleep 30`]
}

beforeEach(() => {
  dir = temp('slot-test-')
  started = []
})

afterEach(() => {
  for (const child of started)
    child.kill('SIGKILL')

  for (const name of ['a.pid', 'b.pid']) {
    try {
      process.kill(Number(readFileSync(join(dir, name), 'utf8')), 'SIGKILL')
    }
    catch {
      // Never started, or already gone.
    }
  }
})

describe('slot', () => {
  test('prints its version and its help', async () => {
    expect((await finished(slot(['--version']))).out.trim()).toBe(version)
    expect((await finished(slot(['--help']))).out).toContain('slot [options]')
  })

  test('runs the command and exits with its code', async () => {
    expect(await finished(slot(['--', 'sh', '-c', 'echo hi; exit 7']))).toEqual({ code: 7, out: 'hi\n', err: '' })
  })

  test('asks for a command after --', async () => {
    const { code, err } = await finished(slot(['-n', '1']))

    expect(code).toBe(2)
    expect(err).toContain('give the command after --')
  })

  test('two commands on one slot run one after the other', async () => {
    const log = join(dir, 'order.log')
    const job = (tag: string) => slot(['-n', '1', '--', 'sh', '-c', `echo ${tag}-start >> ${log}; sleep 0.6; echo ${tag}-end >> ${log}`])
    const first = job('a')

    await until(async () => (await listed()).busy === 1)

    const second = job('b')

    expect((await finished(first)).code).toBe(0)

    const { code, err } = await finished(second)

    expect(code).toBe(0)
    expect(err).toMatch(/^slot: waiting for a slot \(1 of 1 busy\), the oldest held by \S+(?: \d+)? running sh -c echo a-start/)
    expect(readFileSync(log, 'utf8')).toBe('a-start\na-end\nb-start\nb-end\n')
  })

  test('a holder killed by SIGKILL frees its slot', async () => {
    const holder = slot(['-n', '1', ...sleeper('a.pid')])

    await until(async () => (await listed()).busy === 1)
    holder.kill('SIGKILL')
    await holder.exited

    expect(await finished(slot(['-n', '1', '-t', '5s', '--', 'echo', 'freed']))).toEqual({ code: 0, out: 'freed\n', err: '' })
  })

  test('a slotted command running slot again does not wait for a second slot', async () => {
    const nested = slot(['-n', '1', '-t', '5s', '--', process.execPath, CLI, '-n', '1', '-t', '5s', '--', 'echo', 'inner'])

    expect(await finished(nested)).toEqual({ code: 0, out: 'inner\n', err: '' })
  })

  test('gives up with 2 on --timeout, naming what it waited on', async () => {
    slot(['-n', '1', ...sleeper('a.pid')])
    await until(async () => (await listed()).busy === 1)

    const { code, err } = await finished(slot(['-n', '1', '-t', '1s', '--', 'echo', 'never']))

    expect(code).toBe(2)
    expect(err).toContain('slot: waiting for a slot')
    expect(err).toContain('gave up after 1.0s waiting for a slot')
  })

  test('a named lock holds across slots, and a nested slot with the same lock does not wait for it', async () => {
    const log = join(dir, 'lock.log')
    const job = (tag: string) => slot(['-n', '4', '--lock', 'test-db', '--', 'sh', '-c', `echo ${tag}-start >> ${log}; sleep 0.6; echo ${tag}-end >> ${log}`])
    const first = job('a')

    await until(() => existsSync(log))

    const second = job('b')

    await Promise.all([finished(first), finished(second)])
    expect(readFileSync(log, 'utf8')).toBe('a-start\na-end\nb-start\nb-end\n')

    const nested = slot(['--lock', 'test-db', '-t', '5s', '--', process.execPath, CLI, '--lock', 'test-db', '-t', '5s', '--', 'echo', 'inner'])

    expect(await finished(nested)).toEqual({ code: 0, out: 'inner\n', err: '' })
  })

  test('a lock wanted inside a slotted script does not deadlock against a session that holds it and waits for a slot', async () => {
    const go = join(dir, 'go')
    const script = `while [ ! -e ${go} ]; do sleep 0.05; done; ${process.execPath} ${CLI} --lock db -t 4s -- echo inner`
    const outer = slot(['-n', '1', '-t', '4s', '--', 'sh', '-c', script])

    await until(async () => (await listed()).busy === 1)

    const other = slot(['-n', '1', '--lock', 'db', '-t', '4s', '--', 'echo', 'other'])

    await until(async () => (await listed()).entries.some(entry => entry.state === 'waiting'))
    await Bun.write(go, '')

    expect(await finished(outer)).toMatchObject({ code: 0, out: 'inner\n' })
    expect(await finished(other)).toMatchObject({ code: 0, out: 'other\n' })
  }, 10_000)

  test('--no-slot takes the lock alone, and the lock name is checked', async () => {
    slot(['-n', '1', ...sleeper('a.pid')])
    await until(async () => (await listed()).busy === 1)

    expect((await finished(slot(['-n', '1', '--no-slot', '--lock', 'db', '--', 'echo', 'ok']))).out).toBe('ok\n')
    expect((await finished(slot(['--lock', '../x', '--', 'true']))).err).toContain('is no lock name')
    expect((await finished(slot(['--no-slot', '--', 'true']))).err).toContain('--no-slot takes the --lock alone')
  })

  test('slot ls lists the holder and the waiter, a waiter killed with SIGKILL disappearing', async () => {
    slot(['-n', '1', '--lock', 'db', ...sleeper('a.pid')])
    await until(async () => (await listed()).busy === 1)

    const waiter = slot(['-n', '1', '--', 'echo', 'later'])

    await until(async () => (await listed()).entries.some(entry => entry.state === 'waiting'))

    const { entries } = await listed()

    expect(entries.map(entry => [entry.state, entry.resource])).toEqual([['holding', 'slot 1'], ['holding', 'lock db'], ['waiting', 'slot']])
    expect(entries[0]?.command).toContain('exec sleep 30')
    expect((await finished(slot(['ls', '-n', '1']))).out).toContain('slots: 1 of 1 busy')

    waiter.kill('SIGKILL')
    await waiter.exited
    expect((await listed()).entries.map(entry => entry.state)).toEqual(['holding', 'holding'])
  })

  test('a waiter whose queue file was removed meanwhile still runs its command', async () => {
    const holder = slot(['-n', '1', ...sleeper('a.pid')])

    await until(async () => (await listed()).busy === 1)

    const waiter = slot(['-n', '1', '--', 'echo', 'later'])

    await until(async () => (await listed()).entries.some(entry => entry.state === 'waiting'))
    rmSync(join(dir, 'state', 'waiters'), { recursive: true, force: true })
    holder.kill('SIGKILL')

    const done = await finished(waiter)

    expect(done.out).toBe('later\n')
    expect(done.code).toBe(0)
  })

  test('slot ls says nothing is busy on an empty queue', async () => {
    expect((await finished(slot(['ls', '-n', '3']))).out).toBe('slots: 0 of 3 busy\n')
  })
})
