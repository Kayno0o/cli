import { complexityOf } from './churn'

export interface Unit {
  name: string
  line: number
  complexity: number
}

const CONTAINER = /^(?:(?:export|default|declare|abstract|final|readonly|public|pub|private|protected|internal|sealed|data|open)\s+)*(?:class|impl|trait|interface|namespace|module|object|mod|struct|enum)\b/
const CLOSER = /^[\s)\]};]*$|^\s*(?:\/\/|\/\*|\*|#)/
const LONGEST_NAME = 60

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

// A line that opens a declaration at `indent`: not blank, a closing bracket, a comment or the lone brace under an Allman-style header.
function opens(line: string, indent: number): boolean {
  return line.trim() !== '' && line.trim() !== '{' && indentOf(line) === indent && !CLOSER.test(line)
}

// The declarations indented at `indent` with the lines up to the next one, a container (class, impl, ...) opened into its own members one level in.
function unitsAt(lines: readonly string[], from: number, to: number, indent: number): Unit[] {
  const starts: number[] = []

  for (let at = from; at < to; at++) {
    if (opens(lines[at] as string, indent))
      starts.push(at)
  }

  return starts.flatMap((start, index): Unit[] => {
    const end = starts[index + 1] ?? to
    const header = (lines[start] as string).trim()

    if (CONTAINER.test(header)) {
      const inner = lines.slice(start + 1, end).filter(line => line.trim() !== '').map(indentOf).filter(each => each > indent)
      const next = inner.length === 0 ? undefined : Math.min(...inner)

      if (next !== undefined) {
        const members = unitsAt(lines, start + 1, end, next)

        if (members.length > 0)
          return members
      }
    }

    return [{ name: header.length > LONGEST_NAME ? `${header.slice(0, LONGEST_NAME - 1)}…` : header, line: start + 1, complexity: complexityOf(lines.slice(start, end).join('\n')) }]
  })
}

// The most complex declaration of a file, found by indentation alone so every language reads the same way; undefined when nothing is indented like a declaration.
export function worstUnit(text: string): Unit | undefined {
  const lines = text.split('\n')
  const top = unitsAt(lines, 0, lines.length, 0)

  return top.reduce<Unit | undefined>((worst, unit) => worst === undefined || unit.complexity > worst.complexity ? unit : worst, undefined)
}
