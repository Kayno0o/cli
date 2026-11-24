import type { ExitRow, TreeNode } from '@kaynooo/cli-kit'
import type { Entry, Format } from './entries'
import process from 'node:process'
import { badUsage, fail, formatSize, jsonOption, paint, parse, printJson, tree, wholeNumber } from '@kaynooo/cli-kit'
import { cleanPath, formatOf, readEntries, tarFlags, under, zipPattern } from './entries'

const MAX_GREP_BYTES = 16 * 1024 * 1024

function catArgv(archive: string, entry: Entry): string[] {
  const format: Format | undefined = formatOf(archive)

  if (format === 'zip')
    return ['unzip', '-p', archive, zipPattern(entry.raw)]

  if (format === '7z')
    return ['7z', 'x', '-so', archive, '--', entry.raw]

  if (format === 'rar')
    return ['unrar', 'p', '-inul', archive, '--', entry.raw]

  return ['tar', '-xOf', archive, ...tarFlags(archive), '--', entry.raw]
}

function label(entry: Entry, shown: string): string {
  if (entry.kind === 'dir')
    return `${shown}/`

  return entry.target === undefined ? shown : `${shown} -> ${entry.target}`
}

const LS_USAGE = `arc ls [-r] [--json] <archive> [path]: lists what an archive holds, the way ls -l would, without extracting it

Reads .tar, .tar.gz, .tgz, .tar.bz2, .tar.xz, .tar.zst, .zip, .7z and .rar. Without a path it lists the top level; with a folder in the archive, what is directly in it; -r lists every level below. Folders that only their files' paths imply are listed too.`

const LS_EXITS: ExitRow[] = [[0, 'it listed them'], [1, 'the archive or the path in it cannot be read'], [2, 'a usage error']]

export async function ls(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, LS_USAGE, { recursive: { type: 'boolean', short: 'r', description: 'every level below the path' }, json: jsonOption('[{path, kind, size, mode, modified, target?}]') }, {
    exits: LS_EXITS,
    positionals: ['<archive>', '[path]'],
    replaces: 'tar -tvf and unzip -l, whose listings are the whole archive in their own format',
    examples: ['arc ls backup.tar.zst', ['arc ls -r backup.tar.zst src', 'everything under src'], ['arc ls site.zip --json', 'for a script']],
  })
  const [archive, prefix = ''] = positionals as [string, string | undefined]
  const entries = await readEntries(archive)
  const shown = under(entries, prefix, values.recursive === true)

  if (shown === undefined)
    return fail(`no '${cleanPath(prefix)}' in '${archive}'`, 1)

  if (values.json === true) {
    printJson(shown.map(({ raw: _raw, ...entry }) => entry))

    return 0
  }

  const { dim } = paint(process.stdout)
  const base = cleanPath(prefix)
  const width = Math.max(0, ...shown.map(entry => formatSize(entry.size).length))

  for (const entry of shown) {
    const name = values.recursive === true || base === '' ? entry.path : entry.path.slice(base.length + 1)

    console.log(`${dim(entry.mode.padEnd(10))} ${formatSize(entry.size).padStart(width)} ${dim(entry.modified.padEnd(16))} ${label(entry, entry.kind !== 'dir' && base !== '' && entry.path === base ? entry.path : name)}`)
  }

  return 0
}

const TREE_USAGE = `arc tree [-L <depth>] <archive> [path]: the files of an archive as a tree, without extracting it

Without a path it draws the whole archive; with a folder in the archive, what is under it. -L limits how many levels are drawn.`

const TREE_EXITS: ExitRow[] = [[0, 'it drew the tree'], [1, 'the archive or the path in it cannot be read'], [2, 'a usage error']]

function nodesOf(entries: Entry[], base: string, depth: number): TreeNode[] {
  const direct = entries.filter(entry => (base === '' ? !entry.path.includes('/') : entry.path.startsWith(`${base}/`) && !entry.path.slice(base.length + 1).includes('/')))

  return direct.map((entry) => {
    const name = base === '' ? entry.path : entry.path.slice(base.length + 1)
    const children = entry.kind === 'dir' && depth > 1 ? nodesOf(entries, entry.path, depth - 1) : []

    return children.length === 0 ? { label: label(entry, name) } : { label: name, children }
  })
}

export async function treeCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, TREE_USAGE, { level: { type: 'string', short: 'L', description: 'how many levels to draw (default all)' } }, {
    exits: TREE_EXITS,
    positionals: ['<archive>', '[path]'],
    replaces: 'listing an archive with tar -tf and reading the paths by eye',
    examples: ['arc tree backup.tar.zst', ['arc tree -L 2 site.zip', 'two levels deep']],
  })
  const [archive, prefix = ''] = positionals as [string, string | undefined]
  const entries = await readEntries(archive)
  const base = cleanPath(prefix)

  if (under(entries, base, true) === undefined)
    return fail(`no '${base}' in '${archive}'`, 1)

  const depth = wholeNumber(values.level, 'level', Number.MAX_SAFE_INTEGER)

  console.log(tree(nodesOf(entries, base, depth)))

  return 0
}

