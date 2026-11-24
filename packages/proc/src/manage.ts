import type { ExitRow } from '@kaynooo/cli-kit'
import type { ProcInfo } from './read'
import process from 'node:process'
import { badUsage, duration, fail, formatFileSize, formatSeconds, jsonOption, paint, parse, printJson, problem, table, truncate, watching, watchOption, wholeNumber, withoutWatch } from '@kaynooo/cli-kit'
import { confirm } from '@kaynooo/cli-kit/prompt'
import { protectionOf, terminate } from './kill'
import { maskArgs } from './mask'
import { ancestry, fdCount, snapshot } from './read'

const DIGITS = /^\d+$/

function commandOf(proc: ProcInfo): string {
  return maskArgs(proc.args).join(' ') || `[${proc.comm}]`
}

const LS_USAGE = `proc ls [pattern]: lists processes matching an optional pattern (substring or regex) on command, comm or cwd`
const LS_EXITS: ExitRow[] = [[0, 'listed matching processes'], [1, 'no process matched'], [2, 'a usage error']]
const LS_OPTIONS = {
  all: { type: 'boolean', short: 'a', description: 'include processes of other users (default: calling user only)' },
  sort: { type: 'string', short: 's', choices: ['rss', 'pid', 'age'] as const, description: 'sort order: rss (default), pid, or age' },
  limit: { type: 'string', short: 'n', description: 'maximum rows to print (50)' },
  json: jsonOption('[{pid, ppid, comm, command, cwd, rss, ageSeconds}]'),
} as const

