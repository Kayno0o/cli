// A rule line, one target or several (`patch minor major:`); a variable set with `:=` or `::=` is not one. The rest of the line is read to tell a file target from a command.
const TARGET = /^([\w-]+(?:[ \t]+[\w-]+)*)[ \t]*::?(?!:?=)(.*)$/gm
// A .PHONY line and the lines a trailing backslash continues it over.
const PHONY_LINE = /^\.PHONY:((?:.*\\\n)*.*)$/gm
const BLANKS = /\s+/
const CONTINUATION = /\\\n/g
const EXTRA_BLANK_LINES = /\n\s*\n\s*\n/g
const LEADING_BLANK_LINES = /^\s*\n/
const TRAILING_WHITESPACE = /\s+$/
// A prerequisite that is a path or a file name, so the target builds a file.
const FILE_LIKE = /[./]/
const PLACEHOLDER = '\0phony\0'

// Declares every command target .PHONY in one sorted line where the first declaration stood (at the top when there was none), and collapses runs of blank lines. A target is left out when `exists` says a file of that name is there or when it depends on files, since declaring it phony would rebuild it every time; a target the file already declared is always kept, as it may come from an included file.
export function declarePhony(content: string, exists: (name: string) => boolean = () => false): { content: string, targets: string[] } {
  const declared = Array.from(content.matchAll(PHONY_LINE), match => match[1]!.replace(CONTINUATION, ' ').split(BLANKS)).flat().filter(name => name !== '')
  const found = Array.from(content.matchAll(TARGET), match => ({ names: match[1]!.split(BLANKS), deps: match[2]! }))
    .filter(({ deps }) => !FILE_LIKE.test(deps))
    .flatMap(({ names }) => names)
    .filter(name => !exists(name))
  const targets = [...new Set([...declared, ...found])].sort((a, b) => a.localeCompare(b))

  let isFirst = true
  const body = content
    .replace(PHONY_LINE, () => {
      const kept = isFirst ? PLACEHOLDER : ''

      isFirst = false

      return kept
    })
    .replace(EXTRA_BLANK_LINES, '\n\n')
    .replace(LEADING_BLANK_LINES, '')

  const line = `.PHONY: ${targets.join(' ')}`
  const fixed = targets.length === 0 ? body.replace(PLACEHOLDER, '') : body.includes(PLACEHOLDER) ? body.replace(PLACEHOLDER, line) : `${line}\n\n${body}`

  return { content: fixed.replace(LEADING_BLANK_LINES, '').replace(TRAILING_WHITESPACE, '\n'), targets }
}
