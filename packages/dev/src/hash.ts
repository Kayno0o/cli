export const ALGORITHMS = ['sha256', 'sha1', 'md5', 'sha512'] as const

export type Algorithm = (typeof ALGORITHMS)[number]

export function hashHex(algorithm: Algorithm, bytes: Uint8Array): string {
  return new Bun.CryptoHasher(algorithm).update(bytes).digest('hex')
}
