import type { Zoned } from './time'
import { humanDuration, parseDate, parseDuration, relative, zoned } from './time'

export type Converted = ({ kind: 'now' | 'epoch-seconds' | 'epoch-milliseconds' | 'date', ms: number, seconds: number, relative: string } & Zoned)
  | { kind: 'duration', ms: number, seconds: number, human: string, fromNow: Zoned }

export interface TsOptions {
  now?: number
  timeZone?: string | undefined
}

const NUMBER = /^-?\d+(?:\.\d+)?$/

// Epoch values from 1e11 up (1973 as milliseconds, year 5138 as seconds) are milliseconds.
const MILLISECONDS_FROM = 1e11

function instant(kind: 'now' | 'epoch-seconds' | 'epoch-milliseconds' | 'date', ms: number, now: number, timeZone: string | undefined): Converted {
  if (Number.isNaN(new Date(ms).getTime()))
    throw new Error('the date is out of range')

  return { kind, ...zoned(ms, timeZone), ms, seconds: Math.floor(ms / 1000), relative: relative(ms, now) }
}

// A nothing is now, a number is epoch seconds or milliseconds by its magnitude, `2h30m` a duration, anything else an ISO date or date-time.
export function convert(value: string | undefined, { now = Date.now(), timeZone }: TsOptions = {}): Converted {
  const text = value?.trim() ?? ''

  if (text === '')
    return instant('now', now, now, timeZone)

  if (NUMBER.test(text)) {
    const number = Number(text)

    return Math.abs(number) >= MILLISECONDS_FROM ? instant('epoch-milliseconds', Math.round(number), now, timeZone) : instant('epoch-seconds', Math.round(number * 1000), now, timeZone)
  }

  const duration = parseDuration(text)

  if (duration !== undefined)
    return { kind: 'duration', ms: duration, seconds: duration / 1000, human: humanDuration(duration), fromNow: zoned(now + duration, timeZone) }

  const date = parseDate(text, timeZone)

  if (date === undefined)
    throw new Error(`${text} is not an epoch, an ISO date or a duration such as 90m or 2h30m`)

  return instant('date', date, now, timeZone)
}
