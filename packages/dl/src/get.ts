import type { ExitRow } from '@kaynooo/cli-kit'
import type { Downloaded } from './download'
import type { Resolved } from './release'
import type { Summary } from './script'
import type { Key } from './signature'
import type { LedgerEntry } from './state'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import process from 'node:process'
import { archiveSuffix, extractArchive } from '@kaynooo/cli-arc/src/extract.ts'
import { badUsage, escapeControls, fail, formatAge, formatSize, jsonOption, paint, parse, parseSize, printJson, table, truncate, warn } from '@kaynooo/cli-kit'
import { download } from './download'
import { binDir, binDirOnPath, installBinary, pickBinary } from './install'
import { assertReleaseOptions, parseSpec, resolveRelease } from './release'
import { summarize } from './script'
import { readKey, verifySignature } from './signature'
import { lastSeen, record, remember } from './state'
import { fetchSums, pathUnder, sumFor, sumIn } from './sums'

const USAGE = `dl [options] <url> [-- <script args>]: downloads a file into a new folder of its own, checks its sha256, then extracts it, installs it as a command or runs it as a script

<url> is an http or https URL, or a release: gh:owner/repo on GitHub, fj:owner/repo on git.kaynooo.fr, with @tag for one release. A release is the newest at least two weeks old unless --fresh; its asset the one built for this OS and arch, or the one --asset names; it is checked against the checksums file the release ships, else the sha256 the forge gives, and --key alone finds the signature beside it.
Without -o the file lands in a new folder under the temp folder. It prints where the file went, its size, final URL, type and sha256, and how it compares with the last download of the same URL (a changed text file shows its diff).
An HTML page arriving where a file was expected fails, as does a download over --max-size.
--sig checks a detached signature with --key: of the file, or of the checksums file when --sums names one. A gpg key is a fingerprint of your keyring or a key file, a minisign key its string or file, a cosign key its PEM file; the tool has to be on PATH.
--exec lists what the script does and runs it only when --sha256, --sums or --sig pins it, or with --yes; arguments after -- go to the script.
--bin and --exec record what they installed or ran in the ledger dl ls lists.`

const EXITS: ExitRow[] = [
  [0, 'downloaded, and extracted, installed or run as asked'],
  [1, 'an unreachable URL, an error status, a release with no asset for this machine, a sha256 mismatch, a signature that does not verify or a missing tool to check it, an HTML page in place of a file, a download over --max-size, a script nothing pins, or one that failed'],
  [2, 'a usage error'],
]

const OPTIONS = {
  'output': { type: 'string', short: 'o', description: 'the folder to download into, created if missing, instead of a new one under the temp folder' },
  'sha256': { type: 'string', description: 'the sha256 the file must have', conflicts: ['sums'] },
  'sums': { type: 'string', description: 'the URL of a checksums file (SHA256SUMS) giving the file\'s sha256' },
  'sig': { type: 'string', description: 'the URL of a detached signature of the file, or of the --sums file when there is one' },
  'key': { type: 'string', description: 'the key --sig is checked with: a gpg fingerprint or key file, a minisign key or key file, a cosign PEM file' },
  'extract': { type: 'boolean', short: 'x', description: 'unpack the archive into a new folder beside it' },
  'bin': { type: 'string', optional: { bare: '' }, description: 'install the file, or the one executable its archive holds, in ~/.local/bin, under the name given or its own', conflicts: ['exec'] },
  'force': { type: 'boolean', description: 'let --bin replace a command of the same name' },
  'exec': { type: 'boolean', description: 'run the file as a script, once --sha256, --sums or --sig pins it, or with --yes' },
  'yes': { type: 'boolean', description: 'run an --exec script that nothing pins' },
  'max-size': { type: 'string', description: 'the largest download taken, 2G by default' },
  'fresh': { type: 'boolean', description: 'take a release under two weeks old' },
  'asset': { type: 'string', description: 'the release asset to take, a part of its name or a glob, when the one for this machine cannot be told' },
  'json': jsonOption(),
} as const

const SHA256 = /^[0-9a-f]{64}$/i

export const DEFAULT_MAX_SIZE = '2G'
const HTML_EXTENSIONS = new Set(['', '.html', '.htm'])
// The width a script line is cut to in the summary.
const LINE_WIDTH = 120

interface Report {
  path: string
  size: number
  url: string
  type: string
  sha256: string
  verified: boolean
  signature?: string
  release?: string
  seen: string
  diff?: string
  extracted?: string
  installed?: string
  script?: Summary
}

