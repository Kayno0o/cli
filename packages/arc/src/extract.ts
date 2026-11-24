import type { ExitRow } from '@kaynooo/cli-kit'
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { fail, parse, role } from '@kaynooo/cli-kit'
import { formatOf, readEntries, tarFlags } from './entries'
import { interactive, probe } from './proc'
import { unpack } from './unpack'

const USAGE = `arc extract [options] <file> [dest dir]: extracts an archive of any common kind, bomb-proof by default, never replacing a file that is there unless --overwrite

Understands .tar, .tar.gz, .tar.bz2, .tar.xz, .tar.zst, .gz, .bz2, .xz, .zst, .zip, .Z, .rar and .7z, whatever the case. When an archive has multiple top-level entries or a lone top-level file, it extracts into a new subfolder named after the archive unless --flat is given. With --verify, tests the archive integrity and compares extracted tar files against it.`

const EXITS: ExitRow[] = [[0, 'the extractor succeeded'], [1, 'a missing file, an extension it does not know, an output already there, verification failure or a failing extractor'], [2, 'a usage error']]

const keepOld = (overwrite: boolean) => overwrite ? [] : ['-k']

// The command per extension, lower case and matched without regard to case, the longest suffix first so .tar.gz is not read as .gz.
const EXTRACTORS: [suffix: string, argv: (file: string, overwrite: boolean) => string[]][] = [
  ['.tar.bz2', (file, overwrite) => ['tar', ...keepOld(overwrite), '-xjf', file]],
  ['.tar.gz', (file, overwrite) => ['tar', ...keepOld(overwrite), '-xzf', file]],
  ['.tar.xz', (file, overwrite) => ['tar', ...keepOld(overwrite), '-xJf', file]],
  ['.tar.zst', (file, overwrite) => ['tar', ...keepOld(overwrite), '--zstd', '-xf', file]],
  ['.tbz2', (file, overwrite) => ['tar', ...keepOld(overwrite), '-xjf', file]],
  ['.tgz', (file, overwrite) => ['tar', ...keepOld(overwrite), '-xzf', file]],
  ['.tar', (file, overwrite) => ['tar', ...keepOld(overwrite), '-xf', file]],
  ['.tbz', (file, overwrite) => ['tar', ...keepOld(overwrite), '-xjf', file]],
  ['.txz', (file, overwrite) => ['tar', ...keepOld(overwrite), '-xJf', file]],
  ['.tzst', (file, overwrite) => ['tar', ...keepOld(overwrite), '--zstd', '-xf', file]],
  ['.bz2', file => ['bunzip2', '-c', file]],
  ['.gz', file => ['gunzip', '-c', file]],
  ['.xz', file => ['xz', '-dc', file]],
  ['.zst', file => ['zstd', '-dc', file]],
  ['.zip', (file, overwrite) => ['unzip', overwrite ? '-o' : '-n', file]],
  ['.z', file => ['gzip', '-dc', file]],
  ['.rar', (file, overwrite) => ['unrar', 'x', overwrite ? '-o+' : '-o-', file]],
  ['.7z', (file, overwrite) => ['7z', 'x', overwrite ? '-aoa' : '-aos', file]],
]

// A single compressed file decompresses to stdout, arc naming the output itself: busybox's gunzip refuses a suffix in another case.
const LONE = new Set(['.bz2', '.gz', '.xz', '.zst', '.z'])

function say(message: string): void {
  console.error(`${role('note', process.stderr)('arc extract:')} ${message}`)
}

async function needsSubfolder(file: string): Promise<boolean> {
  if (formatOf(file) === undefined)
    return false

  const entries = await readEntries(file)
  const tops = entries.filter(entry => !entry.path.includes('/'))

  return tops.length !== 1 || tops[0]!.kind !== 'dir'
}

async function verifyBefore(file: string): Promise<void> {
  const format = formatOf(file)

  if (format === 'zip') {
    if ((await probe(['unzip', '-tq', file])).code !== 0)
      fail(`'${file}' failed integrity check`, 1)
  }
  else if (format === '7z') {
    if ((await probe(['7z', 't', file])).code !== 0)
      fail(`'${file}' failed integrity check`, 1)
  }
  else if (format === 'rar') {
    if ((await probe(['unrar', 't', file])).code !== 0)
      fail(`'${file}' failed integrity check`, 1)
  }
}

async function verifyAfterTar(file: string, targetDir: string): Promise<void> {
  if (formatOf(file) !== 'tar')
    return

  const compared = await probe(['tar', '--compare', '-f', file, ...tarFlags(file), '-C', targetDir])

  if (compared.code !== 0)
    fail(`the extracted files differ from '${file}'`, 1)
}

