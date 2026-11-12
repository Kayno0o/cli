// The dotAll flag keeps a U+2028 or U+2029 in a box's text from ending the match.
const BOX = /^(\s*[-*+] \[)([ x])(\]\s)(.*?)\r?$/is
// A backtick fence's info string holds no backtick, so a line opening on an inline code span is a paragraph.
const FENCE = /^\s*(`{3,}(?!.*`)|~{3,})/
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
const LINE_END = /\r?\n/
const LINE_ENDS = /(\r?\n)/

function indentOf(line: string): number {
  return INDENT.exec(line)?.[0].length ?? 0
}

export function lineEnding(body: string): string {
  return body.includes('\r\n') ? '\r\n' : '\n'
}

// The index after a box line and the lines continuing it: those indented deeper, with the blank lines between them.
export function afterBox(lines: string[], line: number): number {
  const depth = indentOf(lines[line] ?? '')
  let end = line + 1

  for (let next = line + 1; next < lines.length; next++) {
    const text = lines[next] ?? ''

    if (text.trim() === '')
      continue

    if (indentOf(text) <= depth)
      break

    end = next + 1
  }

  return end
}

// The body with lines inserted before its line at the index, the new lines in the body's line ending and the others as they were.
export function insertLines(body: string, at: number, added: string[]): string {
  const eol = lineEnding(body)
  // Lines at even indexes, each followed by its own ending.
  const parts = body.split(LINE_ENDS)

  if (2 * at >= parts.length)
    return `${body}${eol}${added.join(eol)}`

  parts.splice(2 * at, 0, added.map(line => `${line}${eol}`).join(''))

  return parts.join('')
}

// New unticked boxes after the body's last box and its notes, indented like it, or at the end of a body without any.
export function appendBoxes(body: string, texts: string[]): string {
  const eol = lineEnding(body)
  const last = boxes(body).at(-1)
  const lines = body.split(LINE_END)
  const indent = last === undefined ? '' : INDENT.exec(lines[last.line] ?? '')?.[0] ?? ''
  const added = texts.map(text => `${indent}- [ ] ${text}`)

  if (last === undefined)
    return body.trim() === '' ? added.join(eol) : `${body.trimEnd()}${eol}${eol}${added.join(eol)}${body.endsWith('\n') ? eol : ''}`

  return insertLines(body, afterBox(lines, last.line), added)
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
    const byText = (text: string) => all.filter(box => box.text.toLowerCase().includes(text.trim().toLowerCase()))
    let matches = guarded === null && !WHOLE_PICK.test(pick)
      ? byText(pick)
      : all.filter(box => box.number === Number(guarded?.[1] ?? pick) && (guarded === null || box.text.toLowerCase().startsWith((guarded[2] ?? '').trim().toLowerCase())))

    // Text that merely starts with digits and a colon, like `3:30 deploy`, is read whole when no box N starts with what follows the colon.
    if (guarded !== null && matches.length === 0)
      matches = byText(pick)

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
