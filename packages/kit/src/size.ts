const SIZE = /^(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?$/i
const POWERS: Record<string, number> = { '': 0, 'k': 1, 'm': 2, 'g': 3, 't': 4 }

// A size such as `500M`, `1.5G` or `800kb` in bytes, counting in powers of 1024; a bare number counts `bareUnit` bytes (1 for bytes, 1024 ** 2 for megabytes). Undefined when it is none.
export function parseSize(text: string, bareUnit = 1): number | undefined {
  const match = SIZE.exec(text.trim())

  if (match === null)
    return undefined

  const suffix = match[2]!.toLowerCase()

  return Math.round(Number(match[1]) * (suffix === '' ? bareUnit : 1024 ** POWERS[suffix]!))
}
