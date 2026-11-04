import type { Group } from './select'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import process from 'node:process'
import { duration, fail, formatFileSize, formatSeconds, jsonOption, paint, parse, parseSize, printJson, table, truncate } from '@kaynooo/cli-kit'
import { terminate } from './kill'
import { maskArgs } from './mask'
import { ancestry, snapshot } from './read'
import { selectGroups } from './select'

const usage = `procs

Lists the leftover or heavy processes of the calling user that are worth cleaning, grouped by origin: the project folder their working directory is in, a browser profile for a chromium and its helpers, else their command. Each group shows its process count, total resident memory and oldest age.
A process is listed when it is a dev tool (bun, node, vite, nuxt, next, chromium and chrome, playwright and webview browsers and their helpers, language servers, test runners) and either an orphan, reparented to init or to the user's systemd, or heavy (500M resident by default). The processes below a listed one, and those sharing a browser profile with it, are listed too, so a chromium whose main process was killed groups with its leftover helpers.
\`--kill\` is a dry run that names what it would stop unless --yes is given; it sends SIGTERM, then SIGKILL after --grace to what is still there. It never signals pid 1, shells, terminals, this command and its ancestors, or processes of other users.

Exits 0 when it listed or stopped everything, 1 when a process survived SIGKILL, 2 on a usage error.`

const options = {
  'json': jsonOption('{ groups: [{ origin, kind, count, rss, oldestSeconds, tools, orphans, pids, processes }], skipped }'),
  'kill': { type: 'boolean', description: 'stop the listed processes: a dry run without --yes' },
  'yes': { type: 'boolean', short: 'y', description: 'with --kill, really stop them, without asking' },
  'min-mem': { type: 'string', description: 'heavy from this resident size (500M), and the least a left over process must use to be listed; a bare number counts megabytes' },
  'older': { type: 'string', description: 'only processes at least this old: 30m, 2h, 1d' },
  'grace': { type: 'string', description: 'how long SIGTERM gets before SIGKILL (5s)' },
} as const

function summary(group: Group) {
  const tools: Record<string, number> = {}

  for (const { tool } of group.members)
    tools[tool] = (tools[tool] ?? 0) + 1

  return {
    origin: group.origin,
    kind: group.kind,
    count: group.members.length,
    rss: group.rss,
    oldestSeconds: Math.round(group.oldestMs / 1000),
    tools,
    orphans: group.orphans,
    pids: group.members.map(({ proc }) => proc.pid),
    processes: group.members.map(({ proc, tool, orphan, heavy, ageMs }) => ({ pid: proc.pid, ppid: proc.ppid, tool, command: maskArgs(proc.args).join(' ') || proc.comm, cwd: proc.cwd, rss: proc.rss, ageSeconds: Math.round(ageMs / 1000), orphan, heavy })),
  }
}

function render(groups: Group[]): string {
  const colors = paint(process.stdout)
  const rows = groups.map(group => [
    group.origin,
    String(group.members.length),
    formatFileSize(group.rss),
    formatSeconds(group.oldestMs / 1000),
    colors.dim(truncate(Object.entries(Object.groupBy(group.members, ({ tool }) => tool)).map(([tool, list]) => `${tool}${list!.length > 1 ? ` x${list!.length}` : ''}`).join(', '), 50)),
    group.orphans === 0 ? '' : colors.yellow(`${group.orphans} orphaned`),
  ])

  return table([['ORIGIN', 'PROCS', 'RSS', 'OLDEST', 'WHAT', ''], ...rows], { header: true, align: ['left', 'right', 'right', 'right'] })
}

export async function procs(args: string[]): Promise<number> {
  const { values } = parse(args, usage, options, {
    replaces: 'pkill -f and pgrep -f one-liners (which match their own shell), ps aux | grep for leftover chromium, bun or vite processes',
    examples: [
      ['procs', 'leftover and heavy dev processes, by origin'],
      ['procs --min-mem 1G --older 1h', 'only the big ones that have run a while'],
      ['procs --kill', 'dry run: what would be stopped'],
      'procs --kill --yes',
    ],
  })
  const minMem = values['min-mem'] === undefined ? undefined : parseSize(values['min-mem'], 1024 ** 2)

  if (values['min-mem'] !== undefined && minMem === undefined)
    fail(`--min-mem takes a size such as 500M or 1.5G, not ${values['min-mem']}`, 2)

  const olderMs = values.older === undefined ? undefined : duration(values.older, 'older', 0, 'm')
  const uid = process.getuid?.() ?? -1
  const all = await snapshot('/proc', owner => owner === uid)
  const mine = new Set(ancestry(process.pid, new Map(all.map(proc => [proc.pid, proc]))))
  const { groups, protectedCount } = selectGroups(all, { guard: { uid, mine }, now: Date.now(), home: homedir(), exists: existsSync, minMem, olderMs })
  const pids = groups.flatMap(group => group.members.map(({ proc }) => proc.pid))

  const show = (extra: object = {}): void => {
    if (values.json === true)
      printJson({ groups: groups.map(summary), skipped: protectedCount, ...extra })
    else
      console.log(groups.length === 0 ? 'nothing to clean' : render(groups))
  }

  if (values.kill !== true || pids.length === 0 || values.yes !== true) {
    show()

    if (values.json !== true && protectedCount > 0)
      console.error(paint(process.stderr).dim(`${protectedCount} more left out: shells, terminals and this command's ancestors are never touched`))

    if (values.kill === true && pids.length > 0)
      console.error(`dry run: would stop ${pids.length} ${pids.length === 1 ? 'process' : 'processes'} (${pids.join(' ')}), pass --yes to do it`)

    return 0
  }

  const outcome = await terminate(pids, { escalate: true, graceMs: duration(values.grace, 'grace', 5000) })

  show({ stopped: [...outcome.terminated, ...outcome.killed], killed: outcome.killed, survived: outcome.survived })

  if (values.json !== true)
    console.log(`stopped ${outcome.terminated.length + outcome.killed.length} of ${pids.length}${outcome.killed.length === 0 ? '' : `, ${outcome.killed.length} needed SIGKILL`}`)

  if (outcome.survived.length > 0)
    console.error(`still running: ${outcome.survived.join(' ')}`)

  return outcome.survived.length === 0 ? 0 : 1
}
