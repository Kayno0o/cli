const SPAN = /^(-?\d+)?(\.\.)?(-?\d+)?$/

// A field keeps the delimiter that ends it, as fzf does, so joined fields read as the line did.
export function splitFields(line: string, delimiter: RegExp | undefined): string[] {
  if (delimiter === undefined)
    return line.match(/\s*\S+\s*/g) ?? []

  const fields: string[] = []
  let from = 0

  for (const match of line.matchAll(new RegExp(delimiter, `${delimiter.flags}g`))) {
    if (match[0] === '')
      continue

    fields.push(line.slice(from, match.index + match[0].length))
    from = match.index + match[0].length
  }

  fields.push(line.slice(from))

  return fields
}

// fzf's field index syntax: `2`, `-1`, `2..`, `..3`, `2..4`, `..`, comma-separated; 1-based, negative counting from the end. Undefined when the text is not one.
export function parseFields(expression: string): ((count: number) => number[]) | undefined {
  const spans: ((count: number) => number[])[] = []

  for (const part of expression.split(',')) {
    const span = SPAN.exec(part)

    if (span === null || part === '' || part === '0')
      return undefined

    const [, from, dots, to] = span
    const resolve = (n: number, count: number): number => n < 0 ? count + n : n - 1

    spans.push((count) => {
      const first = from === undefined ? 0 : resolve(Number(from), count)
      const last = dots === undefined ? first : to === undefined ? count - 1 : resolve(Number(to), count)

      return Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i).filter(i => i >= 0 && i < count)
    })
  }

  return count => spans.flatMap(span => span(count))
}

// The fields the expression picks out of the line, joined back.
export function pickFields(line: string, select: (count: number) => number[], delimiter: RegExp | undefined): string {
  const fields = splitFields(line, delimiter)

  return select(fields.length).map(i => fields[i]!).join('')
}
