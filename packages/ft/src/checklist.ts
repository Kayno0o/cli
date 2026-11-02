// The dotAll flag keeps a U+2028 or U+2029 in a box's text from ending the match.
const BOX = /^(\s*[-*+] \[)([ x])(\]\s)(.*?)\r?$/is
const FENCE = /^\s*(`{3,}|~{3,})/
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/
const INDENT_CODE = /^(?: {4}|\t)/

export interface Box { number: number, line: number, done: boolean, text: string }

// The task-list boxes of a Markdown body, numbered from 1, those inside fenced or indented code left out.
export function boxes(body: string): Box[] {
  const found: Box[] = []
  let fence: string | undefined
  let inList = false

  for (const [line, text] of body.split('\n').entries()) {
    const marker = FENCE.exec(text)?.[1]

    // A fence closes on its own character, at least as long as the one that opened it.
    if (fence !== undefined) {
      if (marker?.startsWith(fence[0] ?? '') === true && marker.length >= fence.length && text.trim() === marker)
        fence = undefined

      continue
    }

    if (marker !== undefined) {
      fence = marker

      continue
    }

    const blank = text.trim() === ''
    const match = INDENT_CODE.test(text) && !inList ? null : BOX.exec(text)

    if (match !== null)
      found.push({ number: found.length + 1, line, done: match[2] !== ' ', text: match[4] ?? '' })

    // Four spaces are code unless a list item above they continue.
    if (LIST_ITEM.test(text))
      inList = true
    else if (!blank && !text.startsWith(' ') && !text.startsWith('\t'))
      inList = false
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

const NUMBERED_PICK = /^(\d+):(.+)$/s
const WHOLE_PICK = /^\d+$/

// Picks are box numbers, `N:text` for box N only when its text starts with that text, or text matching exactly one box, case-insensitive; an empty, unknown or ambiguous pick throws.
export function setBoxes(body: string, picks: string[], done: boolean): Ticked {
  const all = boxes(body)
  const chosen = new Map<number, Box>()

  for (const pick of picks) {
    if (pick.trim() === '')
      throw new Error('an empty box pick matches every box')

    const guarded = NUMBERED_PICK.exec(pick)
    const needle = (guarded?.[2] ?? pick).trim().toLowerCase()
    const matches = guarded === null && !WHOLE_PICK.test(pick)
      ? all.filter(box => box.text.toLowerCase().includes(needle))
      : all.filter(box => box.number === Number(guarded?.[1] ?? pick) && (guarded === null || box.text.toLowerCase().startsWith(needle)))

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
