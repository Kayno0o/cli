import type { Manager, Mismatch, Pinned } from '@kaynooo/pkg-tools/src/pin.ts'
import { parentDir, replacePieces, substitutions } from '@kaynooo/cli-kit/shell'
import { sqlViolation } from '@kaynooo/db-tools/src/clients.ts'
import { isEnvFile, touchesEnv, USE_EV } from '@kaynooo/env-tools/guard'
import { commitMessageViolation, TRAILERS, USE_GC } from '@kaynooo/git-tools/message'
import { shouldWrap, wrap } from '@kaynooo/out-tools/src/wrap.ts'
import { addedPackages } from '@kaynooo/pkg-tools/src/added.ts'
import { installRequests, LOCKFILES, mismatchFor } from '@kaynooo/pkg-tools/src/pin.ts'
import { commitSources, inlineMessage } from './commit'
import { gitViolation } from './git'
import { remoteViolation } from './remote'

// What the rules may learn of the machine the command runs on.
export interface Context {
  cwd: string
  home: string
  // Whether the user's latest prompt asked for a push.
  isPushAsked: boolean
  // Whether the caller runs the command the verdict returns, so a mapped install is rewritten rather than refused.
  canRewrite: boolean
  // Whether `out` is installed, so a noisy command runs through it.
  canWrap: boolean
  // A file's text, null when it cannot be read.
  read: (path: string) => string | null
  exists: (path: string) => boolean
}

export interface Violation { rule: string, message: string }

export interface Verdict {
  violations: Violation[]
  // The command to run in its place, the one given when no rule rewrites it.
  command: string
  // What a rewrite changed, for the session to learn.
  notes: string[]
  // The registry packages the command adds, for `pkg` to check first.
  packages: string[]
}

function absolute(path: string, cwd: string): string {
  return path.startsWith('/') ? path : `${cwd}/${path}`
}

// Why a commit in the command breaks the commit format, null when none does or its message is unknown.
function commitViolation(command: string, { cwd, read }: Context): string | null {
  for (const source of commitSources(command)) {
    if (source.hasTrailerFlag)
      return TRAILERS

    // a device such as /dev/stdin would block the read
    if (source.isReused || source.file?.startsWith('/dev/') === true)
      continue

    const { file } = source
    let message = source.stdin

    if (file === null)
      message = inlineMessage(source.parts)
    else if (file !== '-')
      message = read(absolute(file, cwd))

    const violation = message === null ? null : commitMessageViolation(message)

    if (violation !== null)
      return violation
  }

  return null
}

// The nearest directory holding a lockfile decides; two lockfiles side by side allow both managers.
function pinnedManagers(start: string, exists: Context['exists']): Pinned | null {
  for (let dir = start; ; dir = parentDir(dir)) {
    const managers = new Set<Manager>(LOCKFILES.filter(([file]) => exists(`${dir}/${file}`)).map(([, manager]) => manager))

    if (managers.size > 0)
      return { dir, managers }

    if (dir === '/')
      return null
  }
}

// The command and each one it runs through a substitution, nested ones included.
function commandsRun(command: string): string[] {
  return [command, ...substitutions(command).flatMap(commandsRun)]
}

function mismatches(command: string, { cwd, home, exists }: Context): Mismatch[] {
  return installRequests(command, cwd, home).flatMap((request) => {
    const mismatch = mismatchFor(request, pinnedManagers(request.dir, exists))

    return mismatch === null ? [] : [mismatch]
  })
}

// Every rule the command breaks, each message naming the route, and the command as it should run when a rule rewrites it instead.
export async function checkCommand(command: string, context: Context): Promise<Verdict> {
  const violations: Violation[] = []
  const notes: string[] = []
  const add = (rule: string, message: string | null) => {
    if (message !== null)
      violations.push({ rule, message })
  }

  const run = commandsRun(command)
  const first = (messages: (string | null)[]) => messages.find(message => message !== null) ?? null

  add('remote', first(run.map(remoteViolation)))
  add('git', first(run.map(each => gitViolation(each, context.isPushAsked))))
  const commit = commitViolation(command, context)

  add('commit', commit === null ? null : `${commit} ${USE_GC}`)
  add('sql', first(await Promise.all(run.map(async each => sqlViolation(each, async path => Promise.resolve(context.read(absolute(path, context.cwd))))))))
  add('env', touchesEnv(command) ? USE_EV : null)

  const found = mismatches(command, context)
  const refused = found.find(mismatch => mismatch.rewrite === null || !context.canRewrite)
  const rewrite = refused?.rewrite ?? null
  const route = rewrite === null ? 'Run it with the pinned manager instead.' : `Run \`${rewrite.trim()}\` instead.`

  add('package-manager', refused === undefined ? null : `${refused.reason} ${route}`)

  let rewritten = command

  if (refused === undefined && found.length > 0) {
    rewritten = replacePieces(command, new Map(found.map(mismatch => [mismatch.piece, mismatch.rewrite ?? ''])))
    notes.push(...found.map(mismatch => `${mismatch.reason} It ran as \`${mismatch.rewrite?.trim()}\` instead.`))
  }

  if (context.canRewrite && context.canWrap && shouldWrap(rewritten))
    rewritten = wrap(rewritten)

  return { violations, command: violations.length > 0 ? command : rewritten, notes: violations.length > 0 ? [] : notes, packages: addedPackages(command) }
}

// Why a file tool may not open the path, null when it may.
export function checkPath(path: string): Violation | null {
  return isEnvFile(path) ? { rule: 'env', message: USE_EV } : null
}
