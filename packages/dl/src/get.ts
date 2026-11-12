import type { ExitRow } from '@kaynooo/cli-kit'
import type { Downloaded } from './download'
import type { Summary } from './script'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import process from 'node:process'
import { archiveSuffix, extractArchive } from '@kaynooo/cli-arc/src/extract.ts'
import { badUsage, fail, formatAge, formatSize, jsonOption, parse, parseSize, printJson, table, takesControlCodes, truncate } from '@kaynooo/cli-kit'
import { download } from './download'
import { binDir, binDirOnPath, installBinary, pickBinary } from './install'
import { summarize } from './script'
import { lastSeen, record, remember } from './state'
import { fetchSum } from './sums'

const USAGE = `dl [options] <url> [-- <script args>]: downloads a file into a new folder of its own, checks its sha256, then extracts it, installs it as a command or runs it as a script

Without -o the file lands in a new folder under the temp folder. It prints where the file went, its size, final URL, type and sha256, and how it compares with the last download of the same URL (a changed text file shows its diff).
An HTML page arriving where a file was expected fails, as does a download over --max-size.
--exec lists what the script does and runs it only when --sha256 or --sums pins it, or with --yes; arguments after -- go to the script.
--bin and --exec record what they installed or ran in the ledger dl ls lists.`

const EXITS: ExitRow[] = [
  [0, 'downloaded, and extracted, installed or run as asked'],
  [1, 'an unreachable URL, an error status, a sha256 mismatch, an HTML page in place of a file, a download over --max-size, a script nothing pins, or one that failed'],
  [2, 'a usage error'],
]

const OPTIONS = {
  'output': { type: 'string', short: 'o', description: 'the folder to download into, created if missing, instead of a new one under the temp folder' },
  'sha256': { type: 'string', description: 'the sha256 the file must have', conflicts: ['sums'] },
  'sums': { type: 'string', description: 'the URL of a checksums file (SHA256SUMS) giving the file\'s sha256' },
  'extract': { type: 'boolean', short: 'x', description: 'unpack the archive into a new folder beside it' },
  'bin': { type: 'string', optional: { bare: '' }, description: 'install the file, or the one executable its archive holds, in ~/.local/bin, under the name given or its own', conflicts: ['exec'] },
  'force': { type: 'boolean', description: 'let --bin replace a command of the same name' },
  'exec': { type: 'boolean', description: 'run the file as a script, once --sha256 or --sums pins it, or with --yes' },
  'yes': { type: 'boolean', description: 'run an --exec script that nothing pins' },
  'max-size': { type: 'string', description: 'the largest download taken, 2G by default' },
  'json': jsonOption(),
} as const

const SHA256 = /^[0-9a-f]{64}$/i
const DEFAULT_MAX_SIZE = '2G'
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
  seen: string
  diff?: string
  extracted?: string
  installed?: string
  script?: Summary
}

export async function get(args: string[]): Promise<number> {
  const { values, positionals: [url], rest = [] } = parse(args, USAGE, OPTIONS, {
    positionals: ['<url>'],
    rest: true,
    exits: EXITS,
    replaces: 'curl -fsSL <url> | sh, curl -LO then sha256sum -c by hand, and unpacking a release to copy its binary into ~/.local/bin',
    examples: [
      ['dl https://bun.sh/install', 'download it to read it'],
      ['dl https://bun.sh/install --exec --sha256 <sha>', 'run the script that was read'],
      ['dl https://example.com/releases/tool-linux-amd64 --sums https://example.com/releases/SHA256SUMS --bin tool', 'a checked binary, installed'],
      ['dl https://example.com/tool.tar.gz -x', 'download and unpack'],
    ],
  })

  if (!URL.canParse(url) || !['http:', 'https:'].includes(new URL(url).protocol))
    badUsage(`'${url}' is not an http or https URL`)

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

  const maxSize = parseSize(values['max-size'] ?? DEFAULT_MAX_SIZE) ?? badUsage(`--max-size takes a size such as 500M or 2G, not '${values['max-size']}'`)
  const created = values.output === undefined
  const dir = created ? mkdtempSync(join(tmpdir(), 'dl-')) : resolve(values.output!)

  mkdirSync(dir, { recursive: true })

  const expectsFile = values.exec === true || values.bin !== undefined || values.extract === true
  const { file, verified } = await fetchChecked(url, dir, created, { maxSize, expectsFile, sha256: values.sha256?.toLowerCase(), sums: values.sums })
  const last = lastSeen(url)
  const report: Report = { path: file.path, size: file.size, url: file.url, type: file.type, sha256: file.sha256, verified, seen: 'first download' }

  if (last !== undefined && last.seen.sha256 === file.sha256)
    report.seen = `same as the download of ${formatAge(last.seen.at)}`
  else if (last !== undefined)
    report.seen = `changed since the download of ${formatAge(last.seen.at)}, was ${last.seen.sha256.slice(0, 12)}`

  if (last?.content !== undefined && last.seen.sha256 !== file.sha256 && file.text)
    report.diff = await diff(last.content, file, values.json !== true)

  remember(url, file)

  const extracted = values.extract === true || (values.bin !== undefined && archiveSuffix(file.name) !== undefined)

  if (extracted)
    report.extracted = await extract(file)

  if (values.bin !== undefined) {
    const source = report.extracted === undefined ? file.path : await pickBinary(report.extracted, values.bin === '' ? undefined : values.bin)
    const name = values.bin === '' ? basename(source) : values.bin

    report.installed = installBinary(source, name, values.force === true)
    record({ kind: 'bin', name, url, sha256: file.sha256, path: report.installed, at: new Date().toISOString() })
  }

  if (values.exec === true)
    report.script = summarize(await Bun.file(file.path).text())

  print(report, url, values.json === true)

  if (values.exec !== true)
    return 0

  if (!verified && values.yes !== true)
    return fail('not run: no --sha256 or --sums pins this script', 1, `read ${file.path}, then: dl ${url} --exec --sha256 ${file.sha256}`)

  return runScript(file, url, rest)
}

