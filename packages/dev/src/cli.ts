#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import type { Encoding } from './encode'
import type { Algorithm } from './hash'
import type { Format } from './password'
import process from 'node:process'
import { badUsage, copyOption, copyText, fail, isInteractive, isStdinPiped, jsonOption, oneOf, paint, parse, printJson, runCli, wholeNumber } from '@kaynooo/cli-kit'
import { input } from '@kaynooo/cli-kit/prompt'
import { CONVERT_FORMATS, formatStructured, normalizeFormat, parseStructured } from './convert'
import { evaluateCron } from './cron'
import { decodeValue, encodeValue, ENCODINGS } from './encode'
import { ALGORITHMS, hashHex, hashStream } from './hash'
import { hexId, monotonic, nextUlid, nextUuidV7, ulid, uuidV4, uuidV7 } from './ids'
import { claimTimes, decodeJwt } from './jwt'
import { BCRYPT_MAX_BYTES, bcryptHash, DEFAULT_LENGTH, FORMATS, generatePassword } from './password'
import { convert } from './ts'
import { urlParts } from './url'

const MAX_PASSWORD_BYTES = 65_536
const TRAILING_NEWLINE = /\r?\n$/
// What --bcrypt takes as its value: - or anything that is not another option.
const STDIN_OR_VALUE = /^(?!-.)/

const ZONE_OPTION = { type: 'string', description: 'the IANA zone of the local dates, such as Europe/Paris (default: this host\'s)' } as const
const COUNT_OPTION = { type: 'string', short: 'n', description: 'how many to print (default 1)' } as const

const ID_KINDS = ['uuid', 'v7', 'ulid', 'hex'] as const

type IdKind = (typeof ID_KINDS)[number]

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

