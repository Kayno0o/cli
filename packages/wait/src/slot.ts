import type { ExitRow } from '@kaynooo/cli-kit'
import type { Held } from './flock'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { badge, configuredNumber, currentSession, duration, exitCodeOf, fail, formatAge, formatDuration, formatElapsed, holdSignals, jsonOption, liveSessions, paint, parse, printJson, privateLogDirectory, table, truncate, wholeNumber } from '@kaynooo/cli-kit'
import { liveRegion } from '@kaynooo/cli-kit/progress'
import { tryLock, writeHeld } from './flock'

const RUN_USAGE = `slot [options] -- <cmd>...: waits in FIFO order for free machine-wide slots, then runs the command and exits with its code
slot ls [--json]: lists who holds a slot or a lock and who waits for one (slot ls --help)

Slots and locks are shared across sessions, worktrees and shells of this user; one is freed the moment its holder ends, SIGKILL included.
A slotted command running slot again does not wait for a second slot, preventing deadlock. Use --weight <k> to reserve k slots at once or --exclusive to hold all slots. Pass \`slot -- ls\` to run the ls command.`

const RUN_EXITS: ExitRow[] = [[0, 'the command did'], ['its own', 'the code of a command that failed'], [2, 'it timed out waiting for the slot or a usage error'], [127, 'the command cannot be started']]

const LS_USAGE = `slot ls [options]: lists the slots and locks held, with the session, the command and how long ago it started, then who waits for one

--json prints {slots, busy, entries}, each entry as {state, resource, pid, session, command, cwd, since}.`

const SLOTS = { type: 'string', short: 'n', description: 'how many commands may hold a slot at once (config.jsonc#slot.slots, else half CPU count)' } as const

const RUN_OPTIONS = {
  'lock': { type: 'string', short: 'l', multiple: true, description: 'a named lock to hold as well, for what must not run twice at once (shop-test-db)' },
  'no-slot': { type: 'boolean', description: 'take the --lock alone, without a slot' },
  'weight': { type: 'string', short: 'w', description: 'how many slots this command reserves at once (1)' },
  'exclusive': { type: 'boolean', short: 'x', description: 'reserve all slots at once (same as --weight <slots>)' },
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

interface Resource { kind: Kind, name: string, count: number, weight: number }

interface Taken { held: Held, resource: string }

function defaultSlots(): number {
  return configuredNumber('slot', 'slots', Math.max(1, Math.floor(availableParallelism() / 2)))
}

async function stateDir(): Promise<string> {
  const dir = process.env.SLOT_DIR ?? await privateLogDirectory('slot')

  for (const sub of ['slots', 'locks', 'waiters'])
    mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 })

  return dir
}

function readHolder(path: string): Holder | undefined {
  try {
    const holder = JSON.parse(readFileSync(path, 'utf8')) as Partial<Holder>

    return typeof holder.pid === 'number' && typeof holder.command === 'string'
      ? { pid: holder.pid, command: holder.command, cwd: holder.cwd ?? '', since: holder.since ?? 0, ...(holder.session === undefined ? {} : { session: holder.session }), ...(holder.resource === undefined ? {} : { resource: holder.resource }) }
      : undefined
  }
  catch {
    return undefined
  }
}

function pathOf(dir: string, kind: Kind, name: string): string {
  return join(dir, kind === 'slot' ? 'slots' : 'locks', name)
}

function candidates(dir: string, { kind, name, count }: Resource): { path: string, resource: string }[] {
  if (kind === 'lock')
    return [{ path: pathOf(dir, 'lock', name), resource: `lock ${name}` }]

  return Array.from({ length: count }, (_, index) => ({ path: pathOf(dir, 'slot', String(index)), resource: `slot ${index + 1}` }))
}

// Acquires `wanted.weight` locks for this resource (all or none).
function attempt(dir: string, wanted: Resource): Taken[] | undefined {
  const taken: Taken[] = []

  for (const { path, resource } of candidates(dir, wanted)) {
    const held = tryLock(path)

    if (held !== undefined) {
      taken.push({ held, resource })

      if (taken.length === wanted.weight)
        return taken
    }
  }

  for (const { held } of taken)
    held.release()

  return undefined
}

function who(holder: Holder): string {
  return `${holder.session ?? `pid ${holder.pid}`} running ${truncate(holder.command, COMMAND_WIDTH)} for ${formatDuration(Date.now() - holder.since)}`
}

