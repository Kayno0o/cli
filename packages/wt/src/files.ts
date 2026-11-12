import type { ComposeConfig } from './compose'
import type { Route, Worktree } from './project'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { constants } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { escapeRegExp } from '@kaynooo/utils/text'
import { $ } from 'bun'
import { baseComposeFiles } from './compose'
import { failureText } from './errors'
import { worktreeHost, WtError } from './project'
import { inLine, queueDir } from './queue'

// A copy lands under this suffix and is renamed once whole, so one cut short is never taken for done.
const PARTIAL = '.wt-partial'
const PAUSE_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

export function writeIfChanged(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, 'utf8') === content)
    return false

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)

  return true
}

export async function volumeExists(name: string): Promise<boolean> {
  return (await $`docker volume inspect ${name}`.quiet().nothrow()).exitCode === 0
}

export async function copyFromMain(worktree: Worktree): Promise<string[]> {
  const warnings: string[] = []

  for (const entry of worktree.project.copy ?? []) {
    const source = join(worktree.project.root, entry)
    const target = join(worktree.dir, entry)

    if (!existsSync(source)) {
      warnings.push(`copy: ${entry} does not exist in main`)

      continue
    }

    if (existsSync(target))
      continue

    const partial = `${target}${PARTIAL}`

    mkdirSync(dirname(target), { recursive: true })
    rmSync(partial, { recursive: true, force: true })
    // A reflink shares the blocks of a vendor or node_modules copy on btrfs, and is a plain copy elsewhere.
    await $`cp -a --reflink=auto ${source} ${partial}`.quiet()
    renameSync(partial, target)
  }

  return warnings
}

export function linkFromMain(worktree: Worktree): void {
  for (const entry of worktree.project.link ?? []) {
    const source = join(worktree.project.root, entry)
    const target = join(worktree.dir, entry)

    if (existsSync(source) && !existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true })
      symlinkSync(source, target)
    }
  }
}

const WILDCARD_LABEL = /^\*\./

// Main hosts become the worktree's; the lookbehind keeps api.booki.localhost whole and makes a second pass a no-op.
export function rewriteHosts(text: string, routes: Route[], task: string): string {
  const hosts = [...new Set(routes.map(route => route.host.replace(WILDCARD_LABEL, '')))].sort((a, b) => b.length - a.length)

  // An empty alternation would match the empty string between any two characters.
  if (hosts.length === 0)
    return text

  const pattern = new RegExp(`(?<![\\w.-])(\\.?)(${hosts.map(escapeRegExp).join('|')})(?![\\w.-])`, 'g')

  return text.replace(pattern, (_, dot: string, host: string) => `${dot}${worktreeHost(host, task)}`)
}

export function setEnvValue(text: string, key: string, value: string): string {
  const line = `${key}=${value}`
  const pattern = new RegExp(`^${escapeRegExp(key)}=.*$`, 'm')

  if (pattern.test(text))
    return text.replace(pattern, () => line)

  return `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`
}

export function expandEnvValue(value: string, worktree: Worktree): string {
  return value.replaceAll('{task}', worktree.task).replaceAll('{port}', String(worktree.clientPort))
}

export function writeEnvFiles(worktree: Worktree): void {
  const { project, task, dir } = worktree
  const envFiles = (project.copy ?? []).filter(entry => basename(entry).startsWith('.env') && statSync(join(dir, entry), { throwIfNoEntry: false })?.isFile())

  for (const entry of new Set([...envFiles, '.env'])) {
    const file = join(dir, entry)
    let text = existsSync(file) ? rewriteHosts(readFileSync(file, 'utf8'), project.routes, task) : ''

    for (const [key, value] of Object.entries(project.env?.[entry] ?? {}))
      text = setEnvValue(text, key, expandEnvValue(value, worktree))

    if (entry === '.env') {
      text = setEnvValue(text, 'COMPOSE_PROJECT_NAME', worktree.id)
      text = setEnvValue(text, 'COMPOSE_FILE', [...baseComposeFiles(dir, worktree.project.settings.overrides), worktree.files.override].join(':'))
    }

    writeIfChanged(file, text)
  }
}

