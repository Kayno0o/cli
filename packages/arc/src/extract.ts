import type { ExitRow } from '@kaynooo/cli-kit'
import { existsSync, rmSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { fail, parse } from '@kaynooo/cli-kit'
import { interactive } from './proc'

const USAGE = `arc extract <file>: extracts an archive of any common kind into the current folder, by its extension

Understands .tar, .tar.gz, .tgz, .tar.bz2, .tbz2, .tbz, .tar.xz, .txz, .tar.zst, .tzst, .gz, .bz2, .xz, .zst, .zip, .Z, .rar and .7z, whatever the case; a lone .gz, .bz2, .xz, .zst or .Z keeps its archive. Unlike arc unpack it checks nothing and may overwrite what is there.`

const EXITS: ExitRow[] = [[0, 'the extractor succeeded'], [1, 'a missing file, an extension it does not know or a failing extractor'], [2, 'a usage error']]

// The command per extension, lower case and matched without regard to case, the longest suffix first so .tar.gz is not read as .gz.
const EXTRACTORS: [suffix: string, argv: (file: string) => string[]][] = [
  ['.tar.bz2', file => ['tar', 'xjf', file]],
  ['.tar.gz', file => ['tar', 'xzf', file]],
  ['.tar.xz', file => ['tar', 'xJf', file]],
  ['.tar.zst', file => ['tar', '--zstd', '-xf', file]],
  ['.tbz2', file => ['tar', 'xjf', file]],
  ['.tgz', file => ['tar', 'xzf', file]],
  ['.tar', file => ['tar', 'xf', file]],
  ['.tbz', file => ['tar', 'xjf', file]],
  ['.txz', file => ['tar', 'xJf', file]],
  ['.tzst', file => ['tar', '--zstd', '-xf', file]],
  ['.bz2', file => ['bunzip2', '-c', file]],
  ['.gz', file => ['gunzip', '-c', file]],
  ['.xz', file => ['xz', '-dc', file]],
  ['.zst', file => ['zstd', '-dc', file]],
  ['.zip', file => ['unzip', file]],
  ['.z', file => ['gzip', '-dc', file]],
  ['.rar', file => ['unrar', 'x', file]],
  ['.7z', file => ['7z', 'x', file]],
]

// A single compressed file decompresses to stdout, arc naming the output itself: busybox's gunzip refuses a suffix in another case.
const LONE = new Set(['.bz2', '.gz', '.xz', '.zst', '.z'])

export async function extract(args: string[]): Promise<number> {
  const { positionals: [file] } = parse(args, USAGE, {}, {
    exits: EXITS,
    positionals: ['<file>'],
    replaces: 'remembering whether it is tar xzf, tar xjf, unzip, unrar x or 7z x',
    examples: ['arc extract release.tar.gz', 'arc extract photos.zip'],
  })

  return extractArchive(file, process.cwd())
}

// The archive extension `file` ends with, lower case; undefined for a file arc cannot extract.
export function archiveSuffix(file: string): string | undefined {
  return extractorOf(file)?.[0]
}

function extractorOf(file: string) {
  return EXTRACTORS.find(([suffix]) => file.toLowerCase().endsWith(suffix))
}

// Extracts `file` into `cwd` by its extension, failing with exit 1 on a missing file, an unknown extension or a missing extractor; answers 0 or 1.
export async function extractArchive(file: string, cwd: string): Promise<number> {
  if (!existsSync(file) || !statSync(file).isFile())
    return fail(`'${file}' is not a file`, 1)

  const extractor = extractorOf(file)

  if (extractor === undefined)
    return fail(`'${file}' cannot be extracted: unknown extension`, 1)

  const [suffix, argvOf] = extractor
  const argv = argvOf(resolve(file))

  if (Bun.which(argv[0] ?? '') === null)
    return fail(`${argv[0]} is not on PATH`, 1)

  if (!LONE.has(suffix))
    return await interactive(argv, cwd) === 0 ? 0 : 1

  const name = basename(file).slice(0, -suffix.length)

  if (name === '')
    return fail(`'${file}' has no name left once ${suffix} is taken off`, 1)

  const target = join(cwd, name)

  if (await Bun.spawn(argv, { stdin: 'ignore', stdout: Bun.file(target), stderr: 'inherit' }).exited === 0)
    return 0

  rmSync(target, { force: true })

  return 1
}
