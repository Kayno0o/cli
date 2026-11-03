import type { Zoned } from './time'
import { relative, zoned } from './time'

export interface Jwt {
  header: Record<string, unknown>
  payload: Record<string, unknown>
  signatureBytes: number
}

export interface Claim extends Zoned {
  claim: string
  epoch: number
  relative: string
}

const BEARER = /^Bearer\s+/i
const TIME_CLAIMS = ['iat', 'nbf', 'exp'] as const

function segment(text: string, name: string): Record<string, unknown> {
  let value: unknown

  try {
    value = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'))
  }
  catch {
    throw new Error(`the ${name} is not base64url JSON`)
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`the ${name} is not a JSON object`)

  return value as Record<string, unknown>
}

// Header and payload of a JWT, read without checking the signature.
export function decodeJwt(token: string): Jwt {
  const parts = token.trim().replace(BEARER, '').split('.')

  if (parts.length !== 3)
    throw new Error(`a JWT has 3 dot-separated parts, this has ${parts.length}`)

  const [header = '', payload = '', signature = ''] = parts

  return { header: segment(header, 'header'), payload: segment(payload, 'payload'), signatureBytes: Buffer.from(signature, 'base64url').length }
}

// The iat, nbf and exp claims that hold a number, as dates against `now`.
export function claimTimes(payload: Record<string, unknown>, now = Date.now(), timeZone?: string): Claim[] {
  return TIME_CLAIMS.flatMap((claim) => {
    const epoch = payload[claim]

    return typeof epoch === 'number' && Number.isFinite(epoch) ? [{ claim, epoch, ...zoned(epoch * 1000, timeZone), relative: relative(epoch * 1000, now) }] : []
  })
}
