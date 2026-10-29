export const MASK = '***'

const SENSITIVE: [string, RegExp][] = [
  ['email', /e[-_]?mail/i],
  ['phone', /phone|mobile|msisdn|^tel(?:_|$)|_tel$/i],
  ['secret', /token|secret|api[-_]?key|credential|private[-_]?key|otp/i],
  ['password', /pass(?:word|wd)|^pass$|_pass$|pwd|hash|salt/i],
]

const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi

// What a column holds that is masked by default, from its name.
export function sensitiveKind(column: string): string | undefined {
  return SENSITIVE.find(([, pattern]) => pattern.test(column))?.[0]
}

export function maskRows(rows: Record<string, unknown>[], raw: boolean): { rows: Record<string, unknown>[], masked: string[] } {
  const masked = raw ? [] : Object.keys(rows[0] ?? {}).filter(column => sensitiveKind(column) !== undefined)

  if (masked.length === 0)
    return { rows, masked }

  return {
    masked,
    rows: rows.map(row => Object.fromEntries(Object.entries(row).map(([column, value]) => [column, masked.includes(column) && value !== null ? MASK : value]))),
  }
}

// Removes the connection URL, its password and any scheme://user:password@ pair from text about to be printed.
export function scrub(text: string, url: string | undefined): string {
  let clean = text

  if (url !== undefined && url !== '') {
    clean = clean.replaceAll(url, '<url>')

    for (const secret of secrets(url))
      clean = clean.replaceAll(secret, MASK)
  }

  return clean.replace(URL_CREDENTIALS, '$1<credentials>@')
}

function secrets(url: string): string[] {
  try {
    const { password, username } = new URL(url)

    return [...new Set([password, decode(password), decode(username)].filter(secret => secret.length > 3))]
  }
  catch {
    return []
  }
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text)
  }
  catch {
    return text
  }
}