export async function extract(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, USAGE, {
    overwrite: { type: 'boolean', description: 'replace the files already there' },
    flat: { type: 'boolean', description: 'extract directly into the destination without creating a wrapping subfolder' },
    verify: { type: 'boolean', description: 'verify archive integrity and compare extracted tar files against the archive' },
  }, {
    exits: EXITS,
    positionals: ['<file>', '[dest dir]'],
    replaces: 'remembering whether it is tar xzf, tar xjf, unzip, unrar x or 7z x, and tarbombs spilling into cwd',
    examples: ['arc extract release.tar.gz', 'arc extract --flat photos.zip', ['arc extract --verify backup.tar.zst ~/restored', 'extract and verify file by file'], ['arc extract --overwrite release.tar.gz', 'replaces what an earlier extract left']],
  })
  const [file, destination] = positionals as [string, string | undefined]
  const destDir = destination === undefined ? process.cwd() : resolve(destination)

  if (!existsSync(file) || !statSync(file).isFile())
    return fail(`'${file}' is not a file`, 1)

  if (!existsSync(destDir) || !statSync(destDir).isDirectory())
    return fail(`'${destDir}' is not a folder`, 1)

  const extractor = extractorOf(file)

  if (extractor === undefined)
    return fail(`'${file}' cannot be extracted: unknown extension`, 1)

  const [suffix] = extractor
  const overwrite = values.overwrite === true
  const flat = values.flat === true
  const verify = values.verify === true

  // Verified .tar.zst restore without --overwrite delegates to unpack's checksum + tar --compare + owner-preserving flow.
  if (verify && !overwrite && (suffix === '.tar.zst' || suffix === '.tzst')) {
    const wrap = !flat && await needsSubfolder(file)
    const targetDir = wrap ? prepareSubfolder(file, suffix, destDir, false) : destDir

    return unpack([file, targetDir])
  }

  if (LONE.has(suffix))
    return extractArchive(file, destDir, overwrite)

  if (verify)
    await verifyBefore(resolve(file))

  let targetDir = destDir

  if (!flat && await needsSubfolder(file)) {
    targetDir = prepareSubfolder(file, suffix, destDir, overwrite)
    say(`extracting into ${basename(targetDir)}/`)
  }

  const code = await extractArchive(file, targetDir, overwrite)

  if (code !== 0)
    return code

  if (verify) {
    await verifyAfterTar(resolve(file), targetDir)
    say(`verified against '${file}'`)
  }

  return 0
}

function prepareSubfolder(file: string, suffix: string, destDir: string, overwrite: boolean): string {
  const stem = basename(file).slice(0, -suffix.length) || 'extracted'
  const folder = join(destDir, stem)

  if (existsSync(folder) && !overwrite)
    return fail(`'${folder}' already exists, nothing extracted`, 1, 'pass --overwrite or --flat to extract directly')

  mkdirSync(folder, { recursive: true })

  return folder
}

// The archive extension `file` ends with, lower case; undefined for a file arc cannot extract.
export function archiveSuffix(file: string): string | undefined {
  return extractorOf(file)?.[0]
}

function extractorOf(file: string) {
  return EXTRACTORS.find(([suffix]) => file.toLowerCase().endsWith(suffix))
}

// Extracts `file` into `cwd` by its extension, failing with exit 1 on a missing file, an unknown extension or a missing extractor; answers 0 or 1.
export async function extractArchive(file: string, cwd: string, overwrite = false): Promise<number> {
  if (!existsSync(file) || !statSync(file).isFile())
    return fail(`'${file}' is not a file`, 1)

  const extractor = extractorOf(file)

  if (extractor === undefined)
    return fail(`'${file}' cannot be extracted: unknown extension`, 1)

  const [suffix, argvOf] = extractor
  const argv = argvOf(resolve(file), overwrite)

  if (Bun.which(argv[0] ?? '') === null)
    return fail(`${argv[0]} is not on PATH`, 1)

  if (!LONE.has(suffix))
    return await interactive(argv, cwd) === 0 ? 0 : 1

  const name = basename(file).slice(0, -suffix.length)

  if (name === '')
    return fail(`'${file}' has no name left once ${suffix} is taken off`, 1)

  const target = join(cwd, name)

  if (existsSync(target) && !overwrite)
    return fail(`'${target}' already exists, nothing written`, 1, 'pass --overwrite to replace it')

  // Written aside and renamed once complete, so a failing decompress never leaves a half file nor removes the one that was there.
  const partial = `${target}.arc-partial`

  if (await Bun.spawn(argv, { stdin: 'ignore', stdout: Bun.file(partial), stderr: 'inherit' }).exited === 0) {
    renameSync(partial, target)

    return 0
  }

  rmSync(partial, { force: true })

  return 1
}
