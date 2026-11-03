const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

// A version 7 UUID: 48 bits of Unix milliseconds, then random bits with the version and variant set.
export function uuidV7(now = Date.now(), random: Uint8Array = randomBytes(10)): string {
  const bytes = new Uint8Array(16)

  for (let i = 0; i < 6; i++)
    bytes[i] = Math.floor(now / 2 ** (8 * (5 - i))) & 0xFF

  bytes.set(random.subarray(0, 10), 6)
  bytes[6] = (bytes[6]! & 0x0F) | 0x70
  bytes[8] = (bytes[8]! & 0x3F) | 0x80

  const hex = Buffer.from(bytes).toString('hex')

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// A ULID: 10 Crockford base32 characters of Unix milliseconds, then 16 of randomness.
export function ulid(now = Date.now(), random: Uint8Array = randomBytes(16)): string {
  let time = ''
  let rest = now

  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[rest % 32]! + time
    rest = Math.floor(rest / 32)
  }

  // Each random byte keeps its low 5 bits.
  return time + Array.from(random.subarray(0, 16), byte => CROCKFORD[byte & 31]).join('')
}

export function uuidV4(): string {
  return crypto.randomUUID()
}
