import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { Glob } from 'bun'

// A running Claude Code session, as it registers itself in <config dir>/sessions/<pid>.json.
export interface Session { name: string, pid: number, status: string, cwd: string }

interface Entry { name?: string, pid?: number, procStart?: string, status?: string, cwd?: string }

const SESSION_FILES = new Glob('*.json')
const ACCOUNT_DIRS = new Glob('*/sessions')

async function sessionDirs(): Promise<string[]> {
  const home = homedir()
  const dirs = new Set([join(home, '.claude', 'sessions')])

  if (process.env.CLAUDE_CONFIG_DIR !== undefined)
    dirs.add(join(process.env.CLAUDE_CONFIG_DIR, 'sessions'))

  try {
    for await (const dir of ACCOUNT_DIRS.scan({ cwd: join(home, '.claude-accounts'), onlyFiles: false, absolute: true }))
      dirs.add(dir)
  }
  catch {
    // No ~/.claude-accounts: the default config dir is the only one.
  }

  return [...dirs]
}

// The fields of /proc/<pid>/stat after the command name, which may itself hold spaces and parentheses.
async function procStat(pid: number): Promise<string[] | undefined> {
  try {
    const stat = await Bun.file(`/proc/${pid}/stat`).text()

    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  }
  catch {
    return undefined
  }
}

// Alive and the same process the session registered, not a later one given its pid; starttime is field 22, the 20th after the name.
async function isAlive(pid: number, procStart: string | undefined): Promise<boolean> {
  const stat = await procStat(pid)

  if (stat === undefined)
    return false

  return procStart === undefined || stat[19] === procStart
}

export async function liveSessions(): Promise<Session[]> {
  const sessions = new Map<number, Session>()

  for (const dir of await sessionDirs()) {
    let files: string[]

    try {
      files = await Array.fromAsync(SESSION_FILES.scan({ cwd: dir, absolute: true }))
    }
    catch {
      continue
    }

    for (const file of files) {
      let entry: Entry

      try {
        entry = await Bun.file(file).json() as Entry
      }
      catch {
        continue
      }

      if (entry.name === undefined || entry.pid === undefined || sessions.has(entry.pid) || !await isAlive(entry.pid, entry.procStart))
        continue

      sessions.set(entry.pid, { name: entry.name, pid: entry.pid, status: entry.status ?? 'unknown', cwd: entry.cwd ?? '' })
    }
  }

  return [...sessions.values()]
}

// The session this process runs under, found by walking up its parent pids.
export async function currentSession(sessions: Session[]): Promise<Session | undefined> {
  const byPid = new Map(sessions.map(session => [session.pid, session]))
  let pid = process.ppid

  for (let depth = 0; depth < 32 && pid > 1; depth++) {
    const session = byPid.get(pid)

    if (session !== undefined)
      return session

    const parent = Number((await procStat(pid))?.[1])

    if (!Number.isInteger(parent))
      return undefined

    pid = parent
  }

  return undefined
}
