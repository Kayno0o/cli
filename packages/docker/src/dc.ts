import type { Labels, Stack } from './stack'
import process from 'node:process'
import { isInteractive, paint } from '@kaynooo/cli-kit'
import { nearestStack, recordedNearby, stackAt, stackOf } from './stack'

// The words a compose command starts with, which never name a stack, so the containers are not listed to check.
const COMMANDS = new Set(['alpha', 'attach', 'bridge', 'build', 'commit', 'config', 'cp', 'create', 'down', 'events', 'exec', 'export', 'help', 'images', 'kill', 'logs', 'ls', 'pause', 'port', 'ps', 'publish', 'pull', 'push', 'restart', 'rm', 'run', 'scale', 'start', 'stats', 'stop', 'top', 'unpause', 'up', 'version', 'volumes', 'wait', 'watch'])

export type Target
  = | { kind: 'stack', stack: Stack, args: string[], announce: boolean }
    | { kind: 'choose', recorded: Labels[], args: string[] }

// Which stack `dc <args>` runs on: one named by a first word, the nearest compose file, or the only one with containers here.
export async function target(args: string[]): Promise<Target> {
  const [first = '', ...rest] = args
  const recorded = first.startsWith('-') || COMMANDS.has(first) ? undefined : await recordedNearby()
  const chosen = recorded?.find(stack => stack.project === first)

  if (chosen)
    return { kind: 'stack', stack: stackOf(chosen), args: rest, announce: true }

  const nearest = nearestStack('.')

  if (nearest)
    return { kind: 'stack', stack: nearest, args, announce: false }

  const withContainers = recorded ?? await recordedNearby()

  if (withContainers.length === 1)
    return { kind: 'stack', stack: stackOf(withContainers[0]!), args, announce: true }

  if (withContainers.length > 1)
    return { kind: 'choose', recorded: withContainers, args }

  return { kind: 'stack', stack: stackAt('.'), args, announce: false }
}

// The project picked with `pick` when it is installed, which draws on stderr and prints the choice.
async function choose(recorded: Labels[]): Promise<Labels | undefined> {
  const picker = Bun.which('pick')

  if (picker === null || !isInteractive())
    return undefined

  const proc = Bun.spawn([picker, '--prompt', 'dc> '], { stdin: new Blob([recorded.map(stack => stack.project).join('\n')]), stdout: 'pipe', stderr: 'inherit' })
  const picked = (await new Response(proc.stdout).text()).trim()

  return recorded.find(stack => stack.project === picked)
}

async function run(stack: Stack, args: string[], announce: boolean): Promise<number> {
  // The command it stands for, above its output, since nothing in `dc` says which files it took.
  if (announce && process.stderr.isTTY)
    console.error(paint(process.stderr).dim([...stack.run, ...args].join(' ')))

  return Bun.spawn([...stack.list.argv, ...args], { cwd: stack.list.cwd, env: stack.list.env, stdio: ['inherit', 'inherit', 'inherit'] }).exited
}

// docker compose on the stack found here, with what it came up with when only its containers tell of it.
export async function dc(args: string[]): Promise<number> {
  const found = await target(args)

  if (found.kind === 'stack')
    return run(found.stack, found.args, found.announce)

  const recorded = await choose(found.recorded)

  if (!recorded) {
    console.error(`several stacks here, name one first: ${found.recorded.map(stack => stack.project).join(', ')}`)

    return 1
  }

  return run(stackOf(recorded), found.args, true)
}
