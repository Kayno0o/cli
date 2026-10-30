const BOX = /^(\s*[-*+] \[)([ x])(\]\s)(.*)\r?$/i
const FENCE = /^\s*(?:```|~~~)/

export interface Box { number: number, line: number, done: boolean, text: string }

// The task-list boxes of a Markdown body, numbered from 1, those inside fenced code left out.
export function boxes(body: string): Box[] {
  const found: Box[] = []
  let fenced = false

  for (const [line, text] of body.split('\n').entries()) {
    if (FENCE.test(text)) {
      fenced = !fenced

      continue
    }

    const match = fenced ? null : BOX.exec(text)

    if (match !== null)
      found.push({ number: found.length + 1, line, done: match[2] !== ' ', text: match[4] ?? '' })
  }

  return found
}

const INDENT = /^\s*/

// New unticked boxes after the body's last box, indented like it, or at the end of a body without any.
export function appendBoxes(body: string, texts: string[]): string {
  const end = body.includes('\r\n') ? '\r' : ''
  const last = boxes(body).at(-1)
  const lines = body.split('\n')
  const indent = last === undefined ? '' : INDENT.exec(lines[last.line] ?? '')?.[0] ?? ''
  const added = texts.map(text => `${indent}- [ ] ${text}${end}`)

  if (last === undefined)
    return body.trim() === '' ? added.join('\n') : `${body.trimEnd()}${end}\n${end}\n${added.join('\n')}`

  lines.splice(last.line + 1, 0, ...added)

  return lines.join('\n')
}

// The body as it reads, each box line carrying its number as `ft tick` takes it in place of the list marker.
export function numberedBody(body: string): string {
  const lines = body.replaceAll('\r\n', '\n').split('\n')

  for (const box of boxes(body))
    lines[box.line] = `${INDENT.exec(lines[box.line] ?? '')?.[0] ?? ''}${box.number} [${box.done ? 'x' : ' '}] ${box.text}`

  return lines.join('\n').trim()
}

export interface Ticked { body: string, changed: Box[] }

// Picks are box numbers or text matching exactly one box, case-insensitive; an unknown or ambiguous pick throws.
export function setBoxes(body: string, picks: string[], done: boolean): Ticked {
  const all = boxes(body)
  const chosen = new Map<number, Box>()

  for (const pick of picks) {
    const number = Number(pick)
    const needle = pick.toLowerCase()
    const matches = Number.isInteger(number) && String(number) === pick
      ? all.filter(box => box.number === number)
      : all.filter(box => box.text.toLowerCase().includes(needle))

    if (matches.length === 0)
      throw new Error(`no box matches ${pick}`)

    if (matches.length > 1)
      throw new Error(`${pick} matches ${matches.length} boxes: ${matches.map(box => box.number).join(', ')}`)

    const [box] = matches

    if (box !== undefined)
      chosen.set(box.number, box)
  }

  const lines = body.split('\n')
  const changed: Box[] = []

  for (const box of chosen.values()) {
    if (box.done === done)
      continue

    const line = lines[box.line] ?? ''

    // BOX drops a Windows line end, which a body edited in Forgejo's web editor carries.
    lines[box.line] = line.replace(BOX, `$1${done ? 'x' : ' '}$3$4`) + (line.endsWith('\r') ? '\r' : '')
    changed.push({ ...box, done })
  }

  return { body: lines.join('\n'), changed }
}

const REFERENCE = /^#(\d+)(?!\d)/

export interface Reference { box: Box, issue: number }

// The boxes that open with an issue reference, as a release plan lists `- [ ] #12 title`.
export function referencedBoxes(body: string): Reference[] {
  const found: Reference[] = []

  for (const box of boxes(body)) {
    const match = REFERENCE.exec(box.text)

    if (match?.[1] !== undefined)
      found.push({ box, issue: Number(match[1]) })
  }

  return found
}

// Ticks the unticked boxes referencing an issue that `wanted` accepts.
export function tickReferences(body: string, wanted: (issue: number) => boolean): Ticked {
  const picks = referencedBoxes(body).filter(({ box, issue }) => !box.done && wanted(issue)).map(({ box }) => String(box.number))

  return setBoxes(body, picks, true)
}
