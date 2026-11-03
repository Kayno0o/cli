import type { Limit, Socket } from './parse'
import type { ProcInfo } from './read'
import process from 'node:process'
import { fail, formatFileSize, formatSeconds, jsonOption, paint, parse, printJson } from '@kaynooo/cli-kit'
import { maskArgs, maskEnviron } from './mask'
import { parseCgroup, parseEnviron, parseLimits, parseStat, parseStatus, statusBytes } from './parse'
import { bootMs, fdCount, readProc, readSockets, readText, socketsOf, userName } from './read'

const usage = `pid <pid>

Shows what a process is: its executable, working directory, command line, parent chain up to init, user, start time and age, memory, open files and limits, the TCP and UDP ports it listens on and its cgroup. Everything is read from /proc; what the calling user cannot read of another user's process is left out and named at the end.
The environment is not shown unless --env is given, with every value that looks like a secret masked.

Exits 0 when it showed the process, 1 when no process has this pid, 2 on a usage error.`

const DIGITS = /^\d+$/

const options = {
  env: { type: 'boolean', description: 'show the environment, secrets masked' },
  json: jsonOption('everything, with the environment under env when --env is given'),
} as const

export interface Parent {
  pid: number
  comm: string
  command: string
}

export interface Report {
  pid: number
  comm: string
  state: string
  exe: string | undefined
  cwd: string | undefined
  command: string[]
  parents: Parent[]
  user: { uid: number, name: string | undefined }
  startedAt: string
  ageSeconds: number
  threads: number | undefined
  memory: { rss: number | undefined, peak: number | undefined, virtual: number | undefined, swap: number | undefined }
  openFiles: number | undefined
  limits: Limit[]
  listening: { protocol: string, address: string, port: number }[]
  cgroup: string | undefined
  container: string | undefined
  env: { name: string, value: string }[] | undefined
  unreadable: string[]
}

async function parentsOf(proc: ProcInfo, boot: number): Promise<Parent[]> {
  const parents: Parent[] = []
  const seen = new Set([proc.pid])
  let at = proc.ppid

  while (at > 0 && !seen.has(at)) {
    seen.add(at)

    const parent = await readProc(at, boot, { detail: false })

    if (parent === undefined)
      break

    parents.push({ pid: parent.pid, comm: parent.comm, command: maskArgs(parent.args).join(' ') })
    at = parent.ppid
  }

  return parents
}

async function report(pid: number, showEnv: boolean): Promise<Report | undefined> {
  const boot = await bootMs()
  const proc = await readProc(pid, boot)

  if (proc === undefined)
    return undefined

  const unreadable: string[] = []
  const status = parseStatus(await readText(`/proc/${pid}/status`) ?? '')
  const limitsText = await readText(`/proc/${pid}/limits`)
  const sockets = await socketsOf(pid)
  const listening: Socket[] = sockets.size === 0 ? [] : (await readSockets()).filter(socket => sockets.has(socket.inode))
  const environText = showEnv ? await readText(`/proc/${pid}/environ`) : undefined
  const cgroup = parseCgroup(await readText(`/proc/${pid}/cgroup`) ?? '')[0]?.path
  const files = await fdCount(pid)
  const stat = parseStat(await readText(`/proc/${pid}/stat`) ?? '')
  const uid = proc.uid

  if (proc.exe === undefined)
    unreadable.push('executable')

  if (proc.cwd === undefined)
    unreadable.push('working directory')

  if (files === undefined)
    unreadable.push('open files')

  if (limitsText === undefined)
    unreadable.push('limits')

  if (showEnv && environText === undefined)
    unreadable.push('environment')

  return {
    pid,
    comm: proc.comm,
    state: proc.state,
    exe: proc.exe,
    cwd: proc.cwd,
    command: maskArgs(proc.args),
    parents: await parentsOf(proc, boot),
    user: { uid, name: await userName(uid) },
    startedAt: new Date(proc.startMs).toISOString(),
    ageSeconds: Math.max(0, (Date.now() - proc.startMs) / 1000),
    threads: stat?.threads,
    memory: { rss: statusBytes(status, 'VmRSS'), peak: statusBytes(status, 'VmHWM'), virtual: statusBytes(status, 'VmSize'), swap: statusBytes(status, 'VmSwap') },
    openFiles: files,
    limits: parseLimits(limitsText ?? ''),
    listening: listening.map(({ protocol, address, port }) => ({ protocol, address, port })),
    cgroup: cgroup === '' ? undefined : cgroup,
    container: proc.container,
    env: environText === undefined ? undefined : maskEnviron(parseEnviron(environText)).map(([name, value]) => ({ name, value })),
    unreadable,
  }
}

