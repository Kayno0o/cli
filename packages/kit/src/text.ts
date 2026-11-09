// A CSI sequence (colours, cursor moves), an OSC one ended by BEL or ST (hyperlinks, titles) or a two-byte escape.
// eslint-disable-next-line no-control-regex -- escape sequences are what it matches
export const ANSI = /\x1B(?:\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[\x40-\x5A\x5C-\x5F])/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

// Edit distance between two names, for pointing a mistyped name at the one meant.
export function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)

  for (const [i, left] of [...a].entries()) {
    const current = [i + 1]

    for (const [j, right] of [...b].entries())
      current.push(Math.min((previous[j + 1] ?? 0) + 1, (current[j] ?? 0) + 1, (previous[j] ?? 0) + (left === right ? 0 : 1)))

    previous = current
  }

  return previous[b.length] ?? 0
}

// A name the typed one starts, else one within two edits (one for a name under four letters).
export function closest(name: string, names: string[]): string | undefined {
  const started = names.find(known => known.startsWith(name))

  if (started !== undefined)
    return started

  const [best] = names.map(known => ({ known, far: distance(name, known) })).sort((a, b) => a.far - b.far)

  return best !== undefined && best.far <= (name.length < 4 ? 1 : 2) ? best.known : undefined
}