// A worktree made by the old wt symlinked its data to main's; the link goes so the copy can take its place.
function unlinkLegacySymlink(dir: string, entry: string): void {
  let path = dir

  for (const part of entry.split('/')) {
    path = join(path, part)

    const stat = lstatSync(path, { throwIfNoEntry: false })

    if (!stat)
      return

    if (stat.isSymbolicLink())
      return unlinkSync(path)
  }
}

async function mainContainers(main: ComposeConfig, status: 'running' | 'paused'): Promise<string[]> {
  return (await $`docker ps -q --filter ${`status=${status}`} --filter ${`label=com.docker.compose.project=${main.name}`}`.quiet().text()).split('\n').filter(Boolean)
}

// Synchronous, so a signal handler can run it before the process exits.
function unpause(ids: string[]): void {
  if (ids.length)
    Bun.spawnSync(['docker', 'unpause', ...ids], { stdout: 'ignore', stderr: 'ignore' })
}

/**
 * A Ctrl+C or a kill of the job runs `abort` and unpauses main on the way out; only a SIGKILL leaves it paused, for the next sync to find.
 * `record` is the file the paused ids are kept in meanwhile, so that sync unpauses those alone and not a container paused by hand.
 */
export async function whilePaused<T>(ids: string[], work: () => Promise<T>, abort?: () => void, record?: string): Promise<T> {
  const release = () => {
    unpause(ids)

    if (record !== undefined)
      rmSync(record, { force: true })
  }
  const onSignal = (signal: NodeJS.Signals) => {
    abort?.()
    release()
    process.exit(128 + constants.signals[signal])
  }

  for (const signal of PAUSE_SIGNALS)
    process.once(signal, onSignal)

  try {
    if (ids.length) {
      if (record !== undefined) {
        mkdirSync(dirname(record), { recursive: true })
        writeFileSync(record, `${ids.join('\n')}\n`)
      }

      await $`docker pause ${ids}`.quiet()
    }

    return await work()
  }
  finally {
    for (const signal of PAUSE_SIGNALS)
      process.off(signal, onSignal)

    release()
  }
}

/** Runs every copy to its end, a failed one included, so main is unpaused only once none is still reading it; the failures come back. */
export async function settle(copies: (() => Promise<void>)[]): Promise<unknown[]> {
  const results = await Promise.allSettled(copies.map(async copy => copy()))

  return results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
}

// The ids of main's containers a clone of the project paused, one per line, while it copies.
const pausedRecord = (worktree: Worktree) => queueDir(worktree.project.settings, `${worktree.project.name}.paused`)

function readPending(file: string): Set<string> {
  return new Set(existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [])
}

function writePending(file: string, volumes: Iterable<string>): void {
  const text = [...volumes].join('\n')

  if (!text)
    return rmSync(file, { force: true })

  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${text}\n`)
}

/**
 * Each worktree starts from a copy of main's data, taken while main's containers are paused so a database is never copied mid-write.
 * Clones of one project run one at a time, so no clone unpauses main while another still copies; a copy cut short is redone by the next sync, and main's containers a killed clone left paused are unpaused, those it had paused only.
 */
export async function cloneData(worktree: Worktree, main: ComposeConfig): Promise<string[]> {
  return inLine(queueDir(worktree.project.settings, `${worktree.project.name}.clone`), `cloning ${worktree.task}`, (_, running) => console.error(`wt: ${worktree.project.name}'s main is busy ${running || 'cloning'}, waiting`), async () => {
    const record = pausedRecord(worktree)
    const recorded = readPending(record)
    const leftover = recorded.size ? (await mainContainers(main, 'paused')).filter(id => recorded.has(id)) : []

    unpause(leftover)
    rmSync(record, { force: true })

    const warnings = leftover.length ? [`clone: unpaused ${leftover.length} of main's containers a clone cut short had left paused`] : []

    return [...warnings, ...await cloneInLine(worktree, main)]
  })
}

