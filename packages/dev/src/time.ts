export interface Zoned {
  local: string
  utc: string
}

const UNITS = [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1000]] as const
const DURATION_UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const

function parts(ms: number, timeZone: string | undefined): Record<string, string> {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset' })

  return Object.fromEntries(formatter.formatToParts(new Date(ms)).map(part => [part.type, part.value]))
}

// `2024-05-06 08:09:10 +02:00` in the zone (the host's when undefined), `UTC` for UTC.
export function formatZoned(ms: number, timeZone?: string): string {
  const p = parts(ms, timeZone)
  const offset = p.timeZoneName === 'GMT' ? '+00:00' : (p.timeZoneName ?? '').replace('GMT', '')

  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ${timeZone === 'UTC' ? 'UTC' : offset}`
}

export function zoned(ms: number, timeZone?: string): Zoned {
  return { local: formatZoned(ms, timeZone), utc: formatZoned(ms, 'UTC') }
}

// The zone's offset from UTC in milliseconds at that instant.
function offsetAt(ms: number, timeZone: string | undefined): number {
  const p = parts(ms, timeZone)

  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(ms / 1000) * 1000
}

// A duration in its two largest units: `2h 30m`, `45s`, `0s`.
export function humanDuration(ms: number): string {
  let rest = Math.floor(Math.abs(ms) / 1000) * 1000
  const out: string[] = []

  for (const [name, size] of UNITS) {
    const count = Math.floor(rest / size)

    if (count > 0) {
      out.push(`${count}${name}`)
      rest -= count * size
    }
  }

  return out.slice(0, 2).join(' ') || '0s'
}

// `in 2h 30m` or `5m ago` for an instant against now.
export function relative(ms: number, now: number): string {
  const delta = ms - now

  if (Math.abs(delta) < 1000)
    return 'now'

  return delta > 0 ? `in ${humanDuration(delta)}` : `${humanDuration(delta)} ago`
}

const DURATION = /^(?:\d+(?:\.\d+)?(?:ms|[dhms]))+$/
const DURATION_PART = /(\d+(?:\.\d+)?)(ms|[dhms])/g

// `2h30m`, `90m`, `1d`, `500ms` in milliseconds; undefined when the text is not a duration.
export function parseDuration(text: string): number | undefined {
  if (!DURATION.test(text))
    return undefined

  let total = 0

  for (const [, count, unit] of text.matchAll(DURATION_PART))
    total += Number(count) * DURATION_UNIT_MS[unit as keyof typeof DURATION_UNIT_MS]

  return total
}

const ZONELESS = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/
const DATE_SPACE = /^(\d{4}-\d{2}-\d{2}) /
const WHITESPACE = /\s+/g
const ZONED = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}(?::?\d{2})?)$/i

// An ISO date or date-time as milliseconds. One without a zone (and a bare date) is read in `timeZone`, the host's when undefined; one ending in Z or an offset carries its own.
export function parseDate(text: string, timeZone?: string): number | undefined {
  const match = ZONELESS.exec(text)

  if (match === null) {
    const ms = ZONED.test(text) ? Date.parse(text.replace(DATE_SPACE, '$1T').replace(WHITESPACE, '')) : Number.NaN

    return Number.isNaN(ms) ? undefined : ms
  }

  const [, year, month, day, hour = '0', minute = '0', second = '0', fraction = '0'] = match
  const wall = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(fraction.padEnd(3, '0')))

  // Date.UTC wraps an impossible date (month 13, 25:00) into a valid one, which the fields read back give away.
  const back = new Date(wall)

  if (back.getUTCFullYear() !== Number(year) || back.getUTCMonth() !== Number(month) - 1 || back.getUTCDate() !== Number(day) || back.getUTCHours() !== Number(hour) || back.getUTCMinutes() !== Number(minute) || back.getUTCSeconds() !== Number(second))
    return undefined

  // A second pass settles the offset when the wall time sits across a change of offset.
  const first = wall - offsetAt(wall, timeZone)

  return wall - offsetAt(first, timeZone)
}
