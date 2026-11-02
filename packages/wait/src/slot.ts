import type { Held } from './flock'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { currentSession, duration, exitCodeOf, fail, formatAge, formatDuration, holdSignals, jsonOption, liveSessions, parse, printJson, privateLogDirectory, table, truncate, wholeNumber } from '@kaynooo/cli-kit'
import { tryLock, writeHeld } from './flock'

const RUN_USAGE = `slot [options] -- <cmd>...: waits for a free machine-wide slot, then runs the command and exits with its code
slot ls [--json]: lists who holds a slot or a lock and who waits for one (slot ls --help)

The slots and locks are shared by every session, worktree and shell of this user, so heavy jobs (phpunit, playwright, vue-tsc, eslint) queue instead of overloading the machine.
A slot or lock is freed the moment its holder ends, SIGKILL included, since the kernel drops it with the process.
A slotted command that runs slot again does not wait for a second slot, so wrapping both a script and the commands inside it cannot deadlock.
A first word \`ls\` always means the listing, so run the ls command as \`slot -n 4 -- ls\` or by its path.
Exits with the command's code, 2 on a timeout or a usage error.`

const LS_USAGE = `slot ls [options]: lists the slots and locks held, with the session, the command and how long ago it started, then who waits for one

--json prints {slots, busy, entries}, each entry as {state, resource, pid, session, command, cwd, since}.`

const SLOTS = { type: 'string', short: 'n', description: 'how many commands may hold a slot at once (half the CPU count)' } as const

const RUN_OPTIONS = {
  'lock': { type: 'string', short: 'l', multiple: true, description: 'a named lock to hold as well, for what must not run twice at once (booki-test-db)' },
  'no-slot': { type: 'boolean', description: 'take the --lock alone, without a slot' },
  'slots': SLOTS,
  'timeout': { type: 'string', short: 't', description: 'how long to wait before giving up (30s, 5m, 1h, a bare number in seconds), forever by default' },
} as const

const LS_OPTIONS = { slots: SLOTS, json: jsonOption() } as const

const POLL = 250
const COMMAND_WIDTH = 60
const LOCK_NAME = /^\w[\w.-]*$/
const HOLDING = 'SLOT_HOLDING'

type Kind = 'slot' | 'lock'

interface Holder { pid: number, session?: string, command: string, cwd: string, since: number, resource?: string }

interface Entry extends Holder { state: 'holding' | 'waiting', resource: string }

interface Resource { kind: Kind, name: string, count: number }

interface Taken { held: Held, resource: string }

function defaultSlots(): number {
  return Math.max(1, Math.floor(availableParallelism() / 2))
}

// The state is kept in a folder of the user's own, $SLOT_DIR when set (tests, a second queue).
async function stateDir(): Promise<string> {
  const dir = process.env.SLOT_DIR ?? await privateLogDirectory('slot')

  for (const sub of ['slots', 'locks', 'waiters'])
    mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 })

  return dir
}

function readHolder(path: string): Holder | undefined {
  try {
    const holder = JSON.parse(readFileSync(path, 'utf8')) as Partial<Holder>

    return typeof holder.pid === 'number' && typeof holder.command === 'string' ? { pid: holder.pid, command: holder.command, cwd: holder.cwd ?? '', since: holder.since ?? 0, ...holder.session === undefined ? {} : { session: holder.session }, ...holder.resource === undefined ? {} : { resource: holder.resource } } : undefined
  }
  catch {
    return undefined
  }
}

function pathOf(dir: string, kind: Kind, name: string): string {
  return join(dir, kind === 'slot' ? 'slots' : 'locks', name)
}

// The paths whose holders block this resource: every slot file, or the one lock file.
function candidates(dir: string, { kind, name, count }: Resource): { path: string, resource: string }[] {
  if (kind === 'lock')
    return [{ path: pathOf(dir, 'lock', name), resource: `lock ${name}` }]

  return Array.from({ length: count }, (_, index) => ({ path: pathOf(dir, 'slot', String(index)), resource: `slot ${index + 1}` }))
}

