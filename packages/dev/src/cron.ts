import { formatZoned } from './time'

export interface CronSchedule {
  expression: string
  normalized: string
  description: string
  next: { iso: string, local: string, utc: string }[]
}

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WHITESPACE = /\s+/
const STEP_SPEC = /^([^/]+)(?:\/(\d+))?$/
const INTEGER = /^\d+$/

interface ParsedField {
  values: Set<number>
  wildcard: boolean
  raw: string
}

function parseAtom(token: string, min: number, max: number, names?: readonly string[], wrapSunday = false): number {
  const upper = token.toUpperCase()

  if (names !== undefined) {
    const idx = names.indexOf(upper)

    if (idx !== -1)
      return min + idx
  }

  if (!INTEGER.test(token))
    throw new Error(`invalid cron token '${token}'`)

  const value = Number(token)

  if (wrapSunday && value === 7)
    return 0

  if (value < min || value > max)
    throw new Error(`cron value ${value} out of range ${min}-${max}`)

  return value
}

function parseField(raw: string, min: number, max: number, names?: readonly string[], wrapSunday = false): ParsedField {
  const values = new Set<number>()

  for (const part of raw.split(',')) {
    const match = STEP_SPEC.exec(part)

    if (match === null)
      throw new Error(`invalid cron field '${raw}'`)

    const [, rangeRaw, stepRaw] = match
    const step = stepRaw === undefined ? 1 : Number(stepRaw)

    if (step < 1)
      throw new Error(`cron step must be positive in '${raw}'`)

    let start = min
    let end = max

    if (rangeRaw !== '*') {
      const dash = rangeRaw!.indexOf('-')

      if (dash === -1) {
        start = parseAtom(rangeRaw!, min, max, names, wrapSunday)
        end = stepRaw === undefined ? start : max
      }
      else {
        const left = rangeRaw!.slice(0, dash)
        const right = rangeRaw!.slice(dash + 1)

        start = parseAtom(left, min, max, names, wrapSunday)
        end = parseAtom(right, min, max, names, wrapSunday)

        if (end < start)
          throw new Error(`cron range ${rangeRaw} is reversed`)
      }
    }

    for (let v = start; v <= end; v += step)
      values.add(v)
  }

  return { values, wildcard: raw === '*', raw }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function describeFields(min: ParsedField, hour: ParsedField, dom: ParsedField, month: ParsedField, dow: ParsedField): string {
  const parts: string[] = []

  if (min.raw === '*' && hour.raw === '*') {
    parts.push('Every minute')
  }
  else if (min.raw.startsWith('*/') && hour.raw === '*') {
    parts.push(`Every ${min.raw.slice(2)} minutes`)
  }
  else if (hour.raw === '*') {
    parts.push(`At minute ${[...min.values].join(', ')} of every hour`)
  }
  else if (hour.raw.startsWith('*/') && min.values.size === 1) {
    parts.push(`Every ${hour.raw.slice(2)} hours at minute ${pad2([...min.values][0]!)}`)
  }
  else if (min.values.size === 1 && hour.values.size === 1) {
    parts.push(`At ${pad2([...hour.values][0]!)}:${pad2([...min.values][0]!)}`)
  }
  else {
    parts.push(`At minute ${min.raw} past hour ${hour.raw}`)
  }

  if (!dom.wildcard)
    parts.push(`on day ${dom.raw} of the month`)

  if (!month.wildcard) {
    const names = [...month.values].sort((a, b) => a - b).map(m => MONTH_FULL[m - 1] ?? String(m))

    parts.push(`in ${names.join(', ')}`)
  }

  if (!dow.wildcard) {
    const sorted = [...dow.values].sort((a, b) => a - b)
    const names = sorted.map(d => DAY_FULL[d] ?? String(d))

    parts.push(`on ${names.join(', ')}`)
  }

  return parts.join(' ')
}

function matchesDay(date: Date, dom: ParsedField, dow: ParsedField): boolean {
  const dayOfMonth = dom.values.has(date.getUTCDate())
  const dayOfWeek = dow.values.has(date.getUTCDay())

  if (dom.wildcard && dow.wildcard)
    return true

  if (dom.wildcard)
    return dayOfWeek

  if (dow.wildcard)
    return dayOfMonth

  // Standard Vixie cron: when both DOM and DOW are restricted, either matches.
  return dayOfMonth || dayOfWeek
}

function zonedDateParts(ms: number, timeZone: string | undefined): { year: number, month: number, day: number, hour: number, minute: number, dow: number } {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' })
  const map = Object.fromEntries(formatter.formatToParts(new Date(ms)).map(part => [part.type, part.value]))
  const dow = DAYS.indexOf((map.weekday ?? 'Sun').slice(0, 3).toUpperCase())

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    dow: dow === -1 ? 0 : dow,
  }
}

