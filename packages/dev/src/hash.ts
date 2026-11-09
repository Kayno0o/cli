export const ALGORITHMS = ['sha256', 'sha1', 'md5', 'sha512'] as const

export type Algorithm = (typeof ALGORITHMS)[number]

export function hashHex(algorithm: Algorithm, bytes: Uint8Array): string {
  return new Bun.CryptoHasher(algorithm).update(bytes).digest('hex')
}

/** The digest and byte count of a stream, fed chunk by chunk so a big file is never held whole. */
export async function hashStream(algorithm: Algorithm, stream: ReadableStream<Uint8Array>): Promise<{ digest: string, bytes: number }> {
  const hasher = new Bun.CryptoHasher(algorithm)
  let bytes = 0

  for await (const chunk of stream) {
    hasher.update(chunk)
    bytes += chunk.length
  }

  return { digest: hasher.digest('hex'), bytes }
}
