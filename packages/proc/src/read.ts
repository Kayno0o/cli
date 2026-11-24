import type { Socket } from './parse'
import { readdir, readFile, readlink } from 'node:fs/promises'
import { cgroupContainer, cgroupUnit, parseCgroup, parseCmdline, parseNetTable, parseStat, parseStatus, socketInode, statusBytes, statusUid, userNameOf } from './parse'

// Linux counts process start times in ticks of 1/100 s; reading the real value would take a libc call.
const CLOCK_TICKS = 100

export interface ProcInfo {
  pid: number
  ppid: number
  comm: string
  args: string[]
  uid: number
  state: string
  session: number
  // Resident memory in bytes.
  rss: number
  // Epoch milliseconds.
  startMs: number
  cwd?: string | undefined
  exe?: string | undefined
  unit?: string | undefined
  container?: string | undefined
}

async function text(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  }
  catch {
    return undefined
  }
}

async function link(path: string): Promise<string | undefined> {
  try {
    return await readlink(path)
  }
  catch {
    return undefined
  }
}

const DIGITS = /^\d+$/
const BOOT_TIME = /^btime\s+(\d+)/m

export async function listPids(root = '/proc'): Promise<number[]> {
  return (await readdir(root)).filter(name => DIGITS.test(name)).map(Number)
}

// The epoch milliseconds the machine booted at, from `btime` in /proc/stat.
export async function bootMs(root = '/proc'): Promise<number> {
  const match = BOOT_TIME.exec(await text(`${root}/stat`) ?? '')

  return match === null ? Date.now() : Number(match[1]) * 1000
}

// Runs an async mapper with bounded concurrency so /proc walks stay fast without exhausting file descriptors.
async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = Array.from<R>({ length: items.length })
  let cursor = 0

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor++

      results[idx] = await fn(items[idx]!)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))

  return results
}

const PROC_CONCURRENCY = 32

async function readDetail(pid: number, root: string): Promise<Pick<ProcInfo, 'cwd' | 'exe' | 'unit' | 'container'>> {
  const dir = `${root}/${pid}`
  const [cwd, exe, cgroup] = await Promise.all([link(`${dir}/cwd`), link(`${dir}/exe`), text(`${dir}/cgroup`)])
  const groups = parseCgroup(cgroup ?? '')

  return { cwd, exe, unit: cgroupUnit(groups), container: cgroupContainer(groups) }
}

// One process, undefined once it is gone or its stat cannot be read. `detail` adds what only the owner can read: the working directory, the executable and the cgroup.
export async function readProc(pid: number, boot: number, { root = '/proc', detail = true } = {}): Promise<ProcInfo | undefined> {
  const dir = `${root}/${pid}`
  const [statText, statusText, cmdline] = await Promise.all([text(`${dir}/stat`), text(`${dir}/status`), text(`${dir}/cmdline`)])
  const stat = statText === undefined ? undefined : parseStat(statText)

  if (stat === undefined || statusText === undefined)
    return undefined

  const status = parseStatus(statusText)
  const info: ProcInfo = {
    pid,
    ppid: stat.ppid,
    comm: stat.comm,
    args: parseCmdline(cmdline ?? ''),
    uid: statusUid(status) ?? -1,
    state: stat.state,
    session: stat.session,
    rss: statusBytes(status, 'VmRSS') ?? 0,
    startMs: boot + (stat.startTicks / CLOCK_TICKS) * 1000,
  }

  return detail ? { ...info, ...await readDetail(pid, root) } : info
}

// Every process, read in parallel without re-reading stat/status/cmdline; `detailed` controls which UIDs read cwd/exe/cgroup.
export async function snapshot(root = '/proc', detailed: (uid: number) => boolean = () => true): Promise<ProcInfo[]> {
  const [boot, pids] = await Promise.all([bootMs(root), listPids(root)])
  const entries = await mapBounded(pids, PROC_CONCURRENCY, async (pid) => {
    const light = await readProc(pid, boot, { root, detail: false })

    if (light === undefined)
      return undefined

    return detailed(light.uid) ? { ...light, ...await readDetail(pid, root) } : light
  })

  return entries.filter((entry): entry is ProcInfo => entry !== undefined)
}

// The pids from `pid` up to init, nearest first, `pid` included.
export function ancestry(pid: number, byPid: Map<number, { ppid: number }>): number[] {
  const chain: number[] = []
  let at: number | undefined = pid

  while (at !== undefined && at > 0 && !chain.includes(at)) {
    chain.push(at)
    at = byPid.get(at)?.ppid
  }

  return chain
}

export async function readSockets(root = '/proc'): Promise<Socket[]> {
  const tables = [['tcp', 'tcp', 4], ['tcp6', 'tcp', 6], ['udp', 'udp', 4], ['udp6', 'udp', 6]] as const
  const sockets: Socket[] = []

  for (const [file, protocol, family] of tables)
    sockets.push(...parseNetTable(await text(`${root}/net/${file}`) ?? '', protocol, family))

  return sockets
}

// The inodes of the sockets a process holds open, empty when its fd directory is not readable.
export async function socketsOf(pid: number, root = '/proc'): Promise<Set<number>> {
  const inodes = new Set<number>()

  try {
    for (const fd of await readdir(`${root}/${pid}/fd`)) {
      const inode = socketInode(await link(`${root}/${pid}/fd/${fd}`) ?? '')

      if (inode !== undefined)
        inodes.add(inode)
    }
  }
  catch {}

  return inodes
}

// Which pid holds each socket inode, read in parallel across readable processes. Forked workers share the listen socket of their master: the holder whose parent holds it too is passed over.
export async function socketOwners(root = '/proc'): Promise<Map<number, number>> {
  const pids = await listPids(root)
  const perPid = await mapBounded(pids, PROC_CONCURRENCY, async pid => ({ pid, inodes: await socketsOf(pid, root) }))
  const holders = new Map<number, number[]>()

  for (const { pid, inodes } of perPid) {
    for (const inode of inodes)
      holders.set(inode, [...holders.get(inode) ?? [], pid])
  }

  const owners = new Map<number, number>()
  const parents = new Map<number, number | undefined>()

  for (const [inode, pids] of holders) {
    const [first = 0] = pids

    if (pids.length > 1) {
      for (const pid of pids) {
        if (!parents.has(pid))
          parents.set(pid, parseStat(await text(`${root}/${pid}/stat`) ?? '')?.ppid)
      }
    }

    owners.set(inode, pids.find(pid => !pids.includes(parents.get(pid) ?? -1)) ?? first)
  }

  return owners
}

export async function fdCount(pid: number, root = '/proc'): Promise<number | undefined> {
  try {
    return (await readdir(`${root}/${pid}/fd`)).length
  }
  catch {
    return undefined
  }
}

let passwd: string | undefined

export async function userName(uid: number): Promise<string | undefined> {
  passwd ??= await text('/etc/passwd') ?? ''

  return userNameOf(passwd, uid)
}

export { text as readText }
