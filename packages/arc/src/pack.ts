import { existsSync, lstatSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fail, parse, role } from '@kaynooo/cli-kit'
import { lines, need, pipeline, probe, run, TAR_FIDELITY, ZSTD_LONG } from './proc'

const USAGE = `arc pack [-k] <folder> <dest dir>: packs a folder into <dest dir>/<name>.tar.zst, checks every file against the archive, then deletes the folder

The archive is written as <name>.tar.zst.partial and only renamed once complete; nothing is overwritten. The folder is deleted only after the archive passes zstd's checksum, holds as many entries as the folder and compares equal to it file by file (owners, ACLs and extended attributes included); -k keeps it. A symlink, a mount point, a folder with a file system mounted inside, a destination inside the folder and a destination with less free space than the folder holds are refused. A folder that is not readable or writable by you is packed and deleted through sudo.
Exits 0 when the archive is verified (and the folder deleted unless -k), 1 when anything was refused or failed, with the folder kept, 2 on a usage error.`

const TRAILING_SLASHES = /\/+$/

function say(message: string): void {
  console.error(`${role('label', process.stderr)('arc pack:')} ${message}`)
}

export async function pack(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, USAGE, { keep: { type: 'boolean', short: 'k', description: 'keep the folder once the archive is verified' } }, {
    positionals: ['<folder>', '<dest dir>'],
    replaces: 'tar czf, then diff or tar --compare by hand, then rm -rf once it looks right',
    examples: ['arc pack ~/old-project /mnt/backup', ['arc pack -k ./data /mnt/backup', 'the folder stays']],
  })
  const [folder, destination] = positionals
  const given = folder.replace(TRAILING_SLASHES, '')

  need('tar')
  need('zstd')

  if (given === '' || !existsSync(given) || lstatSync(given).isSymbolicLink() || !statSync(given).isDirectory())
    return fail(`'${folder}' is not a folder (a symlink is refused, as deleting it would not free its target)`, 1)

  if (!existsSync(destination) || !statSync(destination).isDirectory())
    return fail(`'${destination}' is not a folder`, 1)

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

  const needsRoot = !await writable(parent) || (await probe(['find', source, '-xdev', '(', '!', '-readable', '-o', '-type', 'd', '(', '!', '-writable', '-o', '!', '-executable', ')', ')', '-print', '-quit'])).stdout.trim() !== ''
  const as = needsRoot ? ['sudo'] : []
  const size = Number.parseInt((await probe([...as, 'du', '-sxb', '--', source])).stdout, 10)
  const free = Number((await probe(['df', '--output=avail', '-B1', '--', destDir])).stdout.trim().split('\n').at(-1))

  if (Number.isNaN(size) || Number.isNaN(free))
    return fail(`could not read the size of '${source}' or the free space in '${destDir}'`, 1)

  if (size > free)
    return fail(`'${source}' holds ${size} bytes, more than the ${free} free in '${destDir}'`, 1)

  say(`packing ${source} into ${out}`)

  const packed = await pipeline([...as, 'tar', '--create', '--file=-', `--directory=${parent}`, '--one-file-system', ...TAR_FIDELITY, '--sparse', '--', name], ['zstd', '-T0', '-10', ZSTD_LONG, '-o', partial])

  if (packed.codes.some(code => code !== 0)) {
    rmSync(partial, { force: true })

    return fail('packing failed, nothing deleted', 1)
  }

  await run(['sync', '--', partial])
  renameIfFree(partial, out)

  if (!existsSync(out) || existsSync(partial))
    return fail(`could not move '${partial}' to '${out}', nothing deleted`, 1)

  say('checking every file against the archive')

  if ((await probe(['zstd', '-t', '-q', ZSTD_LONG, '--', out])).code !== 0)
    return fail(`'${out}' fails its checksum, '${source}' kept`, 1)

  const onDisk = lines((await probe([...as, 'find', source, '-xdev'])).stdout).length
  const listed = await pipeline(['zstd', '-dc', ZSTD_LONG, '--', out], ['tar', '--list', '--file=-'], true)
  const inArchive = lines(listed.stdout).length

  if (onDisk !== inArchive)
    return fail(`'${source}' holds ${onDisk} entries but the archive ${inArchive} (a socket, or a file added meanwhile), '${source}' kept`, 1)

  const compared = await pipeline(['zstd', '-dc', ZSTD_LONG, '--', out], [...as, 'tar', '--compare', '--file=-', `--directory=${parent}`, ...TAR_FIDELITY])

  if (compared.codes.some(code => code !== 0))
    return fail(`the archive differs from '${source}', '${source}' kept`, 1)

  const bytes = statSync(out).size

  if (values.keep === true) {
    say(`${out} holds all ${inArchive} entries (${size} -> ${bytes} bytes), '${source}' kept`)

    return 0
  }

  if ((await run([...as, 'rm', '-rf', '--one-file-system', '--', source])).code !== 0)
    return fail(`could not delete '${source}', the archive '${out}' is complete`, 1)

  say(`${out} holds all ${inArchive} entries (${size} -> ${bytes} bytes), '${source}' deleted`)

  return 0
}

async function writable(dir: string): Promise<boolean> {
  return (await probe(['test', '-w', dir])).code === 0
}

// A rename that leaves an existing file alone, as `mv -n` does.
function renameIfFree(from: string, to: string): void {
  if (!existsSync(to))
    renameSync(from, to)
}
