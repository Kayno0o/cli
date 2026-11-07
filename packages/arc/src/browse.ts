import type { ExitRow, TreeNode } from '@kaynooo/cli-kit'
import type { Entry } from './entries'
import process from 'node:process'
import { fail, jsonOption, paint, parse, printJson, tree, wholeNumber } from '@kaynooo/cli-kit'
import { cleanPath, formatOf, readEntries, tarFlags, under, zipPattern } from './entries'

const UNITS = ['B', 'K', 'M', 'G', 'T']

function humanSize(bytes: number): string {
  let value = bytes
  let unit = 0

  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }

  return unit === 0 ? `${value}B` : `${value.toFixed(value < 10 ? 1 : 0)}${UNITS[unit]}`
}

function label(entry: Entry, shown: string): string {
  if (entry.kind === 'dir')
    return `${shown}/`

  return entry.target === undefined ? shown : `${shown} -> ${entry.target}`
}

const LS_USAGE = `arc ls [-r] [--json] <archive> [path]: lists what an archive holds, the way ls -l would, without extracting it

Reads .tar, .tar.gz, .tgz, .tar.bz2, .tar.xz, .tar.zst and .zip. Without a path it lists the top level; with a folder in the archive, what is directly in it; -r lists every level below. Folders that only their files' paths imply are listed too.`

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
  const width = Math.max(0, ...shown.map(entry => humanSize(entry.size).length))

  for (const entry of shown) {
    const name = values.recursive === true || base === '' ? entry.path : entry.path.slice(base.length + 1)

    console.log(`${dim(entry.mode.padEnd(10))} ${humanSize(entry.size).padStart(width)} ${dim(entry.modified.padEnd(16))} ${label(entry, entry.kind !== 'dir' && base !== '' && entry.path === base ? entry.path : name)}`)
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

  const argv = formatOf(archive) === 'zip' ? ['unzip', '-p', archive, zipPattern(found.raw)] : ['tar', '-xOf', archive, ...tarFlags(archive), '--', found.raw]

  return Bun.spawn(argv, { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' }).exited
}