export function evaluateCron(expression: string, count = 5, fromMs = Date.now(), timeZone?: string): CronSchedule {
  const trimmed = expression.trim()
  const normalized = MACROS[trimmed.toLowerCase()] ?? trimmed
  const fields = normalized.split(WHITESPACE)

  if (fields.length !== 5)
    throw new Error(`cron expression must have 5 fields (minute hour day month weekday) or a @macro, got '${expression}'`)

  const min = parseField(fields[0]!, 0, 59)
  const hour = parseField(fields[1]!, 0, 23)
  const dom = parseField(fields[2]!, 1, 31)
  const month = parseField(fields[3]!, 1, 12, MONTHS)
  const dow = parseField(fields[4]!, 0, 6, DAYS, true)
  const description = describeFields(min, hour, dom, month, dow)
  const next: { iso: string, local: string, utc: string }[] = []

  // Start at the next whole minute strictly after `fromMs`.
  let cursor = Math.floor(fromMs / 60_000) * 60_000 + 60_000
  const maxMs = fromMs + 4 * 366 * 86_400_000

  while (next.length < count && cursor <= maxMs) {
    if (timeZone === undefined || timeZone === 'UTC') {
      const date = new Date(cursor)

      if (!month.values.has(date.getUTCMonth() + 1)) {
        cursor = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0)

        continue
      }

      if (!matchesDay(date, dom, dow)) {
        cursor = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 0)

        continue
      }

      if (!hour.values.has(date.getUTCHours())) {
        cursor = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours() + 1, 0)

        continue
      }

      if (!min.values.has(date.getUTCMinutes())) {
        cursor += 60_000

        continue
      }

      next.push({ iso: date.toISOString(), local: formatZoned(cursor, timeZone), utc: formatZoned(cursor, 'UTC') })
      cursor += 60_000
    }
    else {
      const p = zonedDateParts(cursor, timeZone)

      if (!month.values.has(p.month)) {
        cursor += 86_400_000 - (p.hour * 3_600_000 + p.minute * 60_000)

        continue
      }

      const dayMatch = (dom.wildcard && dow.wildcard)
        || (dom.wildcard && dow.values.has(p.dow))
        || (dow.wildcard && dom.values.has(p.day))
        || (!dom.wildcard && !dow.wildcard && (dom.values.has(p.day) || dow.values.has(p.dow)))

      if (!dayMatch) {
        cursor += 3_600_000 * Math.max(1, 24 - p.hour) - p.minute * 60_000

        continue
      }

      if (!hour.values.has(p.hour)) {
        cursor += 3_600_000 - p.minute * 60_000

        continue
      }

      if (!min.values.has(p.minute)) {
        cursor += 60_000

        continue
      }

      next.push({ iso: new Date(cursor).toISOString(), local: formatZoned(cursor, timeZone), utc: formatZoned(cursor, 'UTC') })
      cursor += 60_000
    }
  }

  return { expression: trimmed, normalized, description, next }
}
