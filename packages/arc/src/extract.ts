import type { ExitRow } from '@kaynooo/cli-kit'
import { existsSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { fail, parse } from '@kaynooo/cli-kit'
import { interactive } from './proc'

const USAGE = `arc extract [--overwrite] <file>: extracts an archive of any common kind into the current folder, by its extension, never replacing a file that is there unless --overwrite

Understands .tar, .tar.gz, .tgz, .tar.bz2, .tbz2, .tbz, .tar.xz, .txz, .tar.zst, .tzst, .gz, .bz2, .xz, .zst, .zip, .Z, .rar and .7z, whatever the case; a lone .gz, .bz2, .xz, .zst or .Z keeps its archive. Unlike arc unpack it checks nothing against the archive. A file already there is kept: a lone compressed file whose output exists is refused, tar reports each such file as an error and extracts the others, unzip, unrar and 7z skip them.`

const EXITS: ExitRow[] = [[0, 'the extractor succeeded'], [1, 'a missing file, an extension it does not know, an output already there or a failing extractor'], [2, 'a usage error']]

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

export async function extract(args: string[]): Promise<number> {
  const { values, positionals: [file] } = parse(args, USAGE, { overwrite: { type: 'boolean', description: 'replace the files already there' } }, {
    exits: EXITS,
    positionals: ['<file>'],
    replaces: 'remembering whether it is tar xzf, tar xjf, unzip, unrar x or 7z x',
    examples: ['arc extract release.tar.gz', 'arc extract photos.zip', ['arc extract --overwrite release.tar.gz', 'replaces what an earlier extract left']],
  })

  return extractArchive(file, process.cwd(), values.overwrite === true)
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
