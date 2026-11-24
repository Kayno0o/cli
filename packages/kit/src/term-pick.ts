// A row as term lists it with `--list` in place of the picker's window, in the pane's folder: what tmux_pick types back for Enter and for the picker's other keys.
export interface Listed {
  label: string
  hint: string
  // The words typed after the picker's name to find the same choice again; for a row asking for a text, the ones before it.
  typed: string
  // Set for a row asking for a text first, typed after its words: ctrl-n's new branch.
  asks?: string
  // The picker's arguments printing the row's preview, its `--show`.
  preview?: string[]
  // ctrl-e leaves the picker's name and these words on the prompt rather than the command they run.
  editsTyped?: boolean
  actions?: ListedAction[]
}

export interface ListedAction {
  label: string
  // The name of the key doing it there, `ctrl-d`.
  key: string
  typed?: string
  // The picker run with these arguments, then listed again: ctrl-r's fetch.
  reload?: string[]
}

// A word of the command: fixed, an argument given by the user, or the name of one to prompt for; the last two are what a run is remembered with.
export type Arg = string | { given: string } | { ask: string }

function word(arg: Arg): string {
  if (typeof arg === 'string')
    return `=${arg}`

  return 'given' in arg ? `+${arg.given}` : `?${arg.ask}`
}

// The lines `__pick_run` and tmux_pick read: `run`, or `edit` to leave the command on the prompt; the words typed after the picker's name to find the same choice again; the id the run is called back with once the prompts are answered, or nothing; then one line per word of the command, `=fixed`, `+given` or `?name` to prompt for.
export function emit(mode: 'run' | 'edit', typed: string, recorded: string, command: Arg[]): void {
  const words = command.map(word)

  console.log([mode, typed, recorded, ...words].join('\n'))
}

// What `--list` prints, term reading it back.
export function list(rows: Listed[]): void {
  console.log(JSON.stringify(rows))
}
