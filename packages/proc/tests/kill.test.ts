import type { Signaller } from '../src/kill'
import type { ProcInfo } from '../src/read'
import { describe, expect, test } from 'bun:test'
import { protectionOf, terminate } from '../src/kill'

function proc(over: Partial<ProcInfo>): ProcInfo {
  return { pid: 100, ppid: 1, comm: 'bun', args: ['bun'], uid: 1000, state: 'S', session: 1, rss: 0, startMs: 0, ...over }
}

const guard = { uid: 1000, mine: new Set([50, 51]) }

describe('protectionOf', () => {
  test('lets an ordinary process of the user through', () => {
    expect(protectionOf(proc({}), guard)).toBeUndefined()
  })

  test('refuses what must never be signalled', () => {
    expect(protectionOf(proc({ pid: 1 }), guard)).toBe('pid 1')
    expect(protectionOf(proc({ uid: 0 }), guard)).toContain('another user')
    expect(protectionOf(proc({ pid: 51 }), guard)).toContain('ancestors')
    expect(protectionOf(proc({ comm: 'fish' }), guard)).toBe('a shell')
    expect(protectionOf(proc({ comm: 'kitty' }), guard)).toBe('a terminal')
  })
})

// A signaller over fake processes: the ones in `stubborn` ignore SIGTERM, the ones in `immortal` ignore everything.
function fake(pids: number[], stubborn: number[] = [], immortal: number[] = []) {
  const alive = new Set(pids)
  const sent: [number, string][] = []
  const signaller: Signaller = {
    send(pid, signal) {
      sent.push([pid, signal])

      if (!alive.has(pid))
        return false

      if (immortal.includes(pid) || (signal === 'SIGTERM' && stubborn.includes(pid)))
        return true

      alive.delete(pid)

      return true
    },
    alive: async pid => Promise.resolve(alive.has(pid)),
    sleep: async () => Promise.resolve(),
  }

  return { signaller, sent }
}

describe('terminate', () => {
  test('SIGTERM alone when everything leaves', async () => {
    const { signaller, sent } = fake([1, 2])

    expect(await terminate([1, 2], { escalate: true, graceMs: 300, signaller })).toEqual({ terminated: [1, 2], killed: [], survived: [] })
    expect(sent.every(([, signal]) => signal === 'SIGTERM')).toBe(true)
  })

  test('SIGKILL for what outlives the grace, only when escalating', async () => {
    const polite = fake([1, 2], [2])

    expect(await terminate([1, 2], { escalate: false, graceMs: 300, signaller: polite.signaller })).toEqual({ terminated: [1], killed: [], survived: [2] })
    expect(polite.sent.some(([, signal]) => signal === 'SIGKILL')).toBe(false)

    const forced = fake([1, 2], [2])

    expect(await terminate([1, 2], { escalate: true, graceMs: 300, signaller: forced.signaller })).toEqual({ terminated: [1], killed: [2], survived: [] })
  })

  test('reports a process that survives SIGKILL and one that refuses the signal', async () => {
    const { signaller } = fake([1], [], [1])

    expect(await terminate([1, 9], { escalate: true, graceMs: 200, signaller })).toEqual({ terminated: [], killed: [], survived: [9, 1] })
  })
})
