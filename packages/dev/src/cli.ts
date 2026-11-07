#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import type { Algorithm } from './hash'
import type { Format } from './password'
import process from 'node:process'
import { badUsage, copyText, fail, isStdinPiped, jsonOption, oneOf, paint, parse, printJson, runCli, wholeNumber } from '@kaynooo/cli-kit'
import { b64Decode, b64Encode } from './encode'
import { ALGORITHMS, hashHex } from './hash'
import { ulid, uuidV4, uuidV7 } from './ids'
import { publicIp } from './ip'
import { claimTimes, decodeJwt } from './jwt'
import { bcryptHash, DEFAULT_LENGTH, FORMATS, generatePassword } from './password'
import { convert } from './ts'
import { urlParts } from './url'

const MAX_PASSWORD_BYTES = 65_536

const ZONE_OPTION = { type: 'string', description: 'the IANA zone of the local dates, such as Europe/Paris (default: this host\'s)' } as const

// Runs a pure function, ending the command with exit 1 and its message when the input is not what it reads.
function reading<T>(read: () => T): T {
  try {
    return read()
  }
  catch (error) {
    return fail(error instanceof Error ? error.message : String(error), 1)
  }
}

function zoneOf(zone: string | undefined): string | undefined {
  if (zone === undefined)
    return undefined

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0)
  }
  catch {
    badUsage(`--zone takes an IANA zone such as Europe/Paris, not ${zone}`)
  }

  return zone
}

async function textInput(argument: string | undefined, what: string): Promise<string> {
  if (argument !== undefined)
    return argument

  return !isStdinPiped() ? fail(`give ${what} as an argument or pipe it on stdin`, 2) : Bun.stdin.text()
}

async function bytesInput(argument: string | undefined, what: string): Promise<Uint8Array> {
  if (argument !== undefined)
    return new TextEncoder().encode(argument)

  if (!isStdinPiped())
    return fail(`give ${what} as an argument or pipe it on stdin`, 2)

  return new Uint8Array(await Bun.stdin.arrayBuffer())
}

function printRows(rows: [label: string, value: string][]): void {
  const { cyan } = paint(process.stdout)
  const width = Math.max(...rows.map(([label]) => label.length))

  for (const [label, value] of rows)
    console.log(`${cyan(label.padEnd(width))}  ${value}`)
}

const PASSWORD_USAGE = `dev password [length] [format] [-b|--bcrypt [password]]: a random password of <length> bytes (default ${DEFAULT_LENGTH}) as hex, base64 (default) or base64url

Printed on stdout and copied to the clipboard when a tool for it (wl-copy, xclip, xsel, pbcopy) exists (the copy is said on stderr). With --bcrypt it is the bcrypt hash (cost 10) that prints: of the password given, or of a generated one, which then prints on stderr and is the one copied. Bun writes bcrypt as $2b$, the hash prints with the $2y$ prefix htpasswd -B writes, the one Apache, nginx and traefik basic auth all accept.`

const PASSWORD_EXITS: ExitRow[] = [[0, 'it printed the password or hash'], [2, 'a usage error']]

const PASSWORD_OPTIONS = {
  'bcrypt': { type: 'string', short: 'b', optional: { bare: '' }, description: 'print the bcrypt hash of the password given, or of a generated one' },
  'no-copy': { type: 'boolean', description: 'leave the clipboard alone' },
  'json': jsonOption('{password?, hash?, format, bytes, copied}'),
} as const

const FORMAT_NOTES: Record<Format, string> = { hex: 'hexadecimal', base64: 'base64', base64url: 'url-safe base64' }

export async function password(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, PASSWORD_USAGE, PASSWORD_OPTIONS, {
    exits: PASSWORD_EXITS,
    positionals: ['[length]', '[format]'],
    candidates: { '[length]': () => ['16', '24', '32', '48', '64'], '[format]': () => FORMATS.map((format): [string, string] => [format, FORMAT_NOTES[format]]) },
    replaces: 'openssl rand -base64 32 and htpasswd -bnBC 10 "" <password>',
    examples: ['dev password', ['dev password 16 hex', '16 random bytes as 32 hex characters'], ['dev password --bcrypt hunter2', 'the hash to paste into a basic auth file']],
  })
  const bytes = wholeNumber(positionals[0], '<length>', DEFAULT_LENGTH)
  const format = oneOf(positionals[1] ?? 'base64', '<format>', FORMATS)

  if (bytes > MAX_PASSWORD_BYTES)
    badUsage(`<length> takes at most ${MAX_PASSWORD_BYTES}, not ${bytes}`)

  const given = values.bcrypt === undefined || values.bcrypt === '' ? undefined : values.bcrypt
  const secret = given ?? generatePassword(bytes, format)
  const hash = values.bcrypt === undefined ? undefined : await bcryptHash(secret)
  const copied = values['no-copy'] === true ? false : await copyText(given === undefined ? secret : hash ?? secret)

  if (values.json === true) {
    printJson({ ...hash === undefined ? {} : { hash }, ...given === undefined ? { password: secret } : {}, format, bytes, copied })

    return 0
  }

  if (copied)
    console.error(paint(process.stderr).dim('copied to clipboard'))

  if (hash !== undefined && given === undefined)
    console.error(secret)

  console.log(hash ?? secret)

  return 0
}

