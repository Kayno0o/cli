import type { ProcInfo } from './read'
import { readText } from './read'

const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ash', 'nu', 'tcsh', 'ksh', 'elvish', 'xonsh'])
const TERMINALS = new Set(['kitty', 'alacritty', 'konsole', 'wezterm-gui', 'foot', 'footclient', 'xterm', 'gnome-terminal-', 'ghostty', 'tmux: server', 'tmux', 'screen', 'terminator', 'tilix', 'urxvt', 'st', 'yakuake', 'ptyxis'])

export interface Guard {
  uid: number
  // The calling process and each of its ancestors.
  mine: ReadonlySet<number>
}

// Why a process must not be signalled, undefined when it may be.
export function protectionOf(proc: ProcInfo, { uid, mine }: Guard): string | undefined {
  if (proc.pid === 1)
    return 'pid 1'

  if (proc.uid !== uid)
    return 'another user\'s process'

  if (mine.has(proc.pid))
    return 'this command or one of its ancestors'

  if (SHELLS.has(proc.comm))
    return 'a shell'

  return TERMINALS.has(proc.comm) ? 'a terminal' : undefined
}

export interface Signaller {
  send: (pid: number, signal: NodeJS.Signals) => boolean
  alive: (pid: number) => Promise<boolean>
  sleep: (ms: number) => Promise<void>
}

export const realSignaller: Signaller = {
  send(pid, signal) {
    try {
      process.kill(pid, signal)

      return true
    }
    catch {
      return false
    }
  },
  // A zombie is dead for our purposes: its parent has yet to reap it.
  async alive(pid) {
    const stat = await readText(`/proc/${pid}/stat`)

    return stat !== undefined && !stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')
  },
  sleep: async ms => Bun.sleep(ms),
}

export interface Outcome {
  // Gone after SIGTERM.
  terminated: number[]
  // Needed SIGKILL.
  killed: number[]
  // Still there at the end, or refused the signal.
  survived: number[]
}

const POLL_MS = 100

async function waitGone(pids: number[], graceMs: number, signaller: Signaller): Promise<number[]> {
  let alive = pids
  let waited = 0

  while (alive.length > 0 && waited < graceMs) {
    await signaller.sleep(POLL_MS)
    waited += POLL_MS
    alive = await filterAlive(alive, signaller)
  }

  return alive
}

async function filterAlive(pids: number[], signaller: Signaller): Promise<number[]> {
  const alive: number[] = []

  for (const pid of pids) {
    if (await signaller.alive(pid))
      alive.push(pid)
  }

  return alive
}

// SIGTERM to each pid, then with `escalate` SIGKILL to those still there after `graceMs`.
export async function terminate(pids: number[], { escalate, graceMs, signaller = realSignaller }: { escalate: boolean, graceMs: number, signaller?: Signaller }): Promise<Outcome> {
  const failed = pids.filter(pid => !signaller.send(pid, 'SIGTERM'))
  // A pid that no longer exists (ESRCH) is gone, not a survivor; only one that exists yet refused the signal is.
  const refused = await filterAlive(failed, signaller)
  const sent = pids.filter(pid => !failed.includes(pid))
  const remaining = await waitGone(sent, graceMs, signaller)
  const terminated = pids.filter(pid => (failed.includes(pid) ? !refused.includes(pid) : !remaining.includes(pid)))

  if (!escalate || remaining.length === 0)
    return { terminated, killed: [], survived: [...refused, ...remaining] }

  for (const pid of remaining)
    signaller.send(pid, 'SIGKILL')

  const stuck = await waitGone(remaining, 2000, signaller)

  return { terminated, killed: remaining.filter(pid => !stuck.includes(pid)), survived: [...refused, ...stuck] }
}
