import type { Piece } from '@kaynooo/cli-kit/shell'
import { parseCommand, resolvePath, splitCommand } from '@kaynooo/cli-kit/shell'

export type Manager = 'bun' | 'pnpm' | 'yarn' | 'npm'
type Action = 'install' | 'frozen' | 'add' | 'remove' | 'update'
type Option = 'dev' | 'exact'

export interface Mismatch { piece: Piece, reason: string, rewrite: string | null }
export interface Pinned { dir: string, managers: ReadonlySet<Manager> }
// A flag before the subcommand (`--filter`, `-w`, `--cwd`) may aim the install elsewhere, so a request carrying one is never rewritten.
interface InstallRequest { piece: Piece, program: Manager, subcommand: string, rest: string[], dir: string, isRewritable: boolean, assignments: string[] }

export const LOCKFILES: readonly [string, Manager][] = [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
]

// The subcommands and aliases that install or rewrite dependencies, per each tool's own help, and what each does; null for one with no counterpart elsewhere. A bare `yarn` installs, hence "".
const ACTIONS: Record<Manager, ReadonlyMap<string, Action | null>> = {
  bun: actions({ install: ['install', 'i'], add: ['add', 'a'], remove: ['remove', 'rm'], update: ['update'] }),
  pnpm: actions({ install: ['install', 'i'], add: ['add'], remove: ['remove', 'rm'], update: ['update', 'up'] }),
  yarn: new Map([...actions({ install: ['', 'install'], add: ['add'], remove: ['remove'], update: ['upgrade'] }), ['upgrade-interactive', null], ['import', null]]),
  npm: actions({
    install: ['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall'],
    add: ['add'],
    frozen: ['ci', 'clean-install', 'ic', 'install-clean', 'isntall-clean'],
    remove: ['uninstall', 'unlink', 'remove', 'rm', 'r', 'un'],
    update: ['update', 'u', 'up', 'upgrade', 'udpate'],
  }),
}

// What each manager runs for an action; a missing one has no faithful translation.
const COMMANDS: Record<Manager, Partial<Record<Action, string>>> = {
  bun: { install: 'install', frozen: 'install --frozen-lockfile', add: 'add', remove: 'remove', update: 'update' },
  pnpm: { install: 'install', frozen: 'install --frozen-lockfile', add: 'add', remove: 'remove', update: 'update' },
  yarn: { install: 'install', add: 'add', remove: 'remove' },
  npm: { install: 'install', frozen: 'ci', add: 'install', remove: 'uninstall', update: 'update' },
}

const OPTIONS: Record<Manager, Record<Option, string>> = {
  bun: { dev: '--dev', exact: '--exact' },
  pnpm: { dev: '--save-dev', exact: '--save-exact' },
  yarn: { dev: '--dev', exact: '--exact' },
  npm: { dev: '--save-dev', exact: '--save-exact' },
}

const OPTION_FLAGS: ReadonlyMap<string, Option> = new Map([
  ['-D', 'dev'],
  ['--save-dev', 'dev'],
  ['--dev', 'dev'],
  ['-E', 'exact'],
  ['--save-exact', 'exact'],
  ['--exact', 'exact'],
])

const DIR_FLAGS = new Set(['--cwd', '-C', '--dir', '--prefix'])
const VALUE_FLAGS = new Set([...DIR_FLAGS, '--filter', '-F'])
const PLAIN_WORD = /^[\w=@./:+-]+$/

function actions(byAction: Partial<Record<Action, readonly string[]>>): Map<string, Action | null> {
  return new Map(Object.entries(byAction).flatMap(([action, names]) => names.map(name => [name, action as Action] as const)))
}

function isManager(program: string): program is Manager {
  return Object.hasOwn(ACTIONS, program)
}

// The same request in the pinned manager's words, or null when a flag or the action has no faithful translation.
export function translate(from: Manager, to: Manager, subcommand: string, rest: readonly string[]): string | null {
  const packages = rest.filter(arg => !arg.startsWith('-'))
  const flags = rest.filter(arg => arg.startsWith('-'))
  const listed = ACTIONS[from].get(subcommand)
  const action = listed === 'install' && packages.length > 0 ? 'add' : listed
  const command = action ? COMMANDS[to][action] : undefined

  if (!action || command === undefined || !packages.every(name => PLAIN_WORD.test(name)))
    return null

  const options: string[] = []

  for (const flag of flags) {
    const option = OPTION_FLAGS.get(flag) ?? (from === 'bun' && flag === '-d' ? 'dev' : undefined)

    if (option === undefined || action !== 'add')
      return null

    options.push(OPTIONS[to][option])
  }

  return [to, command, ...options, ...packages].join(' ')
}

// Each piece of the command that installs or rewrites dependencies, with the directory it runs in.
export function installRequests(command: string, cwd: string, home: string): InstallRequest[] {
  const requests: InstallRequest[] = []

  for (const piece of splitCommand(command)) {
    const { program, args, assignments, isWrapped } = parseCommand(piece.command)

    if (program === 'cd' && args[0] !== undefined) {
      cwd = resolvePath(cwd, args[0], home)

      continue
    }

    if (!isManager(program))
      continue

    let dir = cwd
    let subcommand = ''
    let rest: string[] = []
    let hasLeadingFlag = false

    for (let i = 0; i < args.length; i++) {
      const arg = args[i] ?? ''
      const [flag = '', value] = arg.split('=', 2)

      if (DIR_FLAGS.has(flag) && value !== undefined && value !== '') {
        dir = resolvePath(cwd, value, home)
      }
      else if (VALUE_FLAGS.has(arg)) {
        if (DIR_FLAGS.has(arg) && args[i + 1] !== undefined)
          dir = resolvePath(cwd, args[i + 1] ?? '', home)

        i++
      }
      else if (!arg.startsWith('-')) {
        subcommand = arg
        rest = args.slice(i + 1)

        break
      }

      hasLeadingFlag = true
    }

    if (ACTIONS[program].has(subcommand))
      requests.push({ piece, program, subcommand, rest, dir, assignments, isRewritable: !hasLeadingFlag && !isWrapped && piece.command === piece.text })
  }

  return requests
}

// The request against the managers its directory is pinned to, null when it runs with one of them.
export function mismatchFor(request: InstallRequest, pinned: Pinned | null): Mismatch | null {
  const { piece, program, subcommand, rest, isRewritable, assignments } = request

  if (!pinned || pinned.managers.has(program))
    return null

  const expected = [...pinned.managers]
  const only = expected.length === 1 ? expected[0] : undefined
  const canRewrite = only !== undefined && isRewritable && assignments.every(word => PLAIN_WORD.test(word))
  const translated = canRewrite ? translate(program, only, subcommand, rest) : null
  const leading = piece.text.slice(0, piece.text.length - piece.text.trimStart().length)
  const trailing = piece.text.slice(piece.text.trimEnd().length)

  return {
    piece,
    rewrite: translated === null ? null : `${leading}${[...assignments, translated].join(' ')}${trailing}`,
    reason: `${pinned.dir} is pinned to ${expected.join(' or ')} by its lockfile, so \`${`${program} ${subcommand}`.trim()}\` would install with the wrong package manager.`,
  }
}