const JWT_USAGE = `dev jwt [token]: the header and payload of a JWT, with iat, nbf and exp as local and UTC dates and how far from now

The token is the argument or what is piped on stdin, a leading "Bearer " is ignored. The signature is not verified.`

const JWT_EXITS: ExitRow[] = [[0, 'it decoded the token'], [1, 'it is not a JWT'], [2, 'a usage error']]

const JWT_OPTIONS = {
  zone: ZONE_OPTION,
  json: jsonOption('{header, payload, claims: [{claim, epoch, local, utc, relative}], signatureBytes}'),
} as const

export async function jwt(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, JWT_USAGE, JWT_OPTIONS, {
    exits: JWT_EXITS,
    positionals: ['[token]'],
    replaces: 'pasting a token into jwt.io or decoding its segments with base64 and jq',
    examples: ['dev jwt eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3MDAwMDAwMDB9.c2ln', ['pbpaste | dev jwt --json', 'for a script']],
  })
  const zone = zoneOf(values.zone)
  const token = await textInput(positionals[0], 'the token')
  const decoded = reading(() => decodeJwt(token))
  const claims = claimTimes(decoded.payload, Date.now(), zone)

  if (values.json === true) {
    printJson({ header: decoded.header, payload: decoded.payload, claims, signatureBytes: decoded.signatureBytes })

    return 0
  }

  const { bold } = paint(process.stdout)

  console.log(`${bold('header')}\n${JSON.stringify(decoded.header, null, 2)}\n\n${bold('payload')}\n${JSON.stringify(decoded.payload, null, 2)}`)

  if (claims.length > 0) {
    console.log('')
    printRows(claims.map(({ claim, local, utc, relative }) => [claim, `${local}  ${utc}  ${relative}`]))
  }

  return 0
}

const TS_USAGE = `dev ts [value]: a time as local and UTC dates, whatever it is written as

The value is epoch seconds or milliseconds (told apart by size: from 1e11 up it is milliseconds), an ISO date or date-time (read in the local zone when it gives none), or a duration such as 90m or 2h30m, shown with the date that far from now. Without a value it is now; "-" reads the value on stdin.`

const TS_EXITS: ExitRow[] = [[0, 'it converted the value'], [1, 'it is none of those'], [2, 'a usage error']]

const TS_OPTIONS = {
  zone: ZONE_OPTION,
  json: jsonOption('{kind, ms, seconds, local, utc, relative} or, for a duration, {kind, ms, seconds, human, fromNow}'),
} as const

export async function ts(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, TS_USAGE, TS_OPTIONS, {
    exits: TS_EXITS,
    positionals: ['[value]'],
    replaces: 'date -d @<seconds> and date -u, and doing the milliseconds division by hand',
    examples: ['dev ts 1700000000', ['dev ts 2h30m', 'the date 2h30m from now'], ['dev ts 2024-05-06T08:09:10Z --zone Europe/Paris', 'that instant in Paris']],
  })
  const zone = zoneOf(values.zone)
  const value = positionals[0] === '-' ? await textInput(undefined, 'the value') : positionals[0]
  const converted = reading(() => convert(value, { timeZone: zone }))

  if (values.json === true) {
    printJson(converted)

    return 0
  }

  if (converted.kind === 'duration') {
    printRows([['human', converted.human], ['seconds', String(converted.seconds)], ['ms', String(converted.ms)], ['from now', `${converted.fromNow.local}  ${converted.fromNow.utc}`]])

    return 0
  }

  printRows([['local', converted.local], ['utc', converted.utc], ['seconds', String(converted.seconds)], ['ms', String(converted.ms)], ['relative', converted.relative]])

  return 0
}