function limitLine(limits: Limit[], name: string): string {
  const limit = limits.find(candidate => candidate.name === name)

  return limit === undefined ? '-' : `soft ${limit.soft}, hard ${limit.hard}`
}

function render(info: Report, showEnv: boolean): string {
  const colors = paint(process.stdout)
  const memory = info.memory
  const size = (bytes: number | undefined) => bytes === undefined ? '-' : formatFileSize(bytes)
  const rows: [string, string][] = [
    ['Executable', info.exe ?? '-'],
    ['Directory', info.cwd ?? '-'],
    ['Command', info.command.join(' ') || `[${info.comm}]`],
    ['Parents', info.parents.length === 0 ? 'none (init)' : info.parents.map(parent => `${parent.pid} ${parent.comm}`).join(' < ')],
    ['User', `${info.user.name ?? '?'} (${info.user.uid})`],
    ['State', info.state],
    ['Started', `${info.startedAt} (${formatSeconds(info.ageSeconds)} ago)`],
    ['Memory', `rss ${size(memory.rss)}, peak ${size(memory.peak)}, virtual ${size(memory.virtual)}, swap ${size(memory.swap)}`],
    ['Open files', `${info.openFiles ?? '-'} (limit ${limitLine(info.limits, 'Max open files')})`],
    ['Processes', `${info.threads ?? '-'} threads (limit ${limitLine(info.limits, 'Max processes')})`],
    ['Listening', info.listening.length === 0 ? 'nothing' : info.listening.map(({ protocol, address, port }) => `${protocol} ${address.includes(':') ? `[${address}]` : address}:${port}`).join(', ')],
  ]

  if (info.cgroup !== undefined)
    rows.push(['Cgroup', info.cgroup])

  const lines = [colors.bold(`pid ${info.pid} ${info.comm}`), ...rows.map(([label, value]) => `${colors.dim(label.padEnd(11))} ${value}`)]

  if (showEnv && info.env !== undefined)
    lines.push('', colors.bold('Environment'), ...info.env.map(({ name, value }) => `${name}=${value}`))
  else if (!showEnv)
    lines.push('', colors.dim('Environment hidden, pass --env to show it with secrets masked'))

  if (info.unreadable.length > 0)
    lines.push('', colors.yellow(`Could not read: ${info.unreadable.join(', ')} (a process of another user: rerun as that user)`))

  return lines.join('\n')
}

export async function pid(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, usage, options, {
    positionals: ['<pid>'],
    replaces: 'cat /proc/<pid>/{cmdline,environ,limits}, readlink /proc/<pid>/{exe,cwd}, the fish pid function',
    examples: [
      ['pid 4242', 'executable, directory, command, parents, memory, limits and ports'],
      ['pid 4242 --env', 'with the environment, secrets masked'],
      'pid 4242 --json',
    ],
  })
  const [given] = positionals

  if (!DIGITS.test(given))
    fail(`the pid takes a number, not ${given}`, 2)

  const info = await report(Number(given), values.env === true)

  if (info === undefined)
    return fail(`no process with pid ${given}`, 1)

  if (values.json === true)
    printJson(info)
  else
    console.log(render(info, values.env === true))

  return 0
}