async function cloneInLine(worktree: Worktree, main: ComposeConfig): Promise<string[]> {
  const warnings: string[] = []
  const pending: { volume?: string, copy: () => Promise<void> }[] = []
  const unfinished = readPending(worktree.files.clonesPending)
  // The copies run in containers, which a signal to this process alone would leave copying from an unpaused main
  const copyLabel = `wt.clone=${worktree.id}`
  const stopCopies = () => {
    const ids = Bun.spawnSync(['docker', 'ps', '-q', '--filter', `label=${copyLabel}`]).stdout.toString().split('\n').filter(Boolean)

    if (ids.length)
      Bun.spawnSync(['docker', 'rm', '-f', ...ids], { stdout: 'ignore', stderr: 'ignore' })
  }

  for (const entry of worktree.project.clone ?? []) {
    const source = join(worktree.project.root, entry)

    if (existsSync(source)) {
      unlinkLegacySymlink(worktree.dir, entry)

      const target = join(worktree.dir, entry)

      if (existsSync(target))
        continue

      if (!statSync(source).isDirectory())
        throw new WtError(`clone: ${entry} is not a directory`)

      // Copied beside the target then renamed, all as the container's root since what main holds may be root's
      const partial = `/to/${basename(target)}${PARTIAL}`

      pending.push({
        copy: async () => {
          mkdirSync(dirname(target), { recursive: true })
          await $`docker run --rm --label ${copyLabel} -v ${`${source}:/from:ro`} -v ${`${dirname(target)}:/to`} alpine sh -c ${`rm -rf '${partial}' && mkdir '${partial}' && cp -a /from/. '${partial}/' && mv '${partial}' '/to/${basename(target)}'`}`.quiet()
        },
      })

      continue
    }

    const volume = main.volumes?.[entry]

    if (!volume) {
      warnings.push(`clone: ${entry} is neither a path in main nor a volume of its stack`)

      continue
    }

    if (volume.driver_opts?.device !== undefined && volume.driver_opts.device !== '')
      throw new WtError(`clone: volume ${entry} is a bind to ${volume.driver_opts.device}, list that path instead`)

    const sourceVolume = volume.name ?? `${main.name}_${entry}`
    const targetVolume = `${worktree.id}_${entry}`

    if (await volumeExists(targetVolume)) {
      if (!unfinished.has(targetVolume))
        continue

      const removed = await $`docker volume rm ${targetVolume}`.quiet().nothrow()

      if (removed.exitCode !== 0)
        throw new WtError(`clone: volume ${targetVolume} was cut short mid-copy and cannot be emptied (${removed.stderr.toString().trim()}), \`wt down ${worktree.task}\` then \`wt sync ${worktree.task}\``)
    }

    if (!await volumeExists(sourceVolume)) {
      warnings.push(`clone: main has no volume ${sourceVolume} yet, the worktree starts with an empty one`)

      continue
    }

    pending.push({
      volume: targetVolume,
      copy: async () => {
        await $`docker volume create --label ${`com.docker.compose.project=${worktree.id}`} --label ${`com.docker.compose.volume=${entry}`} ${targetVolume}`.quiet()
        await $`docker run --rm --label ${copyLabel} -v ${`${sourceVolume}:/from:ro`} -v ${`${targetVolume}:/to`} alpine cp -a /from/. /to/`.quiet()
        unfinished.delete(targetVolume)
      },
    })
  }

  if (!pending.length) {
    writePending(worktree.files.clonesPending, unfinished)

    return warnings
  }

  for (const { volume } of pending) {
    if (volume !== undefined)
      unfinished.add(volume)
  }

  writePending(worktree.files.clonesPending, unfinished)

  const failures = await whilePaused(await mainContainers(main, 'running'), async () => settle(pending.map(({ copy }) => copy)), stopCopies, pausedRecord(worktree))

  writePending(worktree.files.clonesPending, unfinished)

  if (failures.length)
    throw new WtError(`clone failed, \`wt sync ${worktree.task}\` starts it again:\n${failures.map(failureText).join('\n')}`)

  return warnings
}
