import { parseCommand, splitCommand, tokenize } from '@kaynooo/cli-kit'

const SHELL_PROGRAMS = new Set(['ssh', 'scp', 'sftp', 'mosh', 'autossh'])
// `host:path` as rsync spells a remote end, a Windows drive letter and a local path with a colon aside.
const RSYNC_REMOTE = /^(?:[\w.-]+@)?[\w.-]{2,}:/
const SSH_URL = /^ssh:\/\//

export const REMOTE = 'Remote servers are off limits (no SSH, no deploys, no remote commands). Hand the user the exact command to run themselves.'

function isRemote(text: string): boolean {
  const { program, args, assignments } = parseCommand(text)

  if (SHELL_PROGRAMS.has(program))
    return true

  if (program === 'rsync')
    return args.some(arg => !arg.startsWith('-') && RSYNC_REMOTE.test(arg))

  if (assignments.some(assignment => assignment.startsWith('DOCKER_HOST=') && SSH_URL.test(assignment.slice('DOCKER_HOST='.length))))
    return true

  return program === 'docker' && tokenize(text).some(word => SSH_URL.test(word))
}

// Why the command is refused, or null when no piece reaches a remote machine.
export function remoteViolation(command: string): string | null {
  return splitCommand(command).some(piece => isRemote(piece.command)) ? REMOTE : null
}
