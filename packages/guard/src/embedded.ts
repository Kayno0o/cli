import { parseCommand, SHELLS, splitCommand } from '@kaynooo/cli-kit/shell'

const PRINTERS = new Set(['echo', 'printf'])
const ECHO_FLAGS = /^-[neE]+$/
const SHELL_STRING_FLAG = /^-[ABD-Z]*C[A-Z]*$/i
const PRINTF_SPEC = /%[sb]/g
const ESCAPE = /\\(.)/gs
const VERSION_SUFFIX = /[\d.]+$/
// The flags after which an interpreter takes its code from the next word.
const CODE_FLAGS = new Map([['python', ['-c']], ['perl', ['-e', '-E']], ['ruby', ['-e']], ['node', ['-e', '--eval', '-p', '--print']], ['bun', ['-e', '--eval', '-p', '--print']]])
const BACKTICK = String.fromCharCode(96)
const QUOTED = String.raw`'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|${BACKTICK}(?:[^${BACKTICK}\\]|\\.)*${BACKTICK}`
// A bracketed or parenthesised list of at least two string literals, the argv of a spawn.
const ARGV = new RegExp(String.raw`[[(]\s*((?:(?:${QUOTED})\s*,\s*)+(?:${QUOTED}))\s*(?:,\s*)?[\])]`, 'gs')
const LITERAL = new RegExp(QUOTED, 'gs')
// What precedes a literal that is run as a command line: a call that spawns a shell, or the tag of Bun's `$` template.
const RUNS_SHELL = /(?:\b(?:system|exec\w*|spawn\w*|popen|run|call|check_\w+|Popen|getoutput|qx)|\$)\s*(?:\(\s*)?$/
const SHELL_BACKTICKS = new Set(['perl', 'ruby'])

const ESCAPED = new Map([['n', '\n'], ['t', ' ']])

function decode(text: string): string {
  return text.replaceAll(ESCAPE, (_, char: string) => ESCAPED.get(char) ?? char)
}

function literalValue(literal: string): string {
  return decode(literal.slice(1, -1))
}

// What `printf` prints for its format and values: each `%s` or `%b` takes a value, and the format repeats while values remain.
function printfText(args: readonly string[]): string {
  const [format = '', ...values] = args
  const specs = format.match(PRINTF_SPEC)?.length ?? 0

  if (specs === 0)
    return decode(format)

  let text = ''

  for (let rest = values; ; rest = rest.slice(specs)) {
    let index = 0

    text += format.replaceAll(PRINTF_SPEC, () => rest[index++] ?? '')

    if (rest.length <= specs)
      return decode(text)
  }
}

// What an `echo` or `printf` stage prints, null for any other stage.
function printed(command: string): string | null {
  const { program, args } = parseCommand(command)

  if (!PRINTERS.has(program))
    return null

  if (program === 'printf')
    return printfText(args[0] === '--' ? args.slice(1) : args)

  return args.filter((arg, index) => !(ECHO_FLAGS.test(arg) && args.slice(0, index).every(before => ECHO_FLAGS.test(before)))).join(' ')
}

// Whether the shell reads its script from stdin: no script operand, or `-s` or `-` asked for it.
function readsStdin(args: readonly string[]): boolean {
  if (args.some(arg => SHELL_STRING_FLAG.test(arg)))
    return false

  return args.includes('-s') || args.includes('-') || args.every(arg => arg.startsWith('-'))
}

// The command lines an `echo` or `printf` feeds a shell reading its script from stdin, which the shell parser leaves out when the shell has `-s` or `-`.
export function fedCommands(command: string): string[] {
  const pieces = splitCommand(command)

  return pieces.flatMap((piece, index) => {
    const before = pieces[index - 1]
    const { program, args } = parseCommand(piece.command)

    if (!SHELLS.has(program) || before?.separator !== '|' || !readsStdin(args))
      return []

    const text = printed(before.command)

    return text === null ? [] : text.split('\n').filter(line => line.trim() !== '')
  })
}

// The commands an interpreter's inline code runs: string and template literals read as command lines, and lists of literals as the words of a command.
export function scriptedCommands(command: string): string[] {
  return splitCommand(command).flatMap((piece) => {
    const { program, args } = parseCommand(piece.command)
    const language = program.replace(VERSION_SUFFIX, '')
    const flags = CODE_FLAGS.get(language)
    const flag = flags === undefined ? -1 : args.findIndex(arg => flags.includes(arg))
    const code = flag === -1 ? undefined : args[flag + 1]

    if (code === undefined)
      return []

    const argvs = [...code.matchAll(ARGV)].map(([, list = '']) => (list.match(LITERAL) ?? []).map(literalValue).join(' '))
    const runs = [...code.matchAll(LITERAL)].filter(({ 0: literal, index }) => RUNS_SHELL.test(code.slice(0, index)) || (literal.startsWith('`') && SHELL_BACKTICKS.has(language)))
    const lines = runs.flatMap(([literal]) => literalValue(literal).split('\n'))

    return [...argvs, ...lines].filter(line => line.trim() !== '')
  })
}
