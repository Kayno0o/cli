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
end
command wt --completions fish | source
complete -c wt -n __fish_use_subcommand -a cd -d 'go to a worktree, or main'
complete -c wt -n '__fish_seen_subcommand_from cd' -f -a '(command wt tasks) main'`

export function shellWrapper(shell: string | undefined): string {
  if (shell !== 'fish')
    throw new KnownError(`no wrapper for ${shell ?? 'that shell'} yet, only fish`)

  return FISH
}
