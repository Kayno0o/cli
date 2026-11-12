export const FORMATS = ['hex', 'base64', 'base64url'] as const

export type Format = (typeof FORMATS)[number]

export const DEFAULT_LENGTH = 32

// `length` random bytes written in `format`, as `openssl rand -hex|-base64 <length>` does (base64url is that base64 with `+/` swapped for `-_` and the padding dropped).
export function generatePassword(length: number, format: Format, random: (bytes: Uint8Array) => Uint8Array = bytes => crypto.getRandomValues(bytes)): string {
  const buffer = Buffer.from(random(new Uint8Array(length)))

  return buffer.toString(format)
}

// bcrypt reads at most this many bytes; Bun pre-hashes a longer password, which only Bun then verifies.
export const BCRYPT_MAX_BYTES = 72

// Bun writes `$2b$`, `htpasswd -B` writes `$2y$`: the same algorithm, and `$2y$` is the prefix Apache, nginx and traefik basic auth all accept.
export async function bcryptHash(password: string): Promise<string> {
  const hash = await Bun.password.hash(password, { algorithm: 'bcrypt', cost: 10 })

  return `$2y$${hash.slice('$2b$'.length)}`
}
