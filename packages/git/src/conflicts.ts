export interface Hunk {
  // 1-based and inclusive, the context lines around the markers included.
  from: number
  to: number
  lines: { line: number, text: string }[]
}

const OPENER = /^<{7}(?: |$)/
const CLOSER = /^>{7}(?: |$)/
const LINE_BREAK = /\r?\n/

// The conflict regions of a file's text, each from its `<<<<<<<` to its `>>>>>>>` line with `context` lines either side; regions whose context meets are one.
export function conflictHunks(text: string, context = 2): Hunk[] {
  const lines = text.split(LINE_BREAK)
  const spans: [number, number][] = []

  for (let i = 0; i < lines.length; i++) {
    if (!OPENER.test(lines[i] ?? ''))
      continue

    const end = lines.findIndex((line, at) => at > i && CLOSER.test(line))

    if (end === -1)
      break

    const from = Math.max(0, i - context)
    const to = Math.min(lines.length - 1, end + context)
    const last = spans.at(-1)

    if (last !== undefined && from <= last[1] + 1)
      last[1] = to
    else
      spans.push([from, to])

    i = end
  }

  return spans.map(([from, to]) => ({ from: from + 1, to: to + 1, lines: lines.slice(from, to + 1).map((line, at) => ({ line: from + at + 1, text: line })) }))
}
