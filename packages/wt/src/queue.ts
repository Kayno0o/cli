import type { Resolved } from './config'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { alive, bootTime } from './errors'

/** The folder of a queue's tickets, under the config's state folder. */
export const queueDir = (settings: Resolved, name: string) => join(settings.state, 'queues', name)
const POLL_MS = 1000

// The tickets still held, oldest first; one whose process is gone (killed while waiting), or taken before the machine booted, is swept on the way.
export function liveTickets(dir: string): string[] {
  const names = readdirSync(dir).sort()

  return names.filter((name) => {
    const dash = name.indexOf('-')

    if (Number(name.slice(0, dash)) >= bootTime() && alive(Number(name.slice(dash + 1))))
      return true

    rmSync(join(dir, name), { force: true })

    return false
  })
}

// Empty for a ticket released since it was listed.
function labelOf(ticket: string): string {
  try {
    return readFileSync(ticket, 'utf8')
  }
  catch {
    return ''
  }
}

// Runs `work` once every ticket taken before this one in `dir`, by any process on the machine, is released; `waiting` hears how many are ahead each time that changes, and what the first of them runs.
export async function inLine<T>(dir: string, label: string, waiting: (ahead: number, running: string) => void, work: () => Promise<T>): Promise<T> {
  mkdirSync(dir, { recursive: true })

  const name = `${String(Date.now()).padStart(15, '0')}-${process.pid}`
  const ticket = join(dir, name)
  const release = () => rmSync(ticket, { force: true })

  writeFileSync(ticket, label)
  process.once('exit', release)

  try {
    let shown = -1

    for (;;) {
      const ahead = liveTickets(dir).filter(other => other < name)

      if (ahead.length === 0)
        break

      if (ahead.length !== shown) {
        shown = ahead.length
        waiting(ahead.length, labelOf(join(dir, ahead[0]!)))
      }

      await Bun.sleep(POLL_MS)
    }

    return await work()
  }
  finally {
    release()
  }
}