export async function get(args: string[]): Promise<number> {
  const { values, positionals: [given], rest = [] } = parse(args, USAGE, OPTIONS, {
    positionals: ['<url>'],
    rest: true,
    exits: EXITS,
    replaces: 'curl -fsSL <url> | sh, curl -LO then sha256sum -c by hand, and unpacking a release to copy its binary into ~/.local/bin',
    examples: [
      ['dl https://bun.sh/install', 'download it to read it'],
      ['dl https://bun.sh/install --exec --sha256 <sha>', 'run the script that was read'],
      ['dl https://example.com/releases/tool-linux-amd64 --sums https://example.com/releases/SHA256SUMS --bin tool', 'a checked binary, installed'],
      ['dl https://example.com/tool.tar.gz -x', 'download and unpack'],
      ['dl https://example.com/tool.tar.gz --sums https://example.com/SHA256SUMS --sig https://example.com/SHA256SUMS.asc --key <fingerprint>', 'checked against checksums its publisher signed'],
      ['dl gh:BurntSushi/ripgrep --bin rg', 'the build of the latest release for this machine, installed'],
    ],
  })
  const spec = parseSpec(given)

  assertReleaseOptions(spec !== undefined, values)

  if (spec === undefined && (!URL.canParse(given) || !['http:', 'https:'].includes(new URL(given).protocol)))
    badUsage(`'${given}' is not an http or https URL, nor a release as gh:owner/repo or fj:owner/repo`)

  if (values.sha256 !== undefined && !SHA256.test(values.sha256))
    badUsage(`--sha256 takes 64 hex digits, not '${values.sha256}'`)

  if (values.yes === true && values.exec !== true)
    badUsage('--yes goes with --exec')

  if (values.force === true && values.bin === undefined)
    badUsage('--force goes with --bin')

  if (rest.length > 0 && values.exec !== true)
    badUsage('arguments after -- go to an --exec script')

  if (values.bin !== undefined && (values.bin.includes('/') || values.bin === '.' || values.bin === '..'))
    badUsage(`--bin takes a command name, not '${values.bin}'`)

  if (spec === undefined ? (values.sig === undefined) !== (values.key === undefined) : values.sig !== undefined && values.key === undefined)
    badUsage(spec === undefined ? '--sig and --key go together' : '--sig goes with --key')

  if (spec !== undefined && values.key !== undefined && values.sig === undefined && (values.sha256 !== undefined || values.sums !== undefined))
    badUsage('--key alone checks the release\'s own checksums file, which --sha256 and --sums replace: give --sig with it')

  if (values.sig !== undefined && (!URL.canParse(values.sig) || !['http:', 'https:'].includes(new URL(values.sig).protocol)))
    badUsage(`--sig takes an http or https URL, not '${values.sig}'`)

  const key = values.key === undefined ? undefined : readKey(values.key)
  const maxSize = parseSize(values['max-size'] ?? DEFAULT_MAX_SIZE) ?? badUsage(`--max-size takes a size such as 500M or 2G, not '${values['max-size']}'`)
  const release = spec === undefined ? undefined : await resolveRelease(spec, { fresh: values.fresh === true, asset: values.asset, key })
  const url = release?.asset.url ?? given
  // What the user gave wins over what the release ships
  const pinned = values.sha256 !== undefined || values.sums !== undefined
  const sums = values.sums ?? (pinned ? undefined : release?.sums)
  const digest = pinned ? undefined : release?.digest
  const sig = values.sig ?? release?.sig
  const created = values.output === undefined
  const dir = created ? mkdtempSync(join(tmpdir(), 'dl-')) : resolve(values.output!)

  mkdirSync(dir, { recursive: true })

  const expectsFile = release !== undefined || values.exec === true || values.bin !== undefined || values.extract === true
  const { file, verified, signature } = await fetchChecked(url, dir, created, { maxSize, expectsFile, sha256: values.sha256?.toLowerCase(), sums, digest, sig, key })

  if (release !== undefined && !verified)
    warn(`${release.spec} ${release.tag} ships no checksums file and its forge gives no sha256 of ${release.asset.name}, so nothing checked it`)

  const last = lastSeen(url)
  const report: Report = { path: file.path, size: file.size, url: file.url, type: file.type, sha256: file.sha256, verified, ...signature === undefined ? {} : { signature }, ...release === undefined ? {} : { release: releaseLine(release) }, seen: 'first download' }

  if (last !== undefined && last.seen.sha256 === file.sha256)
    report.seen = `same as the download of ${formatAge(last.seen.at)}`
  else if (last !== undefined)
    report.seen = `changed since the download of ${formatAge(last.seen.at)}, was ${last.seen.sha256.slice(0, 12)}`

  if (last?.content !== undefined && last.seen.sha256 !== file.sha256 && file.text)
    report.diff = await diff(last.content, file)

  remember(url, file)

  const extracted = values.extract === true || (values.bin !== undefined && archiveSuffix(file.name) !== undefined)

  if (extracted)
    report.extracted = await extract(file)

  if (values.bin !== undefined) {
    const source = report.extracted === undefined ? file.path : await pickBinary(report.extracted, values.bin === '' ? undefined : values.bin)
    const name = values.bin === '' ? basename(source) : values.bin

    report.installed = installBinary(source, name, values.force === true)
    record({ kind: 'bin', name, url, sha256: file.sha256, path: report.installed, at: new Date().toISOString(), ...release === undefined ? checkedBy(file, values) : fromRelease(release, values) })
  }

  if (values.exec === true)
    report.script = summarize(await Bun.file(file.path).text())

  print(report, given, values.json === true)

  if (values.exec !== true)
    return 0

  if (!verified && values.yes !== true)
    return fail('not run: no --sha256, --sums or --sig pins this script', 1, `read ${file.path}, then: dl ${url} --exec --sha256 ${file.sha256}`)

  return runScript(file, url, rest, checkedBy(file, values))
}

