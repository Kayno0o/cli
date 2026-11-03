export function b64Encode(bytes: Uint8Array, url = false): string {
  return Buffer.from(bytes).toString(url ? 'base64url' : 'base64')
}

const WHITESPACE = /\s+/g
const TRAILING_PADDING = /=+$/
const ALPHABET = /^[\w+/-]*={0,2}$/

// Standard or URL-safe base64, padded or not, whitespace ignored.
export function b64Decode(text: string): Uint8Array {
  const clean = text.replace(WHITESPACE, '')

  if (!ALPHABET.test(clean) || clean.replace(TRAILING_PADDING, '').length % 4 === 1)
    throw new Error('not valid base64')

  return Buffer.from(clean, 'base64')
}