function attempt(dir: string, wanted: Resource): Taken | undefined {
  for (const { path, resource } of candidates(dir, wanted)) {
    const held = tryLock(path)

    if (held !== undefined)
      return { held, resource }
  }

  return undefined
}

function who(holder: Holder): string {
  return `${holder.session ?? `pid ${holder.pid}`} running ${truncate(holder.command, COMMAND_WIDTH)} for ${formatDuration(Date.now() - holder.since)}`
}

// The one line printed when a wait starts: who has held what it needs the longest.
function waitingLine(dir: string, wanted: Resource): string {
  const holders = candidates(dir, wanted).map(({ path }) => readHolder(path)).filter(holder => holder !== undefined).sort((a, b) => a.since - b.since)
  const oldest = holders[0]
  const by = oldest === undefined ? 'another process' : who(oldest)

  if (wanted.kind === 'lock')
    return `slot: waiting for lock ${wanted.name}, held by ${by}`

  return `slot: waiting for a slot (${holders.length} of ${wanted.count} busy), the oldest held by ${by}`
}

async function holderOf(command: string[]): Promise<Holder> {
  const session = await currentSession(await liveSessions())

  return { pid: process.pid, command: command.join(' '), cwd: process.cwd(), since: Date.now(), ...session === undefined ? {} : { session: session.name } }
}

let waiterCount = 0

// Waits for the resource, listed in `slot ls` as a waiter meanwhile; the waiter's own lock tells `ls` whether it still lives.
async function acquire(dir: string, wanted: Resource, holder: Holder, deadline: number, timeoutMs: number): Promise<Taken> {
  let waiter: { held: Held, path: string } | undefined

  try {
    for (;;) {
      const taken = attempt(dir, wanted)

      if (taken !== undefined) {
        writeHeld(taken.held, JSON.stringify(holder))

        return taken
      }

      if (waiter === undefined) {
        const path = join(dir, 'waiters', `${process.pid}-${waiterCount++}`)
        const held = tryLock(path)

        if (held !== undefined) {
          writeHeld(held, JSON.stringify({ ...holder, resource: wanted.kind === 'lock' ? `lock ${wanted.name}` : 'slot' }))
          waiter = { held, path }
        }

        console.error(waitingLine(dir, wanted))
      }

      if (Date.now() >= deadline)
        fail(`gave up after ${formatDuration(timeoutMs)} waiting for ${wanted.kind === 'lock' ? `lock ${wanted.name}` : 'a slot'}`)

      await Bun.sleep(POLL)
    }
  }
  finally {
    if (waiter !== undefined) {
      unlinkSync(waiter.path)
      waiter.held.release()
    }
  }
}

