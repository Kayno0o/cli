import type { ExitRow } from '@kaynooo/cli-kit'
import { existsSync, lstatSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { badUsage, fail, formatSize, parse, wholeNumber } from '@kaynooo/cli-kit'
import { progressLine } from '@kaynooo/cli-kit/progress'
import { byteProgress, DEFAULT_LEVEL, defaultThreads, ensureSudo, feedPipeline, lines, need, niced, pipeline, probe, ratioSummary, run, say, TAR_FIDELITY, ZSTD_DECODE_LONG } from './proc'

const USAGE = `arc pack [options] <folder|file> [dest dir]: packs a folder or a file into <dest dir>/<name>.tar.zst (the current folder by default), checks every file against it and keeps the source unless --delete

The archive is written as <name>.tar.zst.partial and renamed once complete; nothing is overwritten. With --delete, the folder or file is deleted only after the archive passes zstd's checksum and compares equal to it file by file. A symlink, a mount point, a destination inside the folder and a destination with too little free space are refused, and a folder you cannot read (or write, with --delete) is packed, and deleted, through sudo. Compression defaults to level 3 with at most half the CPUs (max 4) under nice so packing stays light on CPU and RAM.`

const EXITS: ExitRow[] = [[0, 'the archive is verified (and the folder deleted with --delete)'], [1, 'anything was refused or failed, with the folder kept'], [2, 'a usage error']]

const TRAILING_SLASHES = /\/+$/
const MAX_LEVEL = 19

function isExcluded(relPath: string, globs: Bun.Glob[]): boolean {
  if (globs.length === 0)
    return false

  const segments = relPath.split('/')

  for (const glob of globs) {
    if (glob.match(relPath))
      return true

    let prefix = ''

    for (const segment of segments) {
      prefix = prefix === '' ? segment : `${prefix}/${segment}`

      if (glob.match(segment) || glob.match(prefix))
        return true
    }
  }

  return false
}

export async function pack(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, USAGE, {
    delete: { type: 'boolean', description: 'delete the folder or file once the archive is verified' },
    exclude: { type: 'string', short: 'e', multiple: true, description: 'exclude matching files or folders (repeatable)' },
    level: { type: 'string', short: 'l', description: `zstd compression level 1..${MAX_LEVEL} (default ${DEFAULT_LEVEL})` },
    threads: { type: 'string', short: 'T', description: `zstd worker threads (default ${defaultThreads()})` },
  }, {
    exits: EXITS,
    positionals: ['<folder|file>', '[dest dir]'],
    replaces: 'tar czf, then diff or tar --compare by hand, then rm -rf once it looks right',
    examples: [['arc pack ./data /mnt/backup', 'the folder stays'], ['arc pack dist', 'compress only: ./dist.tar.zst'], ['arc pack dump.jsonl', 'a single file: ./dump.jsonl.tar.zst'], ['arc pack --exclude node_modules --exclude .git ./app', 'skip dependencies and git'], ['arc pack --delete ~/old-project /mnt/backup', 'archive, verify, then delete the folder']],
  })
  const [folder, destination = '.'] = positionals
  const given = folder.replace(TRAILING_SLASHES, '')
  const excludes = (values.exclude ?? []).filter(Boolean)
  const excludeArgs = excludes.map(pattern => `--exclude=${pattern}`)
  const excludeGlobs = excludes.map(pattern => new Bun.Glob(pattern))
  const level = wholeNumber(values.level, 'level', DEFAULT_LEVEL)
  const threads = wholeNumber(values.threads, 'threads', defaultThreads())

  if (level < 1 || level > MAX_LEVEL)
    return badUsage(`--level must be between 1 and ${MAX_LEVEL}`)

  if (threads < 1)
    return badUsage('--threads must be at least 1')

  need('tar')
  need('zstd')

  if (given === '' || !existsSync(given))
    return fail(`'${folder}' does not exist`, 1)

  if (lstatSync(given).isSymbolicLink())
    return fail(`'${folder}' is a symlink, refused as deleting it would not free its target`, 1)

  if (!statSync(given).isDirectory() && !statSync(given).isFile())
    return fail(`'${folder}' is neither a folder nor a file`, 1)

  if (!existsSync(destination) || !statSync(destination).isDirectory())
    return fail(`'${destination}' is not a folder: [dest dir] is where <name>.tar.zst goes`, 1)

  // Symlinks in the parents resolved, so the mount and containment checks compare the paths the kernel sees.
  const source = realpathSync(given)
  const destDir = realpathSync(destination)
  const name = basename(source)
  const parent = dirname(source)
  const out = join(destDir, `${name}.tar.zst`)
  const partial = `${out}.partial`

  if (source === '/' || (await probe(['mountpoint', '-q', '--', source])).code === 0)
    return fail(`'${source}' is a mount point, refused`, 1)

  if (`${destDir}/`.startsWith(`${source}/`))
    return fail(`the destination is inside '${source}'`, 1)

  if (existsSync(out) || existsSync(partial))
    return fail(`'${out}' or its .partial already exists, nothing overwritten`, 1)

  // A mount inside would be skipped by tar and rm alike, so its files would silently stay out of the archive.
  if (lines((await probe(['findmnt', '-rn', '-o', 'TARGET'])).stdout).some(target => target.startsWith(`${source}/`)))
    return fail(`a file system is mounted inside '${source}', refused`, 1)

  // Write permission on the folder and its parent is only needed when --delete will remove it.
  const willDelete = values.delete === true
  const permCheck = willDelete
    ? ['find', source, '-xdev', '!', '-type', 'l', '(', '!', '-readable', '-o', '-type', 'd', '(', '!', '-writable', '-o', '!', '-executable', ')', ')', '-print', '-quit']
    : ['find', source, '-xdev', '!', '-type', 'l', '(', '!', '-readable', '-o', '-type', 'd', '!', '-executable', ')', '-print', '-quit']
  const needsRoot = (willDelete && !await writable(parent)) || (await probe(permCheck)).stdout.trim() !== ''
  const as = needsRoot ? ['sudo'] : []

  if (needsRoot && !await ensureSudo())
    return fail('sudo authentication failed', 1)

  const size = Number.parseInt((await probe([...as, 'du', '-sxb', ...excludeArgs, '--', source])).stdout, 10)
  const free = Number((await probe(['df', '--output=avail', '-B1', '--', destDir])).stdout.trim().split('\n').at(-1))

  if (Number.isNaN(size) || Number.isNaN(free))
    return fail(`could not read the size of '${source}' or the free space in '${destDir}'`, 1)

  if (size > free)
    return fail(`'${source}' holds ${formatSize(size)}, more than the ${formatSize(free)} free in '${destDir}'`, 1)

  say(`packing ${source} -> ${out}`)

  const progress = progressLine()
  let stepStart = performance.now()
  const startStep = (step: string, total?: number) => {
    stepStart = performance.now()
    progress.update({ step, ...byteProgress(0, total) })
  }
  const failWith = (reason: string, cause?: string): never => {
    progress.stop()

    if (cause !== undefined && cause !== '')
      process.stderr.write(`${cause}\n`)

    return fail(reason, 1)
  }

  try {
    startStep(`packing ${name}`, size)

    const packed = await pipeline(
      [...as, 'tar', '--create', '--file=-', `--directory=${parent}`, '--one-file-system', ...TAR_FIDELITY, '--sparse', ...excludeArgs, '--', name],
      niced(['zstd', `-T${threads}`, `-${level}`, '-q', '-o', partial]),
      { onBytes: bytes => progress.update({ step: `packing ${name}`, ...byteProgress(bytes, size, performance.now() - stepStart) }) },
    )

    if (packed.codes.some(code => code !== 0)) {
      rmSync(partial, { force: true })

      return failWith('packing failed, nothing deleted', packed.stderr)
    }

    startStep('syncing to disk')
    await run(['sync', '--', partial])
    renameIfFree(partial, out)

    if (!existsSync(out) || existsSync(partial))
      return failWith(`could not move '${partial}' to '${out}', nothing deleted`)

    // A refused archive goes, so a later run does not find it in the way.
    const refuse = (reason: string, cause?: string): never => {
      rmSync(out, { force: true })

      return failWith(`${reason}, '${source}' kept and the archive removed`, cause)
    }

    const archiveSize = statSync(out, { throwIfNoEntry: false })?.size ?? 0

    // Pass 1: decompress through zstd (validating its frame checksum) and count entries in one sweep.
    startStep('verifying archive', archiveSize)

    const [diskFound, listed] = await Promise.all([
      probe([...as, 'find', source, '-xdev', '-print0']),
      feedPipeline(
        out,
        niced(['zstd', '-dc', '-q', ZSTD_DECODE_LONG]),
        ['tar', '--list', '--file=-'],
        { capture: true, onBytes: bytes => progress.update({ step: 'verifying archive', ...byteProgress(bytes, archiveSize, performance.now() - stepStart) }) },
      ),
    ])

    if (listed.codes[0] !== 0)
      return refuse(`'${out}' fails its checksum`, listed.stderr)

    if (listed.codes[1] !== 0)
      return refuse(`could not list '${out}'`, listed.stderr)

    // NUL-separated, as a file name may hold a newline; tar lists one escaped on one line.
    const diskEntries = diskFound.stdout.split('\0').filter(Boolean)
    const keptOnDisk = excludeGlobs.length === 0
      ? diskEntries
      : diskEntries.filter(entry => entry === source || (!isExcluded(`${name}/${entry.slice(source.length + 1)}`, excludeGlobs) && !isExcluded(entry.slice(source.length + 1), excludeGlobs)))
    const onDisk = keptOnDisk.length
    const inArchive = lines(listed.stdout).length

    if (onDisk !== inArchive)
      return refuse(`'${source}' holds ${onDisk} entries but the archive ${inArchive} (a socket, or a file added meanwhile)`)

    // Pass 2: compare every entry's contents, owners, ACLs and xattrs against disk.
    startStep('comparing files', archiveSize)

    const compared = await feedPipeline(
      out,
      niced(['zstd', '-dc', '-q', ZSTD_DECODE_LONG]),
      [...as, 'tar', '--compare', '--file=-', `--directory=${parent}`, ...TAR_FIDELITY, ...excludeArgs],
      { capture: true, onBytes: bytes => progress.update({ step: 'comparing files', ...byteProgress(bytes, archiveSize, performance.now() - stepStart) }) },
    )

    if (compared.codes.some(code => code !== 0))
      return refuse(`the archive differs from '${source}'`, compared.stderr || compared.stdout.trim())

    const summary = `${out} (${inArchive} entries, ${ratioSummary(size, archiveSize)})`

    if (!willDelete) {
      progress.done(`${summary}, '${source}' kept`)

      return 0
    }

    startStep(`deleting ${name}`)

    const removed = await run([...as, 'rm', '-rf', '--one-file-system', '--', source])

    if (removed.code !== 0)
      return failWith(`could not delete '${source}', the archive '${out}' is complete`, removed.stderr)

    progress.done(`${summary}, '${source}' deleted`)

    return 0
  }
  catch (error) {
    progress.stop()

    throw error
  }
}

async function writable(dir: string): Promise<boolean> {
  return (await probe(['test', '-w', dir])).code === 0
}

// A rename that leaves an existing file alone, as `mv -n` does.
function renameIfFree(from: string, to: string): void {
  if (!existsSync(to))
    renameSync(from, to)
}