export async function lsCmd(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, LS_USAGE, LS_OPTIONS, {
    exits: LS_EXITS,
    positionals: ['[pattern]'],
    examples: ['proc ls', 'proc ls vite', 'proc find bun --sort age'],
  })
  const [pattern] = positionals
  let regex: RegExp | undefined

  if (pattern !== undefined) {
    try {
      regex = new RegExp(pattern, 'i')
    }
    catch (error) {
      badUsage(`invalid pattern: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const uid = process.getuid?.() ?? -1
  const all = await snapshot('/proc', owner => values.all === true || owner === uid)
  const now = Date.now()
  const filtered = all
    .filter(proc => (values.all === true || proc.uid === uid) && proc.pid !== process.pid)
    .filter((proc) => {
      if (regex === undefined)
        return true

      return regex.test(commandOf(proc)) || regex.test(proc.comm) || (proc.cwd !== undefined && regex.test(proc.cwd))
    })

  const sortBy = values.sort ?? 'rss'

  filtered.sort((a, b) => {
    if (sortBy === 'pid')
      return a.pid - b.pid

    return sortBy === 'age' ? a.startMs - b.startMs : b.rss - a.rss || a.pid - b.pid
  })

  if (pattern !== undefined && filtered.length === 0) {
    if (values.json === true)
      printJson([])
    else
      problem(`no process matched ${pattern}`)

    return 1
  }

  const limit = wholeNumber(values.limit, 'limit', 50, 1)
  const shown = filtered.slice(0, limit)

  if (values.json === true) {
    printJson(shown.map(proc => ({ pid: proc.pid, ppid: proc.ppid, comm: proc.comm, command: commandOf(proc), cwd: proc.cwd, rss: proc.rss, ageSeconds: Math.max(0, Math.round((now - proc.startMs) / 1000)) })))

    return 0
  }

  const colors = paint(process.stdout)

  console.log(table([
    ['PID', 'PPID', 'RSS', 'AGE', 'COMMAND', 'CWD'],
    ...shown.map(proc => [
      colors.cyan(String(proc.pid)),
      colors.dim(String(proc.ppid)),
      formatFileSize(proc.rss),
      formatSeconds(Math.max(0, (now - proc.startMs) / 1000)),
      truncate(commandOf(proc), 60),
      colors.dim(proc.cwd ?? '-'),
    ]),
  ], { header: true, align: ['right', 'right', 'right', 'right', 'left', 'left'] }))

  return 0
}

const TREE_USAGE = `proc tree [pid]: prints the process hierarchy rooted at pid (or the calling user's top-level processes)`
const TREE_EXITS: ExitRow[] = [[0, 'printed process tree'], [1, 'no process has this pid'], [2, 'a usage error']]
const TREE_OPTIONS = {
  all: { type: 'boolean', short: 'a', description: 'include processes of all users when no pid is given' },
  json: jsonOption('[{pid, ppid, comm, command, rss, children: [...]}]'),
} as const

interface TreeNode {
  pid: number
  ppid: number
  comm: string
  command: string
  rss: number
  children: TreeNode[]
}

export async function treeCmd(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, TREE_USAGE, TREE_OPTIONS, {
    exits: TREE_EXITS,
    positionals: ['[pid]'],
    examples: ['proc tree', 'proc tree 1234'],
  })
  const [given] = positionals

  if (given !== undefined && !DIGITS.test(given))
    fail(`the pid takes a number, not ${given}`, 2)

  const uid = process.getuid?.() ?? -1
  const all = await snapshot('/proc', owner => owner === uid)
  const byPid = new Map(all.map(proc => [proc.pid, proc]))
  const childrenByPid = new Map<number, ProcInfo[]>()

  for (const proc of all)
    childrenByPid.set(proc.ppid, [...(childrenByPid.get(proc.ppid) ?? []), proc])

  for (const list of childrenByPid.values())
    list.sort((a, b) => a.pid - b.pid)

  const build = (proc: ProcInfo, seen = new Set<number>()): TreeNode => {
    seen.add(proc.pid)

    return {
      pid: proc.pid,
      ppid: proc.ppid,
      comm: proc.comm,
      command: commandOf(proc),
      rss: proc.rss,
      children: (childrenByPid.get(proc.pid) ?? []).filter(child => !seen.has(child.pid)).map(child => build(child, seen)),
    }
  }

  let roots: TreeNode[]

  if (given !== undefined) {
    const rootProc = byPid.get(Number(given))

    if (rootProc === undefined)
      return fail(`no process with pid ${given}`, 1)

    roots = [build(rootProc)]
  }
  else {
    const visible = all.filter(proc => values.all === true || proc.uid === uid)
    const visiblePids = new Set(visible.map(proc => proc.pid))

    roots = visible.filter(proc => !visiblePids.has(proc.ppid)).sort((a, b) => a.pid - b.pid).map(proc => build(proc))
  }

  if (values.json === true) {
    printJson(roots)

    return 0
  }

  const colors = paint(process.stdout)
  const renderNode = (node: TreeNode, prefix: string, isLast: boolean, isRoot: boolean): void => {
    let branch = ''

    if (!isRoot)
      branch = isLast ? '└─ ' : '├─ '

    console.log(`${prefix}${branch}${colors.cyan(String(node.pid))} ${node.comm} ${colors.dim(formatFileSize(node.rss))} ${colors.dim(truncate(node.command, 70))}`)

    const nextPrefix = isRoot ? '' : `${prefix}${isLast ? '   ' : '│  '}`

    for (const [idx, child] of node.children.entries())
      renderNode(child, nextPrefix, idx === node.children.length - 1, false)
  }

  for (const root of roots)
    renderNode(root, '', true, true)

  return 0
}

const TOP_USAGE = `proc top [options]: shows the heaviest processes by resident memory, open file descriptors, or age`
const TOP_EXITS: ExitRow[] = [[0, 'listed top processes'], [2, 'a usage error']]
const TOP_OPTIONS = {
  by: { type: 'string', choices: ['rss', 'fds', 'age'] as const, description: 'rank by: rss (default), fds, or age' },
  limit: { type: 'string', short: 'n', description: 'how many processes to show (15)' },
  all: { type: 'boolean', short: 'a', description: 'include processes of other users' },
  watch: watchOption('top processes'),
  json: jsonOption('[{pid, comm, command, rss, fds, ageSeconds, cwd}]'),
} as const

export async function topCmd(args: string[]): Promise<number> {
  const { values } = parse(args, TOP_USAGE, TOP_OPTIONS, {
    exits: TOP_EXITS,
    examples: ['proc top', 'proc top --by fds -n 10', 'proc top --watch 2s'],
  })

  if (values.watch !== undefined)
    return watching(values.watch, async () => topCmd(withoutWatch(args)))

  const uid = process.getuid?.() ?? -1
  const by = values.by ?? 'rss'
  const limit = wholeNumber(values.limit, 'limit', 15, 1)
  const now = Date.now()
  const procs = (await snapshot('/proc', owner => owner === uid)).filter(proc => values.all === true || proc.uid === uid)
  const rows = await Promise.all(procs.map(async proc => ({
    pid: proc.pid,
    comm: proc.comm,
    command: commandOf(proc),
    rss: proc.rss,
    fds: by === 'fds' ? (await fdCount(proc.pid) ?? 0) : undefined,
    ageSeconds: Math.max(0, Math.round((now - proc.startMs) / 1000)),
    cwd: proc.cwd,
  })))

  rows.sort((a, b) => {
    if (by === 'fds')
      return (b.fds ?? 0) - (a.fds ?? 0) || b.rss - a.rss

    return by === 'age' ? b.ageSeconds - a.ageSeconds || b.rss - a.rss : b.rss - a.rss || a.pid - b.pid
  })

  const shown = rows.slice(0, limit)

  if (values.json === true) {
    printJson(shown)

    return 0
  }

  const colors = paint(process.stdout)
  const header = by === 'fds' ? ['PID', 'FDS', 'RSS', 'AGE', 'COMMAND'] : ['PID', 'RSS', 'AGE', 'COMMAND']

  console.log(table([
    header,
    ...shown.map(row => by === 'fds'
      ? [colors.cyan(String(row.pid)), String(row.fds ?? 0), formatFileSize(row.rss), formatSeconds(row.ageSeconds), truncate(row.command, 70)]
      : [colors.cyan(String(row.pid)), formatFileSize(row.rss), formatSeconds(row.ageSeconds), truncate(row.command, 70)]),
  ], { header: true, align: by === 'fds' ? ['right', 'right', 'right', 'right', 'left'] : ['right', 'right', 'right', 'left'] }))

  return 0
}

const KILL_USAGE = `proc kill <pid>...: safely stops one or more processes owned by the calling user (SIGTERM, with --force escalating to SIGKILL)`
const KILL_EXITS: ExitRow[] = [[0, 'stopped every target process'], [1, 'a pid was missing, refused, or survived'], [2, 'a usage error']]
const KILL_OPTIONS = {
  force: { type: 'boolean', short: 'f', description: 'escalate to SIGKILL if SIGTERM does not stop the process within --grace' },
  yes: { type: 'boolean', short: 'y', description: 'do not ask for confirmation on a terminal' },
  grace: { type: 'string', description: 'time SIGTERM gets before SIGKILL with --force (5s)' },
  json: jsonOption('{terminated: number[], killed: number[], survived: number[]}'),
} as const

export async function killCmd(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, KILL_USAGE, KILL_OPTIONS, {
    exits: KILL_EXITS,
    positionals: ['<pid>...'],
    examples: ['proc kill 4242 --yes', 'proc kill 4242 4243 --force --yes'],
  })
  const pids = positionals.map((given) => {
    if (!DIGITS.test(given))
      badUsage(`the pid takes a number, not ${given}`)

    return Number(given)
  })
  const uid = process.getuid?.() ?? -1
  const all = await snapshot('/proc', owner => owner === uid)
  const byPid = new Map(all.map(proc => [proc.pid, proc]))
  const guard = { uid, mine: new Set(ancestry(process.pid, byPid)) }
  const allowed: ProcInfo[] = []
  let refused = false

  for (const pid of new Set(pids)) {
    const proc = byPid.get(pid)

    if (proc === undefined) {
      problem(`no process with pid ${pid}`)
      refused = true

      continue
    }

    const reason = protectionOf(proc, guard)

    if (reason !== undefined) {
      problem(`pid ${pid} is ${reason}`)
      refused = true

      continue
    }

    allowed.push(proc)
  }

  if (allowed.length === 0)
    return 1

  const names = allowed.map(proc => `${proc.pid} (${truncate(commandOf(proc), 40)})`).join(', ')

  if (values.yes !== true) {
    if (!process.stdin.isTTY)
      fail(`stopping ${names} needs a terminal to ask on: pass --yes`, 2)

    if (await confirm(`Stop ${names}?`, { default: false, hint: 'pass --yes to stop without asking' }) !== true)
      return 1
  }

  const outcome = await terminate(allowed.map(proc => proc.pid), { escalate: values.force === true, graceMs: duration(values.grace, 'grace', 5000) })

  if (values.json === true) {
    printJson(outcome)
  }
  else {
    for (const pid of [...outcome.terminated, ...outcome.killed])
      console.log(`stopped ${pid}${outcome.killed.includes(pid) ? ' (SIGKILL)' : ''}`)

    for (const pid of outcome.survived)
      problem(`${pid} is still running${values.force === true ? '' : ', pass --force to SIGKILL it'}`)
  }

  return refused || outcome.survived.length > 0 ? 1 : 0
}
