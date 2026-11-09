import type { ExitRow } from '@kaynooo/cli-kit'
import { existsSync, statSync } from 'node:fs'
import { fail, parse } from '@kaynooo/cli-kit'
import { interactive } from './proc'

const USAGE = `arc extract <file>: extracts an archive of any common kind into the current folder, by its extension

Understands .tar, .tar.gz, .tgz, .tar.bz2, .tbz2, .tbz, .tar.xz, .txz, .tar.zst, .tzst, .gz, .bz2, .xz, .zst, .zip, .Z, .rar and .7z, whatever the case; a lone .gz, .bz2, .xz, .zst or .Z keeps its archive. Unlike arc unpack it checks nothing and may overwrite what is there.`

const EXITS: ExitRow[] = [[0, 'the extractor succeeded'], [1, 'a missing file, an extension it does not know or a failing extractor'], [2, 'a usage error']]

// The command per extension, lower case and matched without regard to case, the longest suffix first so .tar.gz is not read as .gz. A single compressed file keeps its source.
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
  ['.bz2', file => ['bunzip2', '-k', file]],
  ['.gz', file => ['gunzip', '-k', file]],
  ['.xz', file => ['xz', '-dk', file]],
  ['.zst', file => ['zstd', '-dk', file]],
  ['.zip', file => ['unzip', file]],
  ['.z', file => ['gzip', '-dk', file]],
  ['.rar', file => ['unrar', 'x', file]],
  ['.7z', file => ['7z', 'x', file]],
]

export async function extract(args: string[]): Promise<number> {
  const { positionals: [file] } = parse(args, USAGE, {}, {
    exits: EXITS,
    positionals: ['<file>'],
    replaces: 'remembering whether it is tar xzf, tar xjf, unzip, unrar x or 7z x',
    examples: ['arc extract release.tar.gz', 'arc extract photos.zip'],
  })

  if (!existsSync(file) || !statSync(file).isFile())
    return fail(`'${file}' is not a file`, 1)

  const extractor = EXTRACTORS.find(([suffix]) => file.toLowerCase().endsWith(suffix))

  if (extractor === undefined)
    return fail(`'${file}' cannot be extracted: unknown extension`, 1)

  const argv = extractor[1](file)

  if (Bun.which(argv[0] ?? '') === null)
    return fail(`${argv[0]} is not on PATH`, 1)

  return await interactive(argv) === 0 ? 0 : 1
}
