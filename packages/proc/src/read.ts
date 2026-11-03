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

  if (!detail)
    return info

  const [cwd, exe, cgroup] = await Promise.all([link(`${dir}/cwd`), link(`${dir}/exe`), text(`${dir}/cgroup`)])
  const groups = parseCgroup(cgroup ?? '')

  return { ...info, cwd, exe, unit: cgroupUnit(groups), container: cgroupContainer(groups) }
}

// Every process, with the detail only for those `detailed` accepts: the ones of the calling user, whose directories are readable.
export async function snapshot(root = '/proc', detailed: (uid: number) => boolean = () => true): Promise<ProcInfo[]> {
  const boot = await bootMs(root)
  const found: ProcInfo[] = []

  for (const pid of await listPids(root)) {
    const light = await readProc(pid, boot, { root, detail: false })

    if (light === undefined)
      continue

    found.push(detailed(light.uid) ? await readProc(pid, boot, { root }) ?? light : light)
  }

  return found
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

// Which pid holds each socket inode, for the processes whose fd directory can be read.
export async function socketOwners(root = '/proc'): Promise<Map<number, number>> {
  const owners = new Map<number, number>()

  for (const pid of await listPids(root)) {
    for (const inode of await socketsOf(pid, root))
      owners.set(inode, pid)
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
