export interface UrlParts {
  href: string
  protocol: string
  username: string
  password: string
  host: string
  hostname: string
  port: string
  pathname: string
  query: { key: string, value: string }[]
  hash: string
}

const TRAILING_COLON = /:$/
const LEADING_HASH = /^#/

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  }
  catch {
    return value
  }
}

export function urlParts(text: string): UrlParts {
  let url: URL

  try {
    url = new URL(text.trim())
  }
  catch {
    throw new Error(`${text.trim()} is not a URL (include the scheme, as https://...)`)
  }

  return {
    href: url.href,
    protocol: url.protocol.replace(TRAILING_COLON, ''),
    username: decode(url.username),
    password: decode(url.password),
    host: url.host,
    hostname: url.hostname,
    port: url.port,
    pathname: decode(url.pathname),
    query: Array.from(url.searchParams, ([key, value]) => ({ key, value })),
    hash: decode(url.hash.replace(LEADING_HASH, '')),
  }
}