function releaseLine(release: Resolved): string {
  return `${release.spec} ${release.tag}, published ${formatAge(release.published)}, ${release.asset.name}`
}

// A release finds its checksums and signature again for the next version, so the ledger keeps the release and what picked its asset, and the key only.
function fromRelease(release: Resolved, values: { key?: string, asset?: string }): Partial<LedgerEntry> {
  const key = values.key !== undefined && existsSync(values.key) ? resolve(values.key) : values.key

  return { release: release.pinned ?? release.spec, version: release.tag, released: release.published, ...values.asset === undefined ? {} : { asset: values.asset }, ...key === undefined ? {} : { key } }
}

// How a download was checked and what tells it changed, for the ledger: `dl update` checks the next one the same way.
function checkedBy(file: Downloaded, values: { sums?: string, sig?: string, key?: string }): Partial<LedgerEntry> {
  const key = values.key !== undefined && existsSync(values.key) ? resolve(values.key) : values.key
  const fields = { sums: values.sums, sig: values.sig, key, etag: file.etag, lastModified: file.lastModified }

  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
}

interface Checks {
  maxSize: number
  expectsFile: boolean
  sha256: string | undefined
  sums: string | undefined
  // The sha256 a release's forge gives, checking the file when no checksums file does.
  digest: string | undefined
  sig: string | undefined
  key: Key | undefined
}

// The sha256 the checksums file gives the download. A release's may leave its asset out, and the forge's sha256 then checks it, unless a signature vouches for that checksums file alone.
function listedSum(sums: Uint8Array | undefined, checks: Checks, url: string, name: string, signed: boolean): string | undefined {
  if (sums === undefined)
    return undefined

  return checks.digest !== undefined && !signed ? sumFor(new TextDecoder().decode(sums), name, pathUnder(checks.sums!, url)) : sumIn(sums, checks.sums!, url, name)
}

// Downloads `url` and checks it is no HTML page where a file was expected, has the sha256 asked and carries the signature asked; on a failure the file goes, and the folder too when dl made it.
// With --sums the signature is the checksums file's, which then vouches for the sha256: how most projects sign their releases.
async function fetchChecked(url: string, dir: string, created: boolean, checks: Checks): Promise<{ file: Downloaded, verified: boolean, signature?: string }> {
  let file: Downloaded | undefined

  try {
    file = await download(url, dir, checks.maxSize)

    if (file.html && (checks.expectsFile || !HTML_EXTENSIONS.has(extname(file.name).toLowerCase())))
      fail(`${url} answered an HTML page, not a file`, 1)

    const sums = checks.sums === undefined ? undefined : await fetchSums(checks.sums)
    const signed = checks.sig === undefined || checks.key === undefined ? undefined : await verifySignature(sums ?? file.path, checks.sig, checks.key)
    const expected = checks.sha256 ?? listedSum(sums, checks, url, file.name, signed !== undefined) ?? checks.digest

    if (expected !== undefined && expected !== file.sha256)
      fail(`sha256 mismatch for ${file.name}: expected ${expected}, got ${file.sha256}; the file was deleted`, 1)

    return { file, verified: expected !== undefined || signed !== undefined, ...signed === undefined ? {} : { signature: signed } }
  }
  catch (error) {
    if (file !== undefined)
      rmSync(file.path, { force: true })

    if (created)
      rmSync(dir, { recursive: true, force: true })

    throw error
  }
}

