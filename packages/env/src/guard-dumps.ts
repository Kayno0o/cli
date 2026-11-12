import { basename } from 'node:path'
import { splitCommand, tokenize } from '@kaynooo/cli-kit/shell'

const OPENER = /^[({]+/
const DUMP_FLAGS = /^-[a-z]*[px]/
// Git commands whose output carries the content of tracked files.
const GIT_PATCHES = new Set(['diff', 'log', 'show', 'whatchanged', 'format-patch', 'grep'])
const GIT_NO_PATCH = new Set(['--stat', '--numstat', '--shortstat', '--name-only', '--name-status', '--summary', '-s', '--no-patch', '--check', '--quiet'])
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--attr-source'])
const GIT_PATCH_FLAGS = new Set(['-p', '-u', '--patch', '-c', '--cc', '--patch-with-stat', '--patch-with-raw'])

export const GIT_EXCLUDE = /^:(?:!|\^|\(exclude\))/
// Programs printing a process's whole environment.
const ENV_PRINTERS = new Set(['env', 'printenv'])
const DOCKER = new Set(['docker', 'docker-compose'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'ash'])
// `-c`, and `-lc`, `-ic` or `-ce` where the short flags are combined.
const SHELL_COMMAND_FLAG = /^-[abd-z]*c[a-z]*$/
// Options taking a value, before a docker or compose subcommand, and before exec's container.
const DOCKER_VALUE_OPTIONS = new Set(['-f', '--file', '-p', '--project-name', '--profile', '--env-file', '--project-directory', '--ansi', '--progress', '--parallel', '-H', '--host', '-c', '--context', '--config', '-l', '--log-level'])
const EXEC_VALUE_OPTIONS = new Set(['-e', '--env', '--env-file', '-u', '--user', '-w', '--workdir', '--index', '--detach-keys'])
// Options taking a value before the image of `docker run` or the service of `compose run`.
const RUN_VALUE_OPTIONS = new Set([...EXEC_VALUE_OPTIONS, '-a', '--attach', '--add-host', '--annotation', '--blkio-weight', '--cap-add', '--cap-drop', '--cgroup-parent', '--cgroupns', '--cidfile', '-c', '--cpu-shares', '--cpus', '--cpuset-cpus', '--cpuset-mems', '--cpu-period', '--cpu-quota', '--device', '--dns', '--dns-option', '--dns-search', '--domainname', '--entrypoint', '--env-from-file', '--expose', '--gpus', '--group-add', '--health-cmd', '--health-interval', '--health-retries', '--health-start-period', '--health-timeout', '-h', '--hostname', '--ip', '--ip6', '--ipc', '--isolation', '-l', '--label', '--label-file', '--link', '--log-driver', '--log-opt', '--mac-address', '-m', '--memory', '--memory-reservation', '--memory-swap', '--mount', '--name', '--network', '--net', '--network-alias', '--pid', '--pids-limit', '--platform', '-p', '--publish', '--pull', '--restart', '--runtime', '--security-opt', '--shm-size', '--stop-signal', '--stop-timeout', '--storage-opt', '--sysctl', '--tmpfs', '--ulimit', '--userns', '--uts', '-v', '--volume', '--volumes-from'])
// `compose config` options printing names, never values.
const CONFIG_LISTS = new Set(['--services', '--volumes', '--profiles', '--images', '--networks', '--hash', '-q', '--quiet'])
const FORMAT_OPTIONS = new Set(['-f', '--format'])
// An inspect format still printing the environment, or everything.
const WHOLE_FORMAT = /Env|\{\{\s*json\s+\.\s*\}\}|^json$/

// The index of the first word that is no option, past the values the options given take.
function firstOperand(words: readonly string[], valueOptions: ReadonlySet<string>): number {
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? ''

    if (valueOptions.has(word))
      i++
    else if (!word.startsWith('-'))
      return i
  }

  return words.length
}

// Whether a program, by path or by name, prints the whole environment.
function isEnvPrinter(program: string): boolean {
  return ENV_PRINTERS.has(basename(program))
}

// The command a container runs prints its environment: `env` or `printenv` as the program, or as one run by `sh -c`.
function printsEnv([program = '', ...args]: readonly string[]): boolean {
  const flags = args.findIndex(arg => !arg.startsWith('-') || SHELL_COMMAND_FLAG.test(arg))

  if (SHELLS.has(basename(program)) && SHELL_COMMAND_FLAG.test(args[flags] ?? ''))
    return splitCommand(args[flags + 1] ?? '').some(piece => isEnvPrinter(tokenize(piece.command)[0] ?? ''))

  return isEnvPrinter(program)
}

// `docker run` and `compose run` print the environment when the command after the image or service, or the entrypoint, is a dump.
function runPrintsEnv(after: readonly string[]): boolean {
  const entrypoint = after.find((_, i) => after[i - 1] === '--entrypoint') ?? after.find(word => word.startsWith('--entrypoint='))?.slice('--entrypoint='.length)

  return (entrypoint !== undefined && isEnvPrinter(entrypoint)) || printsEnv(after.slice(firstOperand(after, RUN_VALUE_OPTIONS) + 1))
}

// A docker call printing a container's environment: `env` or `printenv` run through exec or run, `compose config` and `inspect`, which spell it out.
export function dumpsContainerEnv(program: string, args: string[]): boolean {
  if (!DOCKER.has(program))
    return false

  const afterOptions = (words: readonly string[]) => words.slice(firstOperand(words, DOCKER_VALUE_OPTIONS))
  let rest = afterOptions(args)
  const isCompose = program === 'docker-compose' || rest[0] === 'compose'

  if (program === 'docker' && isCompose)
    rest = afterOptions(rest.slice(1))

  // `docker container exec` and `docker container run` are exec and run.
  const [subcommand = '', ...after] = !isCompose && rest[0] === 'container' && ['exec', 'run'].includes(rest[1] ?? '') ? rest.slice(1) : rest

  if (subcommand === 'exec')
    return printsEnv(after.slice(firstOperand(after, EXEC_VALUE_OPTIONS) + 1))

  if (subcommand === 'run')
    return runPrintsEnv(after)

  if (isCompose)
    return subcommand === 'config' && !after.some(word => CONFIG_LISTS.has(word))

  if (subcommand !== 'inspect' && (subcommand !== 'container' || after[0] !== 'inspect'))
    return false

  const format = after.find((_, i) => FORMAT_OPTIONS.has(after[i - 1] ?? '')) ?? after.find(word => word.startsWith('--format='))?.slice('--format='.length)

  return format === undefined || WHOLE_FORMAT.test(format)
}

// Programs printing the environment of the shell they run in: `env` and `printenv` alone, `export -p`, `declare -x`, a bare `set`.
export function dumpsEnvironment(program: string, args: readonly string[], tokens: readonly string[]): boolean {
  const isBare = args.every(arg => arg.startsWith('-'))

  if (program === 'printenv' || program === 'export')
    return isBare

  if (program === 'declare' || program === 'typeset')
    return isBare && args.some(arg => DUMP_FLAGS.test(arg))

  if (program === 'set')
    return args.length === 0

  return program === '' && tokens.some(token => basename(token.replace(OPENER, '')) === 'env')
}

// Whether a git command prints the content of a tracked env file: a patch or a search with no pathspec leaving env files out.
export function printsTrackedEnv(program: string, args: readonly string[]): boolean {
  if (program !== 'git')
    return false

  const at = args.findIndex((arg, i) => !arg.startsWith('-') && !GIT_VALUE_OPTIONS.has(args[i - 1] ?? ''))
  const name = args[at] ?? ''
  const rest = args.slice(at + 1)

  if (!GIT_PATCHES.has(name) || rest.some(arg => GIT_EXCLUDE.test(arg)))
    return false

  if (name === 'grep')
    return true

  if (name === 'log' || name === 'whatchanged')
    return rest.some(arg => GIT_PATCH_FLAGS.has(arg))

  return !rest.some(arg => GIT_NO_PATCH.has(arg))
}