const UUID_USAGE = `dev uuid [-n <count>] [--v7]: random UUIDs, version 4 or, with --v7, version 7 (time-ordered)`

const UUID_EXITS: ExitRow[] = [[0, 'it printed them'], [2, 'a usage error']]

const COUNT_OPTION = { type: 'string', short: 'n', description: 'how many to print (default 1)' } as const

export function uuid(args: string[]): number {
  const { values } = parse(args, UUID_USAGE, { n: COUNT_OPTION, v7: { type: 'boolean', description: 'a version 7 UUID, which sorts by creation time' }, json: jsonOption('["uuid"]') }, {
    exits: UUID_EXITS,
    positionals: [],
    replaces: 'uuidgen and python -c "import uuid"',
    examples: ['dev uuid', ['dev uuid -n 5 --v7', 'five time-ordered UUIDs']],
  })
  const ids = Array.from({ length: wholeNumber(values.n, 'n', 1) }, () => values.v7 === true ? uuidV7() : uuidV4())

  printIds(ids, values.json === true)

  return 0
}

const ULID_USAGE = `dev ulid [-n <count>]: random ULIDs, 26 sortable characters of time and randomness`

const ULID_EXITS: ExitRow[] = [[0, 'it printed them'], [2, 'a usage error']]

export function ulidCommand(args: string[]): number {
  const { values } = parse(args, ULID_USAGE, { n: COUNT_OPTION, json: jsonOption('["ulid"]') }, {
    exits: ULID_EXITS,
    positionals: [],
    replaces: 'installing a ulid package to mint one',
    examples: ['dev ulid', ['dev ulid -n 3', 'three ULIDs']],
  })

  printIds(Array.from({ length: wholeNumber(values.n, 'n', 1) }, () => ulid()), values.json === true)

  return 0
}

function printIds(ids: string[], json: boolean): void {
  if (json)
    printJson(ids)
  else
    console.log(ids.join('\n'))
}

const B64_USAGE = `dev b64 [-d] [--url] [text]: base64 of the text, or with -d the text behind a base64 one

The text is the argument or what is piped on stdin, taken as is (a piped trailing newline is encoded, as base64 does). With --url the output is URL-safe and unpadded. Decoding takes either alphabet, padded or not, and writes the raw bytes.`

const B64_EXITS: ExitRow[] = [[0, 'it printed the result'], [1, '-d is given text that is not base64'], [2, 'a usage error']]

const B64_OPTIONS = {
  decode: { type: 'boolean', short: 'd', description: 'decode instead of encode' },
  url: { type: 'boolean', description: 'URL-safe alphabet without padding, when encoding' },
  json: jsonOption('{input, output} as text'),
} as const

export async function b64(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, B64_USAGE, B64_OPTIONS, {
    exits: B64_EXITS,
    positionals: ['[text]'],
    replaces: 'base64 and base64 -d, which leave the URL-safe alphabet to tr',
    examples: ['dev b64 hello', ['echo aGVsbG8 | dev b64 -d', 'decoded, padding optional']],
  })
  const input = await bytesInput(positionals[0], 'the text')

  if (values.decode === true) {
    const output = reading(() => b64Decode(new TextDecoder().decode(input)))

    if (values.json === true)
      printJson({ input: new TextDecoder().decode(input), output: new TextDecoder().decode(output) })
    else
      await Bun.write(Bun.stdout, output)

    return 0
  }

  const output = b64Encode(input, values.url === true)

  if (values.json === true)
    printJson({ input: new TextDecoder().decode(input), output })
  else
    console.log(output)

  return 0
}

const URL_USAGE = `dev url [url]: the parts of a URL and its query decoded, one per line

The URL is the argument or what is piped on stdin, and has to include its scheme.`

const URL_EXITS: ExitRow[] = [[0, 'it printed the parts'], [1, 'the text is not a URL'], [2, 'a usage error']]

export async function url(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, URL_USAGE, { json: jsonOption('{href, protocol, username, password, host, hostname, port, pathname, query: [{key, value}], hash}') }, {
    exits: URL_EXITS,
    positionals: ['[url]'],
    replaces: 'reading a long query string by eye or decoding it with python urllib',
    examples: ['dev url "https://example.com:8443/a%20b?q=x%26y&page=2#top"', ['dev url "https://example.com/?a=1" --json', 'for a script']],
  })
  const input = await textInput(positionals[0], 'the URL')
  const parts = reading(() => urlParts(input))

  if (values.json === true) {
    printJson(parts)

    return 0
  }

  const { query, ...fields } = parts
  const shown = Object.entries(fields).filter(([, value]) => value !== '')

  printRows([...shown, ...query.map(({ key, value }): [string, string] => [`?${key}`, value])])

  return 0
}