const CAT_USAGE = `arc cat <archive> <file>: prints a file of an archive on stdout, without extracting it

The file is named as arc ls shows it. Its bytes go to stdout as they are, so it can be piped or redirected.`

const CAT_EXITS: ExitRow[] = [[0, 'it printed the file'], [1, 'the archive cannot be read, the file is not in it or is a folder'], [2, 'a usage error']]

export async function cat(args: string[]): Promise<number> {
  const { positionals } = parse(args, CAT_USAGE, {}, {
    exits: CAT_EXITS,
    positionals: ['<archive>', '<file>'],
    replaces: 'tar -xOf and unzip -p, which each want the archive\'s own spelling of the path',
    examples: ['arc cat backup.tar.zst project/package.json', ['arc cat site.zip index.html | head', 'the start of a file']],
  })
  const [archive, file] = positionals
  const entries = await readEntries(archive)
  const found = entries.find(entry => entry.path === cleanPath(file))

  if (found === undefined)
    return fail(`no '${cleanPath(file)}' in '${archive}'`, 1)

  if (found.kind === 'dir')
    return fail(`'${found.path}' is a folder, arc ls lists it`, 1)

  return Bun.spawn(catArgv(archive, found), { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' }).exited
}

const GREP_USAGE = `arc grep [options] <pattern> <archive> [path]: searches text files inside an archive without extracting it

Skips binary files (containing NUL bytes) and files over 16 MiB. Searches a regex by default, or a literal string with -F.`

const GREP_EXITS: ExitRow[] = [[0, 'at least one line matched'], [1, 'no line matched or the archive could not be read'], [2, 'a usage error']]

const GREP_OPTIONS = {
  'ignore-case': { type: 'boolean', short: 'i', description: 'match without regard to case' },
  'fixed-strings': { type: 'boolean', short: 'F', description: 'match the pattern as literal text' },
  'files-with-matches': { type: 'boolean', short: 'l', description: 'print only the paths of matching files' },
  'json': jsonOption('[{path, line, text}]'),
} as const

interface GrepHit {
  path: string
  line: number
  text: string
}

async function readEntryBytes(archive: string, entry: Entry): Promise<Uint8Array | undefined> {
  const child = Bun.spawn(catArgv(archive, entry), { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
  const [bytes, code] = await Promise.all([new Response(child.stdout).bytes(), child.exited])

  return code === 0 ? bytes : undefined
}

export async function grep(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, GREP_USAGE, GREP_OPTIONS, {
    exits: GREP_EXITS,
    positionals: ['<pattern>', '<archive>', '[path]'],
    replaces: 'extracting an archive into /tmp just to grep its files',
    examples: ['arc grep TODO backup.tar.zst', ['arc grep -i error logs.zip app/', 'case-insensitive under app/']],
  })
  const [pattern, archive, prefix = ''] = positionals as [string, string, string | undefined]
  const ignoreCase = values['ignore-case'] === true
  const fixed = values['fixed-strings'] === true
  let matcher: (line: string) => boolean

  if (fixed) {
    const needle = ignoreCase ? pattern.toLowerCase() : pattern

    matcher = line => (ignoreCase ? line.toLowerCase() : line).includes(needle)
  }
  else {
    try {
      const regex = new RegExp(pattern, ignoreCase ? 'i' : '')

      matcher = line => regex.test(line)
    }
    catch (error) {
      return badUsage(`invalid regex '${pattern}': ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const entries = await readEntries(archive)
  const scoped = under(entries, prefix, true)

  if (scoped === undefined)
    return fail(`no '${cleanPath(prefix)}' in '${archive}'`, 1)

  const files = scoped.filter(entry => entry.kind === 'file' && entry.size <= MAX_GREP_BYTES)
  const hits: GrepHit[] = []
  const matchedFiles: string[] = []
  const decoder = new TextDecoder()

  for (const entry of files) {
    const bytes = await readEntryBytes(archive, entry)

    if (bytes === undefined || bytes.length > MAX_GREP_BYTES || bytes.subarray(0, 8192).includes(0))
      continue

    const text = decoder.decode(bytes)
    let fileMatched = false

    for (const [index, line] of text.split('\n').entries()) {
      if (!matcher(line))
        continue

      fileMatched = true
      hits.push({ path: entry.path, line: index + 1, text: line })

      if (values['files-with-matches'] === true)
        break
    }

    if (fileMatched)
      matchedFiles.push(entry.path)
  }

  if (values.json === true) {
    printJson(hits)

    return hits.length > 0 ? 0 : 1
  }

  if (hits.length === 0)
    return 1

  const { cyan, dim } = paint(process.stdout)

  if (values['files-with-matches'] === true) {
    for (const file of matchedFiles)
      console.log(file)

    return 0
  }

  for (const hit of hits)
    console.log(`${cyan(hit.path)}${dim(`:${hit.line}:`)} ${hit.text}`)

  return 0
}
