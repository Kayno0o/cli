import { existsSync, lstatSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fail, parse, role } from '@kaynooo/cli-kit'
import { lines, need, pipeline, probe, TAR_FIDELITY, ZSTD_LONG } from './proc'

const USAGE = `arc unpack <archive.tar.zst> <dest dir>: unpacks an archive made by arc pack into a folder, refusing to overwrite anything, then checks every file against it

The archive's checksum is tested first, and nothing is extracted when a top-level entry already exists in the destination. Files owned by someone else get their owner back only as root, so sudo is used when the destination is not writable or the archive holds other owners. The archive is kept.
Exits 0 when every extracted file matches the archive, 1 when anything was refused or failed, 2 on a usage error.`

const WHITESPACE = /\s+/

function say(message: string): void {
  console.error(`${role('note', process.stderr)('arc unpack:')} ${message}`)
}

export async function unpack(args: string[]): Promise<number> {
  const { positionals } = parse(args, USAGE, {}, {
    positionals: ['<archive>', '<dest dir>'],
    replaces: 'tar xf into a folder that may already hold files, then a tar --compare by hand',
    examples: ['arc unpack /mnt/backup/old-project.tar.zst ~/restored'],
  })
  const [given, destination] = positionals

  need('tar')
  need('zstd')

  const archive = resolve(given)
  const destDir = resolve(destination)

  if (!existsSync(archive) || !statSync(archive).isFile())
    return fail(`'${given}' is not a file`, 1)

  if (!existsSync(destDir) || !statSync(destDir).isDirectory())
    return fail(`'${destination}' is not a folder`, 1)

  if ((await probe(['zstd', '-t', '-q', ZSTD_LONG, '--', archive])).code !== 0)
    return fail(`'${archive}' fails its checksum, nothing extracted`, 1)

  const listing = await pipeline(['zstd', '-dc', ZSTD_LONG, '--', archive], ['tar', '--list', '--file=-'], true)
  const tops = new Set(lines(listing.stdout).map(topOf))

  for (const top of tops) {
    if (exists(join(destDir, top)))
      return fail(`'${join(destDir, top)}' already exists, nothing extracted`, 1)
  }

  // Files owned by someone else only get their owner back when extracted as root.
  const verbose = await pipeline(['zstd', '-dc', ZSTD_LONG, '--', archive], ['tar', '--list', '--verbose', '--numeric-owner', '--file=-'], true)
  const owners = new Set(lines(verbose.stdout).map(entry => entry.split(WHITESPACE)[1]))
  const mine = `${process.getuid?.()}/${process.getgid?.()}`
  const as = !await writable(destDir) || owners.size !== 1 || !owners.has(mine) ? ['sudo'] : []

  say(`extracting ${archive} into ${destDir}`)

  const extracted = await pipeline(['zstd', '-dc', ZSTD_LONG, '--', archive], [...as, 'tar', '--extract', '--file=-', `--directory=${destDir}`, '--keep-old-files', '--same-permissions', ...TAR_FIDELITY])

  if (extracted.codes.some(code => code !== 0))
    return fail(`extracting failed, '${archive}' kept; what was extracted is left in '${destDir}'`, 1)

  Bun.spawnSync(['sync', '-f', '--', destDir])

  const compared = await pipeline(['zstd', '-dc', ZSTD_LONG, '--', archive], [...as, 'tar', '--compare', '--file=-', `--directory=${destDir}`, ...TAR_FIDELITY])

  if (compared.codes.some(code => code !== 0))
    return fail(`the extracted files differ from '${archive}', which is kept`, 1)

  say(`every file matches, '${archive}' kept (delete it yourself once done)`)

  return 0
}

// The first path segment of an archive entry.
function topOf(entry: string): string {
  const slash = entry.indexOf('/')

  return slash === -1 ? entry : entry.slice(0, slash)
}

function exists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined
}

async function writable(dir: string): Promise<boolean> {
  return (await probe(['test', '-w', dir])).code === 0
}
