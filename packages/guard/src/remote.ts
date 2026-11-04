import { parseCommand, splitCommand, tokenize } from '@kaynooo/cli-kit/shell'
import { subcommandOf } from './git'

const SHELL_PROGRAMS = new Set(['ssh', 'scp', 'sftp', 'mosh', 'mosh-client', 'autossh'])
// Programs opening a socket to whatever host they are given.
const SOCKET_PROGRAMS = new Set(['nc', 'ncat', 'netcat', 'telnet', 'socat'])
// Programs whose ssh:// URL, or whose option, points them at a remote machine.
const URL_PROGRAMS = new Set(['git', 'docker', 'docker-compose'])
const DECLARERS = new Set(['export', 'declare', 'typeset'])
// `host:path` as rsync spells a remote end, a Windows drive letter and a local path with a colon aside.
const RSYNC_REMOTE = /^(?:[\w.-]+@)?[\w.-]{2,}:/
// git's scp-style address: a colon before any slash, outside a URL.
const SCP_ADDRESS = /^[^/:\s-][^/:\s]*:(?!\/\/)/
// The same with a user or a dotted host, which tells it from a `branch:branch` refspec.
const SCP_HOST_ADDRESS = /^(?:[\w.-]+@[\w.-]+|[\w-]+(?:\.[\w-]+)+):(?!\/\/)/
const GIT_TRANSPORTS = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote'])
// The transport commands' own options taking the next word as their value.
const TRANSPORT_VALUE_OPTIONS = new Set(['--depth', '-b', '--branch', '-o', '--origin', '--push-option', '-c', '--config', '--reference', '--separate-git-dir', '--template', '-j', '--jobs', '--filter', '--shallow-since', '--shallow-exclude', '-u', '--upload-pack', '--receive-pack', '--exec', '--server-option', '--repo', '--deepen'])
const SSH_URL = /^ssh:\/\//
const SSH_URL_WORD = /^(?:[\w-]+=)?ssh:\/\//
const LOOPBACK = /(?:^|[:=@[])(?:localhost|127(?:\.\d+){3}|::1)(?:[:\]/]|$)/
const LISTENS = /^-[A-KM-Z]*L[A-Z]*$/i
// docker's own options taking a value, before the subcommand.
const DOCKER_VALUE_OPTIONS = new Set(['-c', '--context', '-H', '--host', '-l', '--log-level', '--config', '--tlscacert', '--tlscert', '--tlskey'])
const CONTEXT_CHANGES = new Set(['use', 'create', 'update', 'import'])
const KUBECTL_SERVER = /^(?:--server(?:=|$)|-s$)/
// Variables naming the program git connects with.
const REMOTE_VARIABLE = /^GIT_SSH(?:_COMMAND)?=/

export const REMOTE = 'Remote servers are off limits (no SSH, no deploys, no remote commands). Hand the user the exact command to run themselves.'

// The docker context a command selects, and its subcommand, past the options taking a value.
function dockerContext(args: readonly string[]): { context: string | null, name: string, rest: string[] } {
  let context: string | null = null

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''

    if (arg.startsWith('--context='))
      context = arg.slice('--context='.length)
    else if (arg === '-c' || arg === '--context')
      context = args[++i] ?? null
    else if (DOCKER_VALUE_OPTIONS.has(arg))
      i++
    else if (!arg.startsWith('-'))
      return { context, name: arg, rest: args.slice(i + 1) }
  }

  return { context, name: '', rest: [] }
}

function isDockerRemote(args: readonly string[], assignments: readonly string[]): boolean {
  const { context, name, rest } = dockerContext(args)
  const fromEnv = assignments.find(assignment => assignment.startsWith('DOCKER_CONTEXT='))?.slice('DOCKER_CONTEXT='.length)

  if ([context, fromEnv].some(each => each !== null && each !== undefined && each !== 'default'))
    return true

  return name === 'context' && CONTEXT_CHANGES.has(rest[0] ?? '')
}

// Whether a socket program points at a machine other than this one; listening, or a loopback host, stays local.
function isSocketRemote(args: readonly string[]): boolean {
  return !args.some(arg => LISTENS.test(arg) || LOOPBACK.test(arg))
}

// The first word that is no option nor an option's value, the repository of a transport command.
function firstOperand(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''

    if (TRANSPORT_VALUE_OPTIONS.has(arg))
      i++
    else if (!arg.startsWith('-'))
      return arg
  }

  return undefined
}

// Whether a git command names a repository in scp style (`user@host:path`), which git reaches over ssh.
function isScpAddress(args: readonly string[]): boolean {
  const { name, rest } = subcommandOf(args)

  if (!GIT_TRANSPORTS.has(name))
    return false

  const address = name === 'clone' || name === 'ls-remote' ? SCP_ADDRESS : SCP_HOST_ADDRESS
  const repository = firstOperand(rest)

  return repository !== undefined && address.test(repository)
}

function isRemote(text: string): boolean {
  const { program, args, assignments } = parseCommand(text)
  const declared = DECLARERS.has(program) ? args : []

  if (SHELL_PROGRAMS.has(program))
    return true

  if (SOCKET_PROGRAMS.has(program))
    return isSocketRemote(args)

  if (program === 'rsync')
    return args.some(arg => !arg.startsWith('-') && RSYNC_REMOTE.test(arg))

  if (program === 'git' && isScpAddress(args))
    return true

  if (program === 'kubectl')
    return args.some(arg => KUBECTL_SERVER.test(arg))

  if ([...assignments, ...declared].some(assignment => REMOTE_VARIABLE.test(assignment)))
    return true

  if ([...assignments, ...declared].some(assignment => assignment.startsWith('DOCKER_HOST=') && SSH_URL.test(assignment.slice('DOCKER_HOST='.length))))
    return true

  if (program === 'docker' && isDockerRemote(args, assignments))
    return true

  return URL_PROGRAMS.has(program) && tokenize(text).some(word => SSH_URL_WORD.test(word))
}

// Why the command is refused, or null when no piece reaches a remote machine.
export function remoteViolation(command: string): string | null {
  return splitCommand(command).some(piece => isRemote(piece.command)) ? REMOTE : null
}
