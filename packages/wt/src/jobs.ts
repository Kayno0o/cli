/**
 * One action at a time per stack: each holds the stack's lock while it runs and leaves a job file saying what ran and how it ended.
 * `--bg` runs the action detached from any terminal, its output in the stack's log, a notification telling how it went.
 * Tools pointing at the same folder share the locks: a project tool's up and wt's rm of one worktree never run together.
 */

import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatAge } from '@kaynooo/cli-kit'
import { $ } from 'bun'
import { alive, bootTime, failKnown, failureText, KnownError, knownMessage } from './errors'

export interface Job {
  ref: string
  verb: string
  /** The one service a restart, stop, start or rebuild acts on. */
  service?: string
  /** The process running it, null for the moment a detached one takes to start. */
  pid: number | null
  startedAt: number
  endedAt?: number
  /** Its exit code once ended, null when it was killed before it could say. */
  code?: number | null
  /** Where a detached job's output goes, empty for one run in a terminal. */
  log: string
}

export interface JobStack {
  ref: string
  slug: string
}

export interface JobState {
  /** The job running now. */
  running?: Job
  /** The last one that ended, or was killed before it could. */
  last?: Job
}

/** The locks the jobs of this process tree hold, one `<pid> <lock path>` per line, so a command a job runs (wt rm running a project tool's `down`) works inside it instead of being refused. */
export const HELD_ENV = 'WT_JOBS_HELD'
/** How long a detached job may take to write its pid before its lock counts as abandoned. */
const STARTING_MS = 30_000
/** How long a takeover of an abandoned lock may last before another claimer takes it over in turn. */
const TAKEOVER_MS = 5_000
const TAIL_BYTES = 4096
/** What a refusal says of wt's own actions; another tool sharing the folder adds its verbs through `words`. */
const DOING: Record<string, string> = { up: 'coming up', down: 'stopping', add: 'being made', sync: 'syncing', rm: 'being removed' }
/** The actions a notification reports the success of, as a title and a body. */
const DONE: Record<string, [string, string]> = { up: ['is up', 'Its stack came up'], add: ['is ready', 'The worktree is made, its stack still down'] }

/** How a job ended, by its exit code: null for one killed before it could say, any other code a failure. */
const OUTCOMES: Record<string, string> = { 0: 'ok', null: 'killed' }

export interface JobWords {
  doing?: Record<string, string>
  done?: Record<string, [string, string]>
}

/** Written beside the file and renamed over it, so a mod reading it meanwhile never sees half of it. */
function writeJob(file: string, job: Job): void {
  const partial = `${file}.${process.pid}.tmp`

  writeFileSync(partial, JSON.stringify(job))
  renameSync(partial, file)
}

function readJob(file: string): Job | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Job
  }
  catch {
    return undefined
  }
}

/** What a job is doing, its service named: "restarting php"; a verb with no words is named as it is: "busy with panes". */
function doing(table: Record<string, string>, job: Pick<Job, 'verb' | 'service'> | undefined): string {
  const words = job === undefined ? 'busy' : table[job.verb] ?? `busy with ${job.verb}`

  return job?.service !== undefined ? `${words} ${job.service}` : words
}

/** Whether the lock is held: by a live pid written since boot, or still empty while its detached job starts. */
function held(lock: string, now = Date.now()): boolean {
  try {
    const pid = Number(readFileSync(lock, 'utf8').trim())
    const writtenAt = statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? 0

    if (writtenAt < bootTime())
      return false

    return pid ? alive(pid) : now - writtenAt < STARTING_MS
  }
  catch {
    return false
  }
}

/**
 * Removes an abandoned lock under a takeover file of its own, checking it is still abandoned once that is held: two claimers seeing the same dead lock would otherwise both remove it, the second one the lock the first had just made.
 * False when another claimer is taking it over right now.
 */
function takeOver(lock: string): boolean {
  const guard = `${lock}.takeover`

  try {
    writeFileSync(guard, '', { flag: 'wx' })
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
      throw error

    if (Date.now() - (statSync(guard, { throwIfNoEntry: false })?.mtimeMs ?? 0) < TAKEOVER_MS)
      return false

    rmSync(guard, { force: true })

    return takeOver(lock)
  }

  try {
    if (!held(lock))
      rmSync(lock, { force: true })

    return true
  }
  finally {
    rmSync(guard, { force: true })
  }
}

const heldHere = () => (process.env[HELD_ENV] ?? '').split('\n').filter(Boolean)
const heldEntry = (lock: string) => `${process.pid} ${lock}`

/** Whether an entry of HELD_ENV still names the lock's holder: a lock taken over since (its holder gone, its pid reused) holds another pid. */
function stillHeldBy(entry: string): boolean {
  const space = entry.indexOf(' ')
  const lock = entry.slice(space + 1)

  try {
    return readFileSync(lock, 'utf8').trim() === entry.slice(0, space) && held(lock)
  }
  catch {
    return false
  }
}

