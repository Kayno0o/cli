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

// The ULID after this one: its base32 number plus one, a carry out of the random part moving the time on a millisecond.
export function nextUlid(id: string): string {
  const digits = [...id]

  for (let i = digits.length - 1; i >= 0; i--) {
    const value = CROCKFORD.indexOf(digits[i]!) + 1

    digits[i] = CROCKFORD[value % 32]!

    if (value < 32)
      break
  }

  return digits.join('')
}

// The version 7 UUID after this one: its 48 time and 74 random bits as one number plus one, the version and variant bits kept.
export function nextUuidV7(id: string): string {
  const bits = BigInt(`0x${id.replaceAll('-', '')}`)
  const time = bits >> 80n
  const random = (((bits >> 64n) & 0xFFFn) << 62n) | (bits & ((1n << 62n) - 1n))
  const next = ((time << 74n) | random) + 1n
  const nextTime = next >> 74n
  const nextA = (next >> 62n) & 0xFFFn
  const nextB = next & ((1n << 62n) - 1n)
  const hex = ((nextTime << 80n) | (0x7n << 76n) | (nextA << 64n) | (0x2n << 62n) | nextB).toString(16).padStart(32, '0')

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// `count` ids in creation order: one drawn in the millisecond of the one before (or earlier, the clock stepping back) is that one's successor instead, so a batch sorts as it was made.
export function monotonic(count: number, draw: (now: number) => string, successor: (id: string) => string, clock: () => number = Date.now): string[] {
  const ids: string[] = []
  let last = Number.NEGATIVE_INFINITY

  for (let i = 0; i < count; i++) {
    const now = clock()
    const previous = ids.at(-1)

    ids.push(previous !== undefined && now <= last ? successor(previous) : draw(now))
    last = Math.max(last, now)
  }

  return ids
}
