import { completionScript } from '@kaynooo/cli-kit'
import { KnownError } from './errors'

// What a child process cannot do for its shell: `wt cd` changes directory, and `wt rm` leaves the folder it just removed for main.
const FISH = `function wt --description 'git worktrees of a compose project, each with its own stack'
  switch "$argv[1]"
    case cd
      set -l dir (command wt path $argv[2..-1]); or return
      builtin cd $dir
    case rm
      set -l main (command wt path 2>/dev/null)
      command wt $argv
      set -l code $status
      test -d $PWD; or builtin cd $main
      return $code
    case '*'
      command wt $argv
  end
end`

// The same function in the syntax bash and zsh share.
const POSIX = `wt() {
  case "$1" in
    cd)
      local dir
      dir=$(command wt path "\${@:2}") || return
      builtin cd "$dir"
      ;;
    rm)
      local main code
      main=$(command wt path 2>/dev/null)
      command wt "$@"
      code=$?
      [ -d "$PWD" ] || builtin cd "$main"
      return $code
      ;;
    *)
      command wt "$@"
      ;;
  esac
}`

const WRAPPERS: Record<string, [wrapper: string, shell: 'fish' | 'bash' | 'zsh']> = { fish: [FISH, 'fish'], bash: [POSIX, 'bash'], zsh: [POSIX, 'zsh'] }

const WRAPPED_SHELLS = Object.keys(WRAPPERS)

/** The wrapper and its completion in one script, which the shell reads at start without running anything. */
export function shellWrapper(shell: string | undefined): string {
  const found = shell === undefined ? undefined : WRAPPERS[shell]

  if (found === undefined)
    throw new KnownError(`no wrapper for ${shell ?? 'that shell'}, only ${WRAPPED_SHELLS.join(', ')}`)

  return `${found[0]}\n${completionScript(found[1], ['wt'], `# Completion, as \`wt --completions ${found[1]}\` prints it`)}`
}