/** The last lines of a log, read from its end: a long build's log is not read whole, and one gone reads empty. */
export function logTail(file: string, lines = 5): string {
  try {
    const fd = openSync(file, 'r')

    try {
      const size = fstatSync(fd).size
      const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES))

      readSync(fd, buffer, 0, buffer.length, size - buffer.length)

      return buffer.toString('utf8').trim().split('\n').slice(-lines).join('\n')
    }
    finally {
      closeSync(fd)
    }
  }
  catch {
    return ''
  }
}

async function notify(app: string, title: string, body: string, critical = false): Promise<void> {
  if (Bun.which('notify-send') !== null)
    await $`notify-send -a ${app} ${critical ? ['-u', 'critical'] : []} ${title} ${body}`.quiet().nothrow()
}

/** A `--bg` command refused before any job started (the stack busy, a ref it does not know, a config that does not load): told by notification, as its caller is often a popup that closed meanwhile. */
export async function notifyRefused(app: string, what: string, message: string): Promise<void> {
  await notify(app, `${what} not started`, message, true)
}

/** The jobs of one folder, notified under `app`, whose `<APP>_JOB` env var marks the detached process of a job. */
export class Jobs {
  readonly dir: string
  readonly app: string
  readonly env: string

  readonly doing: Record<string, string>
  readonly done: Record<string, [string, string]>

  constructor({ dir, app, words = {} }: { dir: string, app: string, words?: JobWords }) {
    this.dir = dir
    this.app = app
    this.env = `${app.toUpperCase()}_JOB`
    this.doing = { ...DOING, ...words.doing }
    this.done = { ...DONE, ...words.done }
  }

  paths(slug: string) {
    return { job: join(this.dir, `${slug}.json`), lock: join(this.dir, `${slug}.lock`), log: join(this.dir, `${slug}.log`) }
  }

  /** Whether a job of this process tree already holds the stack's lock. */
  holds(stack: Pick<JobStack, 'slug'>): boolean {
    const { lock } = this.paths(stack.slug)

    return heldHere().some(entry => entry.endsWith(` ${lock}`) && stillHeldBy(entry))
  }

  /** Takes the stack's lock for `verb`, refusing while another action holds it; a lock its process left behind is taken over. */
  claim(stack: JobStack, verb: string, detached: boolean, service?: string): Job {
    const { job: jobFile, lock, log } = this.paths(stack.slug)

    mkdirSync(this.dir, { recursive: true })

    for (let attempt = 0; ; attempt++) {
      try {
        writeFileSync(lock, detached ? '' : String(process.pid), { flag: 'wx' })

        break
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
          throw error

        if (attempt > 0 || held(lock) || !takeOver(lock)) {
          const running = readJob(jobFile)

          throw new KnownError(`${stack.ref} is already ${doing(this.doing, running)}${running !== undefined && running.log !== '' ? `, see ${running.log}` : ''}`)
        }
      }
    }

    const job: Job = { ref: stack.ref, verb, ...service !== undefined && { service }, pid: detached ? null : process.pid, startedAt: Date.now(), log: detached ? log : '' }

    writeJob(jobFile, job)

    return job
  }

  /** The detached process takes over the job its parent claimed, writing its own pid into the lock. */
  adopt(stack: Pick<JobStack, 'slug'>): Job {
    const { job: jobFile, lock } = this.paths(stack.slug)
    const job = readJob(jobFile)

    if (!job)
      throw new KnownError(`no job claimed for ${stack.slug}`)

    job.pid = process.pid
    writeFileSync(lock, String(process.pid))
    writeJob(jobFile, job)

    return job
  }

  finish(stack: Pick<JobStack, 'slug'>, job: Job, code: number): void {
    const { job: jobFile, lock } = this.paths(stack.slug)

    writeJob(jobFile, { ...job, endedAt: Date.now(), code })
    rmSync(lock, { force: true })
  }

  /** What every stack's job file says, by slug. */
  states(): Map<string, JobState> {
    const states = new Map<string, JobState>()
    let files: string[]

    try {
      files = readdirSync(this.dir).filter(file => file.endsWith('.json'))
    }
    catch {
      return states
    }

    for (const file of files) {
      const slug = file.slice(0, -'.json'.length)
      const job = readJob(join(this.dir, file))

      if (!job)
        continue

      if (job.endedAt !== undefined)
        states.set(slug, { last: job })
      else if (held(this.paths(slug).lock))
        states.set(slug, { running: job })
      // Killed before it could say: it ended at the latest when its job file was last written, so a mod waiting on it sees it end
      else
        states.set(slug, { last: { ...job, code: null, endedAt: statSync(join(this.dir, file), { throwIfNoEntry: false })?.mtimeMs ?? job.startedAt } })
    }

    return states
  }