function waitingLine(dir: string, wanted: Resource): string {
  const holders = candidates(dir, wanted).map(({ path }) => readHolder(path)).filter(holder => holder !== undefined).sort((a, b) => a.since - b.since)
  const oldest = holders[0]
  const by = oldest === undefined ? 'another process' : who(oldest)

  if (wanted.kind === 'lock')
    return `slot: waiting for lock ${wanted.name}, held by ${by}`

  return `slot: waiting for ${wanted.weight > 1 ? `${wanted.weight} slots` : 'a slot'} (${holders.length} of ${wanted.count} busy), the oldest held by ${by}`
}

async function holderOf(command: string[]): Promise<Holder> {
  const session = await currentSession(await liveSessions())

  return { pid: process.pid, command: command.join(' '), cwd: process.cwd(), since: Date.now(), ...(session === undefined ? {} : { session: session.name }) }
}

let waiterCount = 0

function resourceLabel(wanted: Resource): string {
  return wanted.kind === 'lock' ? `lock ${wanted.name}` : 'slot'
}

// Whether a live waiter with an earlier FIFO ticket is waiting for any resource we want.
function hasOlderWaiter(dir: string, myName: string | undefined, resources: readonly Resource[]): boolean {
  const folder = join(dir, 'waiters')

  if (!existsSync(folder))
    return false

  const wantedLabels = new Set(resources.map(resourceLabel))

  for (const name of readdirSync(folder).sort()) {
    if (myName !== undefined && name >= myName)
      break

    const path = join(folder, name)
    const probe = tryLock(path)

    if (probe !== undefined) {
      rmSync(path, { force: true })
      probe.release()

      continue
    }

    const holder = readHolder(path)

    if (holder === undefined || holder.resource === undefined || wantedLabels.has(holder.resource))
      return true
  }

  return false
}

// Takes every wanted resource in FIFO order, or none, showing a live TTY spinner while waiting.
async function acquire(dir: string, resources: Resource[], holder: Holder, deadline: number, timeoutMs: number): Promise<Taken[]> {
  let waiter: { held: Held, path: string, name: string, resource: string } | undefined
  let region: ReturnType<typeof liveRegion> | undefined
  let currentBusy: Resource = resources[0]!
  const started = Date.now()
  const { dim } = paint(process.stderr)

  try {
    for (;;) {
      const blockedByQueue = hasOlderWaiter(dir, waiter?.name, resources)
      const taken: Taken[] = []
      let busy: Resource | undefined = blockedByQueue ? resources[0] : undefined

      if (!blockedByQueue) {
        for (const wanted of resources) {
          const got = attempt(dir, wanted)

          if (got === undefined) {
            busy = wanted

            break
          }

          taken.push(...got)
        }
      }

      if (busy === undefined) {
        for (const { held } of taken)
          writeHeld(held, JSON.stringify(holder))

        return taken
      }

      for (const { held } of taken)
        held.release()

      currentBusy = busy

      const resource = resourceLabel(busy)

      if (waiter === undefined) {
        const name = `${String(Date.now()).padStart(15, '0')}-${String(process.pid).padStart(8, '0')}-${waiterCount++}`
        const path = join(dir, 'waiters', name)
        const held = tryLock(path)

        if (held !== undefined) {
          writeHeld(held, JSON.stringify({ ...holder, resource }))
          waiter = { held, path, name, resource }
        }

        if (process.stderr.isTTY)
          region = liveRegion(spinner => [`${spinner} ${waitingLine(dir, currentBusy)} ${dim(formatElapsed(Date.now() - started))}`])
        else
          console.error(waitingLine(dir, busy))
      }
      else if (waiter.resource !== resource) {
        writeHeld(waiter.held, JSON.stringify({ ...holder, resource }))
        waiter.resource = resource
      }

      if (Date.now() >= deadline)
        fail(`gave up after ${formatDuration(timeoutMs)} waiting for ${busy.kind === 'lock' ? `lock ${busy.name}` : 'a slot'}`)

      await Bun.sleep(POLL)
    }
  }
  finally {
    region?.stop()

    if (waiter !== undefined) {
      rmSync(waiter.path, { force: true })
      waiter.held.release()
    }
  }
}

function withSeparator(args: string[]): string[] {
  const takesValue = (word: string) => Object.entries(RUN_OPTIONS).some(([name, option]) => option.type === 'string' && (word === `--${name}` || ('short' in option && word === `-${option.short}`)))

  for (let at = 0; at < args.length; at++) {
    const word = args[at]!

    if (word === '--')
      return args

    if (!word.startsWith('-'))
      return [...args.slice(0, at), '--', ...args.slice(at)]

    if (takesValue(word))
      at++
  }

  return args
}