interface Checks {
  maxSize: number
  expectsFile: boolean
  sha256: string | undefined
  sums: string | undefined
}

// Downloads `url` and checks it is no HTML page where a file was expected and has the sha256 asked; on a failure the file goes, and the folder too when dl made it.
async function fetchChecked(url: string, dir: string, created: boolean, checks: Checks): Promise<{ file: Downloaded, verified: boolean }> {
  let file: Downloaded | undefined

  try {
    file = await download(url, dir, checks.maxSize)

    if (file.html && (checks.expectsFile || !HTML_EXTENSIONS.has(extname(file.name).toLowerCase())))
      fail(`${url} answered an HTML page, not a file`, 1)

    const expected = checks.sha256 ?? (checks.sums === undefined ? undefined : await fetchSum(checks.sums, url, file.name))

    if (expected !== undefined && expected !== file.sha256)
      fail(`sha256 mismatch for ${file.name}: expected ${expected}, got ${file.sha256}; the file was deleted`, 1)

    return { file, verified: expected !== undefined }
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
async function diff(last: string, file: Downloaded, colored: boolean): Promise<string> {
  if (Bun.which('git') === null)
    return ''

  const color = colored && takesControlCodes(process.stdout) ? '--color=always' : '--no-color'
  const child = Bun.spawn(['git', 'diff', '--no-index', color, '--', last, file.path], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
  const lines = (await child.stdout.text()).trimEnd().split('\n')

  await child.exited

  const hunks = lines.findIndex(line => Bun.stripANSI(line).startsWith('@@'))

  return hunks === -1 ? '' : ['--- last', `+++ ${file.name}`, ...lines.slice(hunks)].join('\n')
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
    ['sha256', `${report.sha256}${report.verified ? ' verified' : ''}`],
    ['seen', report.seen],
    ...report.extracted === undefined ? [] : [['extracted', report.extracted]],
    ...report.installed === undefined ? [] : [['installed', report.installed]],
    ...report.installed === undefined || binDirOnPath() ? [] : [['note', `${binDir()} is not on PATH`]],
  ]

  console.log(table(rows))

  if (report.diff !== undefined && report.diff !== '')
    console.log(`\n${report.diff}`)

  if (report.script === undefined)
    return

  const { findings, env } = report.script

  console.log(findings.length === 0 ? '\nscript: fetches, sudo, removes, profile, system and runs found nowhere' : `\nscript:\n${table(findings.map(({ line, does, text }) => [`line ${line}`, does, truncate(text, LINE_WIDTH)]))}`)

  if (env.length > 0)
    console.log(`reads: ${env.join(', ')}`)
}

// Runs the script by its shebang, or with sh without one, on the terminal, and records it in the ledger once it succeeds.
async function runScript(file: Downloaded, url: string, args: string[]): Promise<number> {
  const shebang = (await Bun.file(file.path).text()).startsWith('#!')

  chmodSync(file.path, 0o700)

  const code = await Bun.spawn(shebang ? [file.path, ...args] : ['sh', file.path, ...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }).exited

  if (code !== 0)
    return fail(`the script exited ${code}`, 1)

  const { host, pathname } = new URL(url)

  record({ kind: 'script', name: `${host}${pathname}`, url, sha256: file.sha256, at: new Date().toISOString() })

  return 0
}
