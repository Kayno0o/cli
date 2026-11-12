const SIZE = /^(\d+(?:\.\d+)?)\s*(?:([kmgt])i?b?|(b))?$/i
const POWERS: Record<string, number> = { '': 0, 'k': 1, 'm': 2, 'g': 3, 't': 4 }

// A size such as `500M`, `1.5G`, `800kb` or `500b` in bytes, counting in powers of 1024; a bare number counts `bareUnit` bytes (1 for bytes, 1024 ** 2 for megabytes). Undefined when it is none.
export function parseSize(text: string, bareUnit = 1): number | undefined {
  const match = SIZE.exec(text.trim())

  if (match === null)
    return undefined

  const suffix = match[2]?.toLowerCase()
  let unit = bareUnit

  if (match[3] !== undefined)
    unit = 1
  else if (suffix !== undefined)
    unit = 1024 ** POWERS[suffix]!

  return Math.round(Number(match[1]) * unit)
}

const UNITS = ['B', 'K', 'M', 'G', 'T']

// Bytes in the largest unit under 1024 of it, in powers of 1024: `512B`, `1.5K`, `38M`.
export function formatSize(bytes: number): string {
  let value = bytes
  let unit = 0

  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }

  if (unit === 0)
    return `${value}B`

  // 1023.6K would round to 1024K, which is 1.0M.
  if (Number(value.toFixed(value < 10 ? 1 : 0)) >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }

  return `${value.toFixed(value < 10 ? 1 : 0)}${UNITS[unit]}`
}