export async function runSlotted(given: string[]): Promise<number> {
  const args = withSeparator(given)
  const parsed = parse(args, RUN_USAGE, RUN_OPTIONS, { rest: true, exits: RUN_EXITS, replaces: 'flock wrappers, hand-written heavy.sh queues and parallel runs fighting over one test database', examples: [['slot -- bunx vue-tsc', 'wait for a free slot, then type-check'], ['slot --lock shop-test-db -- vendor/bin/phpunit', 'one phpunit at a time on the shared test database'], ['slot -w 2 -- bun test', 'reserve 2 slots for a heavy test run'], 'slot ls'] })
  const { values, rest } = parsed

  if (rest === undefined || rest.length === 0)
    fail(`give the command after --\n\n${RUN_USAGE}`)

  const locks = [...new Set(values.lock ?? [])].sort()

  for (const name of locks) {
    if (!LOCK_NAME.test(name))
      fail(`--lock ${name} is no lock name: letters, digits, dots, dashes and underscores`)
  }

  if (values['no-slot'] === true && locks.length === 0)
    fail('--no-slot takes the --lock alone, and none is given')

  if (values['no-slot'] === true && (values.weight !== undefined || values.exclusive === true))
    fail('--weight and --exclusive cannot be used with --no-slot')

  if (values.weight !== undefined && values.exclusive === true)
    fail('give either --weight or --exclusive, not both')

  const count = wholeNumber(values.slots, 'slots', defaultSlots())
  const weight = values.exclusive === true ? count : wholeNumber(values.weight, 'weight', 1, 1)

  if (weight > count)
    fail(`--weight ${weight} exceeds total slots (${count})`)

  const timeoutMs = duration(values.timeout, 'timeout', Number.POSITIVE_INFINITY)
  const deadline = Date.now() + timeoutMs
  const holding = new Set((process.env[HOLDING] ?? '').split(',').filter(token => token !== ''))
  const wanted: Resource[] = [
    ...locks.filter(name => !holding.has(`lock:${name}`)).map((name): Resource => ({ kind: 'lock', name, count, weight: 1 })),
    ...(values['no-slot'] === true || holding.has('slot') ? [] : [{ kind: 'slot', name: '', count, weight } satisfies Resource]),
  ]
  const signals = holdSignals(() => undefined)
  const taken: Taken[] = []

  try {
    if (wanted.length > 0) {
      const dir = await stateDir()
      const holder = await holderOf(rest)

      taken.push(...await acquire(dir, wanted, holder, deadline, timeoutMs))
    }

    const tokens = new Set([...holding, ...locks.map(name => `lock:${name}`), ...(wanted.some(resource => resource.kind === 'slot') ? ['slot'] : [])])
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

function scan(dir: string, state: Entry['state'], kind: 'slots' | 'locks' | 'waiters'): Entry[] {
  const folder = join(dir, kind)
  const entries: Entry[] = []

  for (const name of existsSync(folder) ? readdirSync(folder) : []) {
    const path = join(folder, name)
    const probe = tryLock(path)

    if (probe !== undefined) {
      if (kind === 'waiters')
        rmSync(path, { force: true })

      probe.release()

      continue
    }

    const holder = readHolder(path)
    const resource = kind === 'waiters' ? holder?.resource ?? 'slot' : `${kind === 'slots' ? 'slot' : 'lock'} ${kind === 'slots' ? Number(name) + 1 : name}`

    entries.push({ state, resource, pid: holder?.pid ?? 0, command: holder?.command ?? '?', cwd: holder?.cwd ?? '', since: holder?.since ?? 0, ...(holder?.session === undefined ? {} : { session: holder.session }) })
  }

  return entries
}

export async function listSlots(args: string[]): Promise<number> {
  const { values } = parse(args, LS_USAGE, LS_OPTIONS, { exits: [[0, 'it listed them'], [2, 'a usage error']], examples: ['slot ls', 'slot ls --json'] })
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

  console.log(paint(process.stdout).bold(`slots: ${busy} of ${count} busy`))

  if (entries.length > 0)
    console.log(table(entries.map(entry => [badge(entry.state, process.stdout), entry.resource, entry.session ?? `pid ${entry.pid}`, truncate(entry.command, COMMAND_WIDTH), entry.since === 0 ? '?' : formatAge(entry.since)])))

  return 0
}
