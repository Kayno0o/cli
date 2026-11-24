export const ENCODINGS = ['b64', 'b64url', 'hex', 'url', 'html'] as const

export type Encoding = (typeof ENCODINGS)[number]

export function b64Encode(bytes: Uint8Array, url = false): string {
  return Buffer.from(bytes).toString(url ? 'base64url' : 'base64')
}

const WHITESPACE = /\s+/g
const TRAILING_PADDING = /=+$/
const ALPHABET = /^[\w+/-]*={0,2}$/
const HEX_DIGITS = /^[\da-f]*$/i
const HTML_SPECIAL = /[&<>"']/g
const HTML_ENTITY = /&(?:#x([\da-f]+)|#(\d+)|(amp|lt|gt|quot|apos|nbsp));/gi

const HTML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '\'': '&#39;',
}

const HTML_UNESCAPE: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: '\'',
  nbsp: '\u00A0',
}

// Standard or URL-safe base64, padded or not, whitespace ignored.
export function b64Decode(text: string): Uint8Array {
  const clean = text.replace(WHITESPACE, '')

  if (!ALPHABET.test(clean) || clean.replace(TRAILING_PADDING, '').length % 4 === 1)
    throw new Error('not valid base64')

  return Buffer.from(clean, 'base64')
}

export function hexEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

export function hexDecode(text: string): Uint8Array {
  const clean = text.replace(WHITESPACE, '')

  if (clean.length % 2 !== 0 || !HEX_DIGITS.test(clean))
    throw new Error('not valid hex')

  return Buffer.from(clean, 'hex')
}

export function htmlEncode(text: string): string {
  return text.replace(HTML_SPECIAL, char => HTML_ESCAPE[char]!)
}

export function htmlDecode(text: string): string {
  return text.replace(HTML_ENTITY, (match, hex?: string, dec?: string, named?: string) => {
    if (hex !== undefined) {
      const code = Number.parseInt(hex, 16)

      return code <= 0x10FFFF ? String.fromCodePoint(code) : match
    }

    if (dec !== undefined) {
      const code = Number.parseInt(dec, 10)

      return code <= 0x10FFFF ? String.fromCodePoint(code) : match
    }

    return HTML_UNESCAPE[named!.toLowerCase()] ?? match
  })
}

export function encodeValue(encoding: Encoding, bytes: Uint8Array): string {
  switch (encoding) {
    case 'b64':
      return b64Encode(bytes, false)
    case 'b64url':
      return b64Encode(bytes, true)
    case 'hex':
      return hexEncode(bytes)
    case 'url':
      return encodeURIComponent(new TextDecoder().decode(bytes))
    case 'html':
      return htmlEncode(new TextDecoder().decode(bytes))
  }
}

export function decodeValue(encoding: Encoding, text: string): Uint8Array {
  switch (encoding) {
    case 'b64':
    case 'b64url':
      return b64Decode(text)
    case 'hex':
      return hexDecode(text)
    case 'url': {
      try {
        return new TextEncoder().encode(decodeURIComponent(text))
      }
      catch {
        throw new Error('not valid URL-encoded text')
      }
    }
    case 'html':
      return new TextEncoder().encode(htmlDecode(text))
  }
}