const HASH_USAGE = `dev hash <sha256|sha1|md5|sha512> [file]: the hex digest of a file, or of what is piped on stdin`

const HASH_EXITS: ExitRow[] = [[0, 'it printed the digest'], [1, 'the file does not exist'], [2, 'a usage error']]

export async function hash(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, HASH_USAGE, { json: jsonOption('{algorithm, hash, bytes}') }, {
    exits: HASH_EXITS,
    positionals: ['<algorithm>', '[file]'],
    candidates: { '<algorithm>': () => [...ALGORITHMS] },
    replaces: 'sha256sum, sha1sum and md5sum, which print the file name beside the digest',
    examples: ['dev hash sha256 package.json', ['echo -n abc | dev hash sha1', 'the digest of piped text']],
  })
  const algorithm: Algorithm = oneOf(positionals[0] ?? '', '<algorithm>', ALGORITHMS)
  const file = positionals[1]
  let bytes: Uint8Array

  if (file === undefined) {
    bytes = await bytesInput(undefined, 'a file')
  }
  else {
    const source = Bun.file(file)

    if (!await source.exists())
      return fail(`no file ${file}`, 1)

    bytes = new Uint8Array(await source.arrayBuffer())
  }

  const digest = hashHex(algorithm, bytes)

  if (values.json === true)
    printJson({ algorithm, hash: digest, bytes: bytes.length })
  else
    console.log(digest)

  return 0
}

const IP_USAGE = `dev ip [-4|-6]: the public IP address of this host, as a web service sees it

-4 or -6 asks over that IP family only, which fails when the host has no route over it.`

const IP_EXITS: ExitRow[] = [[0, 'it printed the address'], [1, 'the service could not be reached'], [2, 'a usage error']]

export async function ip(args: string[]): Promise<number> {
  const { values } = parse(args, IP_USAGE, { 4: { type: 'boolean', short: '4', description: 'over IPv4 only' }, 6: { type: 'boolean', short: '6', description: 'over IPv6 only' }, json: jsonOption('{ip, family?}') }, {
    exits: IP_EXITS,
    replaces: 'curl https://ipecho.net/plain typed from memory',
    examples: ['dev ip', ['dev ip -6', 'the IPv6 address']],
  })

  if (values[4] === true && values[6] === true)
    badUsage('-4 and -6 cannot be combined')

  let family: 4 | 6 | undefined

  if (values[4] === true)
    family = 4
  else if (values[6] === true)
    family = 6

  try {
    const address = await publicIp(family)

    if (values.json === true)
      printJson(family === undefined ? { ip: address } : { ip: address, family })
    else
      console.log(address)

    return 0
  }
  catch (error) {
    return fail(`could not read the public address: ${error instanceof Error ? error.message : String(error)}`, 1)
  }
}

if (import.meta.main) {
  process.exitCode = await runCli({
    name: 'dev',
    about: 'small developer utilities: passwords and bcrypt hashes, JWTs, timestamps, UUIDs, base64, URLs and file hashes',
    replaces: 'openssl rand, htpasswd, jwt.io, date -d, uuidgen, base64, sha256sum and one-off scripts for each',
    examples: ['dev password', ['dev jwt <token>', 'header, payload and expiry'], ['dev ts 1700000000', 'an epoch as dates']],
    commands: {
      password: { summary: 'a random password, copied to the clipboard, or its bcrypt hash', run: password },
      jwt: { summary: 'decode a JWT without verifying it, expiry shown as dates', run: jwt },
      ts: { summary: 'convert epochs, ISO dates and durations, local and UTC', run: ts },
      uuid: { summary: 'random UUIDs, v4 or v7', run: async args => Promise.resolve(uuid(args)) },
      ulid: { summary: 'random ULIDs', run: async args => Promise.resolve(ulidCommand(args)) },
      b64: { summary: 'base64 encode or decode, standard or URL-safe', run: b64 },
      url: { summary: 'the parts of a URL and its decoded query', run: url },
      hash: { summary: 'sha256, sha1, md5 or sha512 of a file or stdin', run: hash },
      ip: { summary: 'the public IP address of this host, IPv4 or IPv6', run: ip },
    },
  })
}