// The changes from the last download kept as `last` to this one, under a `--- last` and `+++ <name>` header in place of git's paths.
async function diff(last: string, file: Downloaded): Promise<string> {
  if (Bun.which('git') === null)
    return ''

  const child = Bun.spawn(['git', 'diff', '--no-index', '--no-color', '--', last, file.path], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
  const lines = (await child.stdout.text()).trimEnd().split('\n')

  await child.exited

  const hunks = lines.findIndex(line => line.startsWith('@@'))

  return hunks === -1 ? '' : ['--- last', `+++ ${file.name}`, ...lines.slice(hunks)].join('\n')
}

// The diff with its control characters shown, coloured as git colours one when the terminal takes colours.
function coloredDiff(text: string): string {
  const colors = paint(process.stdout)

  return text.split('\n').map((raw, index) => {
    const line = escapeControls(raw)

    if (index < 2)
      return colors.bold(line)

    if (line.startsWith('@@'))
      return colors.cyan(line)

    if (line.startsWith('+'))
      return colors.green(line)

    return line.startsWith('-') ? colors.red(line) : line
  }).join('\n')
}

// Unpacks the archive into a new folder beside it named after it, so nothing already there is overwritten.
async function extract(file: Downloaded): Promise<string> {
  const suffix = archiveSuffix(file.name) ?? fail(`${file.name} is no archive arc can extract`, 1)
  const folder = join(file.path, '..', file.name.slice(0, -suffix.length) || 'extracted')

  if (existsSync(folder))
    return fail(`'${folder}' already exists`, 1)

  mkdirSync(folder)

  return await extractArchive(file.path, folder) !== 0 ? fail(`extracting ${file.name} failed`, 1) : folder
}

function print(report: Report, url: string, json: boolean): void {
  if (json) {
    printJson(report)

    return
  }

  const rows = [
    ['path', report.path],
    ['size', formatSize(report.size)],
    ...report.url === url ? [] : [['url', report.url]],
    ['type', report.type === '' ? '-' : report.type],
    ...report.release === undefined ? [] : [['release', report.release]],
    ['sha256', `${report.sha256}${report.verified ? ' verified' : ''}`],
    ...report.signature === undefined ? [] : [['signature', `${report.signature}, verified`]],
    ['seen', report.seen],
    ...report.extracted === undefined ? [] : [['extracted', report.extracted]],
    ...report.installed === undefined ? [] : [['installed', report.installed]],
    ...report.installed === undefined || binDirOnPath() ? [] : [['note', `${binDir()} is not on PATH`]],
  ]

  // A served file name, URL or script line could carry escapes that redraw what the reader trusts, so each control character shows as `cat -v` writes it.
  console.log(table(rows.map(([name = '', value = '']) => [name, escapeControls(value)])))

  if (report.diff !== undefined && report.diff !== '')
    console.log(`\n${coloredDiff(report.diff)}`)

  if (report.script === undefined)
    return

  const { findings, env } = report.script

  console.log(findings.length === 0 ? '\nscript: fetches, sudo, removes, profile, system and runs found nowhere' : `\nscript:\n${table(findings.map(({ line, does, text }) => [`line ${line}`, does, truncate(escapeControls(text), LINE_WIDTH)]))}`)

  if (env.length > 0)
    console.log(`reads: ${env.join(', ')}`)
}

// Runs the script by its shebang, or with sh without one, on the terminal, and records it in the ledger once it succeeds.
async function runScript(file: Downloaded, url: string, args: string[], checked: Partial<LedgerEntry>): Promise<number> {
  const shebang = (await Bun.file(file.path).text()).startsWith('#!')

  chmodSync(file.path, 0o700)

  const code = await Bun.spawn(shebang ? [file.path, ...args] : ['sh', file.path, ...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }).exited

  if (code !== 0)
    return fail(`the script exited ${code}`, 1)

  const { host, pathname } = new URL(url)

  record({ kind: 'script', name: `${host}${pathname}`, url, sha256: file.sha256, at: new Date().toISOString(), ...checked, ...args.length > 0 ? { args } : {} })

  return 0
}
