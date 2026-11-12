import { afterBox, boxes, insertLines, lineEnding, referencedBoxes } from './checklist'

const MARKUP = /^[#*_\s]+|[*_\s]+$/g

function heading(line: string): string {
  return line.replaceAll(MARKUP, '').toLowerCase()
}

// Where new box lines go: after the last box of the section and its notes, right under its heading when it has none, or after the last box of the body.
function insertionPoint(lines: string[], body: string, section: string | undefined): number | undefined {
  const all = boxes(body)
  const last = all.at(-1)

  if (section === undefined)
    return last === undefined ? undefined : afterBox(lines, last.line)

  const title = heading(section)
  const at = lines.findIndex(line => heading(line) === title)

  if (at === -1)
    return undefined

  const lineOfBox = new Set(all.map(box => box.line))
  let end = at + 1
  let next = at + 1

  while (next < lines.length) {
    if (lineOfBox.has(next)) {
      end = afterBox(lines, next)
      next = end
    }
    else if (lines[next]?.trim() === '') {
      next++
    }
    else {
      break
    }
  }

  return end
}

// Adds the box lines under a section (created at the end when missing) or after the checklist's last box, keeping the body's line ends.
export function addLines(body: string, added: string[], section?: string): string {
  if (added.length === 0)
    return body

  const eol = lineEnding(body)
  const at = insertionPoint(body.split('\n'), body, section)

  if (at !== undefined)
    return insertLines(body, at, added)

  const text = body.trimEnd()

  return `${text}${text === '' ? '' : `${eol}${eol}`}${section === undefined ? '' : `${section}${eol}`}${added.join(eol)}${body.endsWith('\n') ? eol : ''}`
}

export function listedIssues(body: string): Set<number> {
  return new Set(referencedBoxes(body).map(({ issue }) => issue))
}

// The unticked box lines of a plan that open with an issue reference, as they are written.
export function openLines(body: string): { issue: number, line: string }[] {
  return referencedBoxes(body).filter(({ box }) => !box.done).map(({ box, issue }) => ({ issue, line: `- [ ] ${box.text}` }))
}