// A secret kept out of the command line: asked for masked on a terminal, read from stdin otherwise.
async function secretInput(what: string): Promise<string> {
  if (isInteractive())
    return await input(what, { mask: true, hint: `pipe ${what} on stdin` }) ?? fail('cancelled', 130)

  return (await textInput(undefined, what)).replace(TRAILING_NEWLINE, '')
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

const PASSWORD_USAGE = `dev password [length] [format] [-b|--bcrypt [password]] [--copy]: a random password of <length> bytes (default ${DEFAULT_LENGTH}) as hex, base64 (default) or base64url

Printed on stdout, and copied with --copy. With --bcrypt the bcrypt hash (cost 10) prints, of the password given (- asks for it masked on a terminal, or reads stdin, keeping it out of the shell history) or of a generated one, which prints on stderr and is the one --copy copies. The hash has the $2y$ prefix htpasswd -B writes; a password over 72 bytes, all bcrypt reads, is refused.`

const PASSWORD_EXITS: ExitRow[] = [[0, 'it printed the password or hash'], [2, 'a usage error'], [130, 'the prompt was cancelled']]

const PASSWORD_OPTIONS = {
  bcrypt: { type: 'string', short: 'b', optional: { bare: '', accepts: STDIN_OR_VALUE }, description: 'print the bcrypt hash of the password given, or of a generated one' },
  copy: copyOption('the password, or the hash of a password given'),
  json: jsonOption('{password?, hash?, format, bytes, copied}'),
} as const

const FORMAT_NOTES: Record<Format, string> = { hex: 'hexadecimal', base64: 'base64', base64url: 'url-safe base64' }

export async function password(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, PASSWORD_USAGE, PASSWORD_OPTIONS, {
    exits: PASSWORD_EXITS,
    positionals: ['[length]', '[format]'],
    candidates: { '[length]': () => ['16', '24', '32', '48', '64'], '[format]': () => FORMATS.map((format): [string, string] => [format, FORMAT_NOTES[format]]) },
    replaces: 'openssl rand -base64 32 and htpasswd -bnBC 10 "" <password>',
    examples: ['dev password', ['dev password 16 hex', '16 random bytes as 32 hex characters'], ['dev password --bcrypt -', 'asks for a password and prints the hash to paste into a basic auth file']],
  })
  const bytes = wholeNumber(positionals[0], '<length>', DEFAULT_LENGTH)
  const format = oneOf(positionals[1] ?? 'base64', '<format>', FORMATS)

  if (bytes > MAX_PASSWORD_BYTES)
    badUsage(`<length> takes at most ${MAX_PASSWORD_BYTES}, not ${bytes}`)

  const bcrypt = values.bcrypt === '' ? undefined : values.bcrypt
  const given = bcrypt === '-' ? await secretInput('the password') : bcrypt
  const secret = given ?? generatePassword(bytes, format)

  if (values.bcrypt !== undefined && Buffer.byteLength(secret) > BCRYPT_MAX_BYTES)
    badUsage(`bcrypt takes a password of at most ${BCRYPT_MAX_BYTES} bytes, this one has ${Buffer.byteLength(secret)}${given === undefined ? `: ${bytes} bytes as ${format} is too long, pick a smaller <length>` : ''}`)

  const hash = values.bcrypt === undefined ? undefined : await bcryptHash(secret)
  const copied = values.copy === true && await copyText(given === undefined ? secret : hash ?? secret)

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

The token is the argument, what is piped on stdin, or asked for masked on a terminal; a leading "Bearer " is ignored. The signature is not verified.`

const JWT_EXITS: ExitRow[] = [[0, 'it decoded the token'], [1, 'it is not a JWT'], [2, 'a usage error'], [130, 'the prompt was cancelled']]

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
  const token = positionals[0] ?? await secretInput('the token')
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
    printRows(claims.map(({ claim, local, utc, relative }) => [claim, [local, utc, relative].filter(Boolean).join('  ')]))
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

const ID_USAGE = `dev id [uuid|v7|ulid|hex] [-n <count>] [--bytes <n>]: mint random or time-ordered identifiers

Defaults to uuid (version 4). v7 and ulid are time-ordered and monotonic within a batch; hex prints random lowercase hex (16 bytes by default, override with --bytes).`

const ID_EXITS: ExitRow[] = [[0, 'it printed them'], [2, 'a usage error']]

export function id(args: string[]): number {
  const { values, positionals } = parse(args, ID_USAGE, {
    n: COUNT_OPTION,
    bytes: { type: 'string', description: 'byte length for hex IDs (default 16)' },
    json: jsonOption('["id"]'),
  }, {
    exits: ID_EXITS,
    positionals: ['[kind]'],
    candidates: { '[kind]': () => [...ID_KINDS] },
    replaces: 'uuidgen, python uuid, ulid packages and openssl rand -hex',
    examples: ['dev id', ['dev id v7 -n 5', 'five time-ordered UUID v7s'], ['dev id ulid -n 3', 'three ULIDs'], ['dev id hex --bytes 8', 'a 16-char hex ID']],
  })
  const kind: IdKind = oneOf(positionals[0] ?? 'uuid', '<kind>', ID_KINDS)
  const count = wholeNumber(values.n, 'n', 1)
  const bytes = wholeNumber(values.bytes, 'bytes', 16)

  if (values.bytes !== undefined && kind !== 'hex')
    badUsage('--bytes only goes with hex')

  let ids: string[]

  if (kind === 'uuid')
    ids = Array.from({ length: count }, uuidV4)
  else if (kind === 'v7')
    ids = monotonic(count, now => uuidV7(now), nextUuidV7)
  else if (kind === 'ulid')
    ids = monotonic(count, now => ulid(now), nextUlid)
  else
    ids = Array.from({ length: count }, () => hexId(bytes))

  if (values.json === true)
    printJson(ids)
  else
    console.log(ids.join('\n'))

  return 0
}

const ENC_USAGE = `dev enc <b64|b64url|hex|url|html> [text]: encodes the argument or stdin as base64, base64url, hex, URL-encoded or HTML-escaped text

Stdin is encoded verbatim (a trailing newline is included, as base64 does).`

const ENC_EXITS: ExitRow[] = [[0, 'it printed the encoded text'], [2, 'a usage error']]

export async function enc(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, ENC_USAGE, { json: jsonOption('{encoding, input, output}') }, {
    exits: ENC_EXITS,
    positionals: ['<encoding>', '[text]'],
    candidates: { '<encoding>': () => [...ENCODINGS] },
    replaces: 'base64, xxd -p, python urllib.parse.quote and html.escape',
    examples: ['dev enc b64 hello', 'dev enc b64url hello', 'dev enc hex hello', 'dev enc url "a b&c"', 'dev enc html "<a>"'],
  })
  const encoding: Encoding = oneOf(positionals[0] ?? '', '<encoding>', ENCODINGS)
  const raw = await bytesInput(positionals[1], 'the text')
  const output = encodeValue(encoding, raw)

  if (values.json === true)
    printJson({ encoding, input: new TextDecoder().decode(raw), output })
  else
    console.log(output)

  return 0
}

const DEC_USAGE = `dev dec <b64|b64url|hex|url|html> [text]: decodes base64, base64url, hex, URL-encoded or HTML-escaped text

Binary encodings (b64, b64url, hex) write the raw decoded bytes on stdout; text encodings (url, html) write the decoded UTF-8 text.`

const DEC_EXITS: ExitRow[] = [[0, 'it printed the decoded output'], [1, 'the input is not valid for that encoding'], [2, 'a usage error']]

export async function dec(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, DEC_USAGE, { json: jsonOption('{encoding, input, output}') }, {
    exits: DEC_EXITS,
    positionals: ['<encoding>', '[text]'],
    candidates: { '<encoding>': () => [...ENCODINGS] },
    replaces: 'base64 -d, xxd -r -p, python urllib.parse.unquote and html.unescape',
    examples: ['dev dec b64 aGVsbG8=', 'dev dec hex 68656c6c6f', 'dev dec url "a%20b%26c"', 'dev dec html "&lt;a&gt;"'],
  })
  const encoding: Encoding = oneOf(positionals[0] ?? '', '<encoding>', ENCODINGS)
  const raw = await bytesInput(positionals[1], 'the text')
  const inputText = new TextDecoder().decode(raw)
  const output = reading(() => decodeValue(encoding, inputText))

  if (values.json === true)
    printJson({ encoding, input: inputText, output: new TextDecoder().decode(output) })
  else
    await Bun.write(Bun.stdout, output)

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
  let result: { digest: string, bytes: number }

  if (file === undefined) {
    const input = await bytesInput(undefined, 'a file')

    result = { digest: hashHex(algorithm, input), bytes: input.length }
  }
  else {
    const source = Bun.file(file)

    if (!await source.exists())
      return fail(`no file ${file}`, 1)

    result = await hashStream(algorithm, source.stream())
  }

  const digest = result.digest

  if (values.json === true)
    printJson({ algorithm, hash: digest, bytes: result.bytes })
  else
    console.log(digest)

  return 0
}

const CRON_USAGE = `dev cron <expression> [-n <count>] [--zone <iana>]: explains a 5-field cron schedule (or @macro) and lists its next run times`

const CRON_EXITS: ExitRow[] = [[0, 'it explained the schedule'], [1, 'the cron expression is invalid'], [2, 'a usage error']]

export function cron(args: string[]): number {
  const { values, positionals } = parse(args, CRON_USAGE, {
    n: { type: 'string', short: 'n', description: 'how many upcoming runs to show (default 5)' },
    zone: ZONE_OPTION,
    json: jsonOption('{expression, normalized, description, next: [{iso, local, utc}]}'),
  }, {
    exits: CRON_EXITS,
    positionals: ['<expression>'],
    replaces: 'opening crontab.guru to check a schedule',
    examples: ['dev cron "*/15 * * * *"', ['dev cron "30 9 * * 1-5" --zone Europe/Paris', 'weekdays at 09:30 Paris time'], 'dev cron @daily'],
  })
  const count = wholeNumber(values.n, 'n', 5)
  const zone = zoneOf(values.zone)
  const schedule = reading(() => evaluateCron(positionals[0], count, Date.now(), zone))

  if (values.json === true) {
    printJson(schedule)

    return 0
  }

  const rows: [string, string][] = [
    ['schedule', schedule.description],
    ...schedule.normalized === schedule.expression ? [] : [['expanded', schedule.normalized] as [string, string]],
    ...schedule.next.map((run, index): [string, string] => [index === 0 ? 'next' : '', `${run.local}  (${run.utc})`]),
  ]

  printRows(rows)

  return 0
}

const CONVERT_USAGE = `dev convert <from> <to> [file]: converts structured data between json, yaml and toml

Reads [file] (or - / piped stdin). Accepts yml as an alias for yaml and JSONC comments when reading json.`

const CONVERT_EXITS: ExitRow[] = [[0, 'it printed the converted document'], [1, 'the input could not be parsed or represented in the target format'], [2, 'a usage error']]

export async function convertCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, CONVERT_USAGE, {
    compact: { type: 'boolean', description: 'single-line output when converting to json' },
    json: jsonOption('{from, to, output}'),
  }, {
    exits: CONVERT_EXITS,
    positionals: ['<from>', '<to>', '[file]'],
    candidates: { '<from>': () => [...CONVERT_FORMATS], '<to>': () => [...CONVERT_FORMATS] },
    replaces: 'yq, dasel and one-off python scripts to convert JSON, YAML and TOML',
    examples: ['dev convert yaml json config.yml', 'dev convert json toml package.json', 'cat Cargo.toml | dev convert toml json'],
  })
  const from = normalizeFormat(positionals[0] ?? '') ?? badUsage(`<from> takes one of ${CONVERT_FORMATS.join(', ')}, not ${positionals[0]}`)
  const to = normalizeFormat(positionals[1] ?? '') ?? badUsage(`<to> takes one of ${CONVERT_FORMATS.join(', ')}, not ${positionals[1]}`)
  const file = positionals[2]
  let raw: string

  if (file === undefined || file === '-') {
    raw = await textInput(undefined, 'the input')
  }
  else {
    const source = Bun.file(file)

    if (!await source.exists())
      return fail(`no file ${file}`, 1)

    raw = await source.text()
  }

  const output = reading(() => formatStructured(to, parseStructured(from, raw), values.compact === true))

  if (values.json === true)
    printJson({ from, to, output })
  else
    console.log(output)

  return 0
}

if (import.meta.main) {
  process.exitCode = await runCli({
    name: 'dev',
    about: 'small developer utilities: passwords and bcrypt hashes, JWTs, timestamps, IDs, encodings, URLs, file hashes, cron schedules and JSON/YAML/TOML conversion',
    replaces: 'openssl rand, htpasswd, jwt.io, date -d, uuidgen, base64, sha256sum, crontab.guru, yq and one-off scripts for each',
    examples: ['dev password', ['dev jwt <token>', 'header, payload and expiry'], ['dev ts 1700000000', 'an epoch as dates'], ['dev id v7', 'time-ordered UUID'], ['dev enc b64url hello', 'URL-safe base64'], ['dev cron "*/5 * * * *"', 'explain a cron schedule'], ['dev convert yaml json config.yml', 'convert YAML to JSON']],
    commands: {
      password: { summary: 'a random password, or its bcrypt hash', run: password },
      jwt: { summary: 'decode a JWT without verifying it, expiry shown as dates', run: jwt },
      ts: { summary: 'convert epochs, ISO dates and durations, local and UTC', run: ts },
      id: { summary: 'mint UUID (v4 or v7), ULID or random hex IDs', run: async args => Promise.resolve(id(args)) },
      enc: { summary: 'encode as b64, b64url, hex, url or html', run: enc },
      dec: { summary: 'decode b64, b64url, hex, url or html', run: dec },
      url: { summary: 'the parts of a URL and its decoded query', run: url },
      hash: { summary: 'sha256, sha1, md5 or sha512 of a file or stdin', run: hash },
      cron: { summary: 'explain a cron expression and list its next run times', run: async args => Promise.resolve(cron(args)) },
      convert: { summary: 'convert between json, yaml and toml', run: convertCommand },
    },
  })
}
