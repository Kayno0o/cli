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
