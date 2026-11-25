import type { ExitRow } from '@kaynooo/cli-kit'
import { existsSync, lstatSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { fail, formatSize, parse } from '@kaynooo/cli-kit'
import { progressLine } from '@kaynooo/cli-kit/progress'
import { cleanPath, parseTarVerbose } from './entries'
import { byteProgress, ensureSudo, feedPipeline, need, niced, probe, run, say, TAR_FIDELITY, ZSTD_DECODE_LONG } from './proc'

const USAGE = `arc unpack <archive.tar.zst> <dest dir>: unpacks an archive made by arc pack into a folder, refusing to overwrite anything, then checks every file against it

The archive's checksum is tested first, and nothing is extracted when a top-level entry already exists in the destination. Files owned by someone else get their owner back only as root, so sudo is used when the destination is not writable or the archive holds other owners. The archive is kept.`

const EXITS: ExitRow[] = [[0, 'every extracted file matches the archive'], [1, 'anything was refused or failed'], [2, 'a usage error']]

export async function unpack(args: string[]): Promise<number> {
  const { positionals } = parse(args, USAGE, {}, {
    exits: EXITS,
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

  const name = basename(archive)
  const archiveSize = statSync(archive).size

  say(`unpacking ${archive} -> ${destDir}`)

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
    // Pass 1: validate zstd checksum, top-level conflicts and file owners in a single sweep.
    startStep(`checking ${name}`, archiveSize)

    const listed = await feedPipeline(
      archive,
      niced(['zstd', '-dc', '-q', ZSTD_DECODE_LONG]),
      ['tar', '--list', '--verbose', '--numeric-owner', '--file=-'],
      { capture: true, onBytes: bytes => progress.update({ step: `checking ${name}`, ...byteProgress(bytes, archiveSize, performance.now() - stepStart) }) },
    )

    if (listed.codes[0] !== 0)
      return failWith(`'${archive}' fails its checksum, nothing extracted`, listed.stderr)

    if (listed.codes[1] !== 0)
      return failWith(`could not read '${archive}', nothing extracted`, listed.stderr)

    const parsed = parseTarVerbose(listed.stdout)
    const tops = new Set(parsed.map(entry => topOf(cleanPath(entry.raw))).filter(Boolean))

    for (const top of tops) {
      if (exists(join(destDir, top)))
        return failWith(`'${join(destDir, top)}' already exists, nothing extracted`)
    }

    // Files owned by someone else only get their owner back when extracted as root.
    const owners = new Set(parsed.map(entry => entry.owner))
    const mine = `${process.getuid?.()}/${process.getgid?.()}`
    const needsRoot = !await writable(destDir) || owners.size !== 1 || !owners.has(mine)
    const as = needsRoot ? ['sudo'] : []

    if (needsRoot) {
      const resume = progress.pause()
      const authed = await ensureSudo()

      resume()

      if (!authed)
        return failWith('sudo authentication failed')
    }

    // Pass 2: extract with progress bar.
    startStep(`extracting ${name}`, archiveSize)

    const extracted = await feedPipeline(
      archive,
      niced(['zstd', '-dc', '-q', ZSTD_DECODE_LONG]),
      [...as, 'tar', '--extract', '--file=-', `--directory=${destDir}`, '--keep-old-files', '--same-permissions', ...TAR_FIDELITY],
      { onBytes: bytes => progress.update({ step: `extracting ${name}`, ...byteProgress(bytes, archiveSize, performance.now() - stepStart) }) },
    )

    if (extracted.codes.some(code => code !== 0))
      return failWith(`extracting failed, '${archive}' kept; what was extracted is left in '${destDir}'`, extracted.stderr)

    startStep('syncing to disk')
    await run(['sync', '-f', '--', destDir])

    // Pass 3: compare every extracted file against the archive.
    startStep('comparing files', archiveSize)

    const compared = await feedPipeline(
      archive,
      niced(['zstd', '-dc', '-q', ZSTD_DECODE_LONG]),
      [...as, 'tar', '--compare', '--file=-', `--directory=${destDir}`, ...TAR_FIDELITY],
      { capture: true, onBytes: bytes => progress.update({ step: 'comparing files', ...byteProgress(bytes, archiveSize, performance.now() - stepStart) }) },
    )

    if (compared.codes.some(code => code !== 0))
      return failWith(`the extracted files differ from '${archive}', which is kept`, compared.stderr || compared.stdout.trim())

    progress.done(`every file matches (${formatSize(archiveSize)}), '${archive}' kept`)

    return 0
  }
  catch (error) {
    progress.stop()

    throw error
  }
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