  /** A stack's job in a few words: "coming up" while one runs, else how the last ended, "up ok 5m ago", "rm failed 2h ago"; empty when it never had one. */
  summary({ running, last }: JobState, now = Date.now()): string {
    if (running !== undefined)
      return doing(this.doing, running)

    if (last === undefined)
      return ''

    return [last.verb, last.service, OUTCOMES[String(last.code)] ?? 'failed', formatAge(last.endedAt ?? last.startedAt, now)].filter(word => word !== undefined).join(' ')
  }

  /** Drops what a stack's jobs left, for a worktree removed for good: one made again under its name starts with no history. */
  forget(stack: Pick<JobStack, 'slug'>): void {
    for (const file of Object.values(this.paths(stack.slug)))
      rmSync(file, { force: true })
  }

  /**
   * Runs `work` under the stack's lock and records how it ended; in the detached process `detach` started, it takes over the claimed job and notifies at the end.
   * Run by a job of this process tree holding the same lock, it runs inside that job, which records the end.
   * A known failure prints its message alone, anything else its stack trace; either way the job ends with code 1.
   */
  async run(stack: JobStack, verb: string, work: (detached: boolean) => Promise<void>, service?: string): Promise<number> {
    if (this.holds(stack))
      return attempt(async () => work(false))

    const detached = process.env[this.env] === stack.slug
    const job = detached ? this.adopt(stack) : this.claim(stack, verb, false, service)
    const before = process.env[HELD_ENV]

    // The commands the job runs are not the job, but they work under its lock
    delete process.env[this.env]
    process.env[HELD_ENV] = [...heldHere(), heldEntry(this.paths(stack.slug).lock)].join('\n')

    let code = 1

    try {
      code = await attempt(async () => work(detached))
    }
    finally {
      if (before === undefined)
        delete process.env[HELD_ENV]
      else
        process.env[HELD_ENV] = before

      this.finish(stack, job, code)
    }

    if (detached)
      await this.notifyEnd(stack, job, code)

    return code
  }

  /**
   * A detached process failing before its job started (its worktree gone, a ref it cannot read) ends the job its parent claimed, and says so, since no terminal shows it.
   * Once `run` runs, it has taken the job over and this does nothing.
   */
  async failDetached(message: string): Promise<void> {
    const slug = process.env[this.env]

    if (slug === undefined || slug === '')
      return

    delete process.env[this.env]

    const job = readJob(this.paths(slug).job)

    if (!job || job.endedAt !== undefined)
      return

    this.finish({ slug }, job, 1)
    await notify(this.app, `${this.what(job)} failed`, message, true)
  }

  /**
   * Runs a command: a known failure (a stack the config does not know, an action refused) ends it with its message instead of a stack trace.
   * `bg` names a `--bg` action, whose refusal is notified as well; a detached run failing before its job started ends that job.
   */
  async guarded(action: () => Promise<number | void>, bg?: string): Promise<number> {
    try {
      return await action() ?? 0
    }
    catch (error) {
      const message = failureText(error)

      await this.failDetached(message)

      if (bg !== undefined)
        await notifyRefused(this.app, bg, message)

      return failKnown(error)
    }
  }

  /** Runs `argv` with bun away from any terminal, in a session of its own that outlives the caller (a Herdr popup that closes), the output in the stack's log. */
  detach(stack: JobStack, verb: string, argv: string[], service?: string): Job {
    const job = this.claim(stack, verb, true, service)
    const out = openSync(job.log, 'w')

    try {
      // Not setsid -f, which busybox and macOS lack
      Bun.spawn([process.execPath, '--no-env-file', ...argv], { stdio: ['ignore', out, out], env: { ...process.env, [this.env]: stack.slug }, detached: true }).unref()
    }
    catch (error) {
      this.finish(stack, job, 1)

      throw error
    }
    finally {
      closeSync(out)
    }

    return job
  }

  /** The command a job ran, as a notification title names it: "proj restart booki php". */
  what(job: Pick<Job, 'verb' | 'ref' | 'service'>): string {
    return [this.app, job.verb, job.ref, ...job.service !== undefined ? [job.service] : []].join(' ')
  }

  /** How a detached job ended, for the user who may have moved on: a failure always, an up, restart of the whole stack or new worktree once done. */
  async notifyEnd(stack: Pick<JobStack, 'ref'>, job: Job, code: number): Promise<void> {
    const done = job.service !== undefined ? undefined : this.done[job.verb]

    if (code === 0) {
      if (done)
        await notify(this.app, `${stack.ref} ${done[0]}`, done[1])

      return
    }

    await notify(this.app, `${this.what(job)} failed`, logTail(job.log) || `see ${job.log}`, true)
  }
}

async function attempt(work: () => Promise<void>): Promise<number> {
  try {
    await work()

    return 0
  }
  catch (error) {
    const message = knownMessage(error)

    console.error(message !== undefined ? `error: ${message}` : error)

    return 1
  }
}
