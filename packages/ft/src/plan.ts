import { boxes, referencedBoxes } from './checklist'

const MARKUP = /^[#*_\s]+|[*_\s]+$/g

function heading(line: string): string {
  return line.replaceAll(MARKUP, '').toLowerCase()
}

// Where new box lines go: after the last box of the section, right under its heading when it has none, or after the last box of the body.
function insertionPoint(lines: string[], body: string, section: string | undefined): number | undefined {
  const all = boxes(body)

  if (section === undefined)
    return all.length === 0 ? undefined : (all.at(-1)?.line ?? 0) + 1

  const title = heading(section)
  const at = lines.findIndex(line => heading(line) === title)

  if (at === -1)
    return undefined

  const lineOfBox = new Set(all.map(box => box.line))
  let end = at + 1

  for (let next = at + 1; next < lines.length; next++) {
    if (lineOfBox.has(next))
      end = next + 1
    else if (lines[next]?.trim() !== '')
      break
  }

  return end
}

// Adds the box lines under a section (created at the end when missing) or after the checklist's last box, keeping the body's line ends.
export function addLines(body: string, added: string[], section?: string): string {
  if (added.length === 0)
    return body

  const eol = body.includes('\r\n') ? '\r' : ''
  const lines = body.split('\n')
  const at = insertionPoint(lines, body, section)
  const fresh = added.map(line => `${line}${eol}`)

  if (at !== undefined) {
    lines.splice(at, 0, ...fresh)

    return lines.join('\n')
  }

  const text = body.trimEnd()

  return `${text}${text === '' ? '' : `${eol}\n${eol}\n`}${section === undefined ? '' : `${section}${eol}\n`}${fresh.join('\n')}${body.endsWith('\n') ? '\n' : ''}`
}

export function listedIssues(body: string): Set<number> {
  return new Set(referencedBoxes(body).map(({ issue }) => issue))
}

// The unticked box lines of a plan that open with an issue reference, as they are written.
export function openLines(body: string): { issue: number, line: string }[] {
  return referencedBoxes(body).filter(({ box }) => !box.done).map(({ box, issue }) => ({ issue, line: `- [ ] ${box.text}` }))
}