export async function runSlotted(args: string[]): Promise<number> {
  // Bun drops a leading `--` before the script sees it, so a first word that is no option starts the command.
  const bare = args[0] !== undefined && !args[0].startsWith('-')
  const parsed = parse(bare ? [] : args, RUN_USAGE, RUN_OPTIONS, { rest: true, replaces: 'flock wrappers, hand-written heavy.sh queues and parallel runs fighting over one test database', examples: [['slot -- bunx vue-tsc', 'wait for a free slot, then type-check'], ['slot --lock booki-test-db -- vendor/bin/phpunit', 'one phpunit at a time on the shared test database'], 'slot ls'] })
  const { values } = parsed
  const rest = bare ? args : parsed.rest

  if (rest === undefined || rest.length === 0)
    fail(`give the command after --\n\n${RUN_USAGE}`)

  const locks = [...new Set(values.lock ?? [])].sort()

  for (const name of locks) {
    if (!LOCK_NAME.test(name))
      fail(`--lock ${name} is no lock name: letters, digits, dots, dashes and underscores`)
  }

  if (values['no-slot'] === true && locks.length === 0)
    fail('--no-slot takes the --lock alone, and none is given')

  const count = wholeNumber(values.slots, 'slots', defaultSlots())
  const timeoutMs = duration(values.timeout, 'timeout', Number.POSITIVE_INFINITY)
  const deadline = Date.now() + timeoutMs
  const holding = new Set((process.env[HOLDING] ?? '').split(',').filter(token => token !== ''))
  // Locks come first and the slot last, so a command never takes a slot while it still waits for a lock.
  const wanted: Resource[] = [...locks.filter(name => !holding.has(`lock:${name}`)).map((name): Resource => ({ kind: 'lock', name, count })), ...values['no-slot'] === true || holding.has('slot') ? [] : [{ kind: 'slot', name: '', count } satisfies Resource]]
  const signals = holdSignals(() => undefined)
  const taken: Taken[] = []

  try {
    if (wanted.length > 0) {
      const dir = await stateDir()
      const holder = await holderOf(rest)

      for (const resource of wanted)
        taken.push(await acquire(dir, resource, holder, deadline, timeoutMs))
    }

    const tokens = new Set([...holding, ...locks.map(name => `lock:${name}`), ...wanted.some(resource => resource.kind === 'slot') ? ['slot'] : []])
    let child: Bun.Subprocess

    try {
      child = Bun.spawn(rest, { stdio: ['inherit', 'inherit', 'inherit'], env: { ...process.env, [HOLDING]: [...tokens].join(',') } })
    }
    catch (error) {
      fail(`cannot run ${rest[0]}: ${error instanceof Error ? error.message : String(error)}`, 127)
    }

    signals.forward(child)
    await child.exited

    return exitCodeOf(child.exitCode, child.signalCode)
  }
  finally {
    signals.release()

    for (const { held } of taken)
      held.release()
  }
}

// Every held lock file under a folder, a free one told apart by being lockable here, which also drops a dead waiter's file.
function scan(dir: string, state: Entry['state'], kind: 'slots' | 'locks' | 'waiters'): Entry[] {
  const folder = join(dir, kind)
  const entries: Entry[] = []

  for (const name of existsSync(folder) ? readdirSync(folder) : []) {
    const path = join(folder, name)
    const probe = tryLock(path)

    if (probe !== undefined) {
      if (kind === 'waiters')
        unlinkSync(path)

      probe.release()

      continue
    }

    const holder = readHolder(path)
    const resource = kind === 'waiters' ? holder?.resource ?? 'slot' : `${kind === 'slots' ? 'slot' : 'lock'} ${kind === 'slots' ? Number(name) + 1 : name}`

    entries.push({ state, resource, pid: holder?.pid ?? 0, command: holder?.command ?? '?', cwd: holder?.cwd ?? '', since: holder?.since ?? 0, ...holder?.session === undefined ? {} : { session: holder.session } })
  }

  return entries
}

export async function listSlots(args: string[]): Promise<number> {
  const { values } = parse(args, LS_USAGE, LS_OPTIONS, { examples: ['slot ls', 'slot ls --json'] })
  const count = wholeNumber(values.slots, 'slots', defaultSlots())
  const dir = await stateDir()
  const holding = [...scan(dir, 'holding', 'slots'), ...scan(dir, 'holding', 'locks')].sort((a, b) => a.since - b.since)
  const waiting = scan(dir, 'waiting', 'waiters').sort((a, b) => a.since - b.since)
  const entries = [...holding, ...waiting]
  const busy = holding.filter(entry => entry.resource.startsWith('slot ')).length

  if (values.json === true) {
    printJson({ slots: count, busy, entries })

    return 0
  }

  console.log(`slots: ${busy} of ${count} busy`)

  if (entries.length > 0)
    console.log(table(entries.map(entry => [entry.state, entry.resource, entry.session ?? `pid ${entry.pid}`, truncate(entry.command, COMMAND_WIDTH), entry.since === 0 ? '?' : formatAge(entry.since)])))

  return 0
}
