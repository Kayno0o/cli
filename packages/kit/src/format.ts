const UNITS = [['d', 86_400], ['h', 3600], ['m', 60], ['s', 1]] as const

// Renders as "13m 28s": the largest unit and the next one, dropped when zero.
export function formatSeconds(total: number): string {
  let rest = Math.max(0, Math.round(total))
  const amounts = UNITS.map(([unit, size]) => {
    const amount = Math.floor(rest / size)

    rest -= amount * size

    return `${amount}${unit}`
  })
  const first = amounts.findIndex(amount => !amount.startsWith('0'))

  if (first === -1)
    return '0s'

  const next = amounts[first + 1]

  return next === undefined || next.startsWith('0') ? amounts[first] ?? '0s' : `${amounts[first]} ${next}`
}

// The text up to the first separator, or all of it.
export function upTo(text: string, separator: string): string {
  const end = text.indexOf(separator)

  return end === -1 ? text : text.slice(0, end)
}

export function formatAge(date: string | number, now = Date.now()): string {
  const at = typeof date === 'number' ? date : Date.parse(date)

  if (Number.isNaN(at))
    return '-'

  const seconds = (now - at) / 1000

  return seconds < 60 ? 'just now' : `${upTo(formatSeconds(seconds), ' ')} ago`
}

export function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`
}

export function table(rows: string[][]): string {
  const widths: number[] = []

  for (const row of rows) {
    for (const [index, cell] of row.entries())
      widths[index] = Math.max(widths[index] ?? 0, cell.length)
  }

  return rows.map(row => row.map((cell, index) => index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)).join('  ').trimEnd()).join('\n')
}
