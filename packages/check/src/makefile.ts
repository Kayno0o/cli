// A variable set with `:=` or `::=` is not a target
const TARGET = /^([\w-]+)::?(?!:?=)/gm
const PHONY_LINE = /^\.PHONY:.*$/gm
const EXTRA_BLANK_LINES = /\n\s*\n\s*\n/g
const LEADING_BLANK_LINES = /^\s*\n/
const TRAILING_WHITESPACE = /\s+$/

// Declares every target .PHONY in one sorted line at the top, and collapses runs of blank lines.
export function declarePhony(content: string): { content: string, targets: string[] } {
  const targets = [...new Set(Array.from(content.matchAll(TARGET), match => match[1]!))]
    .sort((a, b) => a.localeCompare(b))

  const body = content
    .replace(PHONY_LINE, '')
    .replace(EXTRA_BLANK_LINES, '\n\n')
    .replace(LEADING_BLANK_LINES, '')

  const fixed = targets.length > 0 ? `.PHONY: ${targets.join(' ')}\n\n${body}` : body

  return { content: fixed.replace(TRAILING_WHITESPACE, '\n'), targets }
}
