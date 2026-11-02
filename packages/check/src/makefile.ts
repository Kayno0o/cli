// A variable set with `:=` or `::=` is not a target. The rest of the line is read to tell a file target from a command.
const TARGET = /^([\w-]+)::?(?!:?=)(.*)$/gm
// A .PHONY line and the lines a trailing backslash continues it over.
const PHONY_LINE = /^\.PHONY:(?:.*\\\n)*.*$/gm
const EXTRA_BLANK_LINES = /\n\s*\n\s*\n/g
const LEADING_BLANK_LINES = /^\s*\n/
const TRAILING_WHITESPACE = /\s+$/
// A prerequisite that is a path or a file name, so the target builds a file.
const FILE_LIKE = /[./]/

// Declares every command target .PHONY in one sorted line at the top, and collapses runs of blank lines. A target is left out when `exists` says a file of that name is there or when it depends on files, since declaring it phony would rebuild it every time.
export function declarePhony(content: string, exists: (name: string) => boolean = () => false): { content: string, targets: string[] } {
  const targets = [...new Set(Array.from(content.matchAll(TARGET), match => ({ name: match[1]!, deps: match[2]! })).filter(({ name, deps }) => !exists(name) && !FILE_LIKE.test(deps)).map(({ name }) => name))]
    .sort((a, b) => a.localeCompare(b))

  const body = content
    .replace(PHONY_LINE, '')
    .replace(EXTRA_BLANK_LINES, '\n\n')
    .replace(LEADING_BLANK_LINES, '')

  const fixed = targets.length > 0 ? `.PHONY: ${targets.join(' ')}\n\n${body}` : body

  return { content: fixed.replace(TRAILING_WHITESPACE, '\n'), targets }
}
