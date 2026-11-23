// A CSI sequence (colours, cursor moves), an OSC one ended by BEL or ST (hyperlinks, titles) or a two-byte escape.
// eslint-disable-next-line no-control-regex -- escape sequences are what it matches
export const ANSI = /\x1B(?:\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[\x40-\x5A\x5C-\x5F])/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

// The C0 controls but tab and line feed, DEL and the C1 controls: what a terminal acts on instead of drawing.
// eslint-disable-next-line no-control-regex -- control characters are what it matches
const CONTROLS = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g

export function stripControls(text: string): string {
  return text.replace(CONTROLS, '')
}

// The text with each control character written the way `cat -v` shows it (`^[`, `^M`, `^?`, `M-^[`), so what reaches the terminal is drawn rather than run.
export function escapeControls(text: string): string {
  return text.replace(CONTROLS, (char) => {
    const code = char.charCodeAt(0)

    if (code === 0x7F)
      return '^?'

    return code < 0x80 ? `^${String.fromCharCode(code + 0x40)}` : `M-^${String.fromCharCode(code - 0x40)}`
  })
}

// Edit distance between two names, for pointing a mistyped name at the one meant; two neighbours typed swapped count as one edit.
export function distance(a: string, b: string): number {
  const left = [...a]
  const right = [...b]
  let before: number[] = []
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)

  for (const [i, x] of left.entries()) {
    const current = [i + 1]

    for (const [j, y] of right.entries()) {
      let cost = Math.min((previous[j + 1] ?? 0) + 1, (current[j] ?? 0) + 1, (previous[j] ?? 0) + (x === y ? 0 : 1))

      if (i > 0 && j > 0 && x === right[j - 1] && left[i - 1] === y)
        cost = Math.min(cost, (before[j - 1] ?? 0) + 1)

      current.push(cost)
    }

    before = previous
    previous = current
  }

  return previous[right.length] ?? 0
}

// A name the typed one starts, else one within two edits (one for a name under four letters).
export function closest(name: string, names: string[]): string | undefined {
  const started = names.find(known => known.startsWith(name))

  if (started !== undefined)
    return started

  const [best] = names.map(known => ({ known, far: distance(name, known) })).sort((a, b) => a.far - b.far)

  return best !== undefined && best.far <= (name.length < 4 ? 1 : 2) ? best.known : undefined
}

const ESC = String.fromCharCode(27)
// A colour or cursor code, or an OSC 8 link's opening or closing, read where `lastIndex` points.
const ESCAPE_CODE = new RegExp(`${ESC}(?:\\[[\\x30-\\x3F]*[\\x20-\\x2F]*[\\x40-\\x7E]|\\][^\\u0007${ESC}]*(?:\\u0007|${ESC}\\\\))`, 'y')
const RESET_STYLE = `${ESC}[0m`
const CLOSE_LINK = `${ESC}]8;;${ESC}\\`

// The line cut to `width` columns of visible text, its escapes kept whole, and styles and links ended after a cut so none runs into the next cell or line.
export function cutToWidth(line: string, width: number, suffix = ''): string {
  if (Bun.stringWidth(line) <= width)
    return line

  const suffixWidth = suffix === '' ? 0 : Bun.stringWidth(suffix)
  let room = Math.max(0, width - suffixWidth)
  let kept = ''
  let index = 0
  let styled = false
  let linked = false

  while (index < line.length) {
    ESCAPE_CODE.lastIndex = index

    const escape = ESCAPE_CODE.exec(line)

    if (escape !== null) {
      kept += escape[0]

      if (escape[0].startsWith(`${ESC}]`))
        linked = true
      else
        styled = true

      index = ESCAPE_CODE.lastIndex

      continue
    }

    const char = String.fromCodePoint(line.codePointAt(index)!)
    const columns = Bun.stringWidth(char)

    if (columns > room)
      break

    kept += char
    room -= columns
    index += char.length
  }

  return `${kept}${styled ? RESET_STYLE : ''}${linked ? CLOSE_LINK : ''}${suffix}`
}
