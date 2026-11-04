import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { parseCommand, splitCommand } from '@kaynooo/cli-kit/shell'

// A redirect, `2>` once `2>&1` is split at its `&`, `>log`, or a bare `>` whose target is the next word.
const REDIRECT = /^\d*[<>]/
const BARE_REDIRECT = /^\d*(?:[<>]|>>)$/
// The subcommands adding a package, per package manager: `bun install <name>` adds it as `bun add` does.
const ADDS: Record<string, Set<string>> = {
  bun: new Set(['add', 'a', 'install', 'i']),
  npm: new Set(['install', 'i', 'add', 'in', 'isntall']),
  pnpm: new Set(['add', 'i', 'install']),
  yarn: new Set(['add']),
}
// The subcommands running a package without installing it, and the programs doing only that.
const RUNS: Record<string, Set<string>> = {
  bun: new Set(['x']),
  npm: new Set(['exec', 'x']),
  pnpm: new Set(['dlx']),
  yarn: new Set(['dlx']),
}
const RUNNERS = new Set(['bunx', 'npx'])
// Flags whose value is a package to run.
const PACKAGE_FLAGS = new Set(['-p', '--package'])
// Flags whose value is the next word, not a package.
const VALUE_FLAGS = new Set(['--cwd', '--filter', '-F', '-c', '--call', '--workspace', '--registry', '--prefix', '-C', '--dir', '--config', '--cache-dir', '--loglevel', '--tag', '--save-prefix', '--userconfig', '--omit', '--include', '--fetch-timeout', '--fetch-retries', '--install-strategy', '--cache', ...PACKAGE_FLAGS])
// A specifier no registry serves: a path, a tarball, a workspace or a git repository, `owner/repo` included.
const NOT_REGISTRY = /^(?:[./~]|file:|link:|portal:|workspace:|git[+:]|github:|gitlab:|bitbucket:|https?:)|\.tgz$|^[\w.-]+\/[\w.-]+(?:#.*)?$/
// `alias@npm:real@1.0.0` installs the real one.
const NPM_ALIAS = /^(?:@[^/]+\/)?[^@]+@npm:(.+)$/
// A step publishing a package: `ft release` (or its source run as `cli.ts release`), `bun publish`, `npm publish`, a lib's `just patch|minor|major`.
const PUBLISH = /\b(?:ft|cli\.ts)\s+release\b|\b(?:bun|npm|pnpm|yarn)\s+publish\b|\bjust\s+(?:patch|minor|major)\b/

// `name@1.2.3`, the shape of the version a publish just made.
const EXACT_SPEC = /^(?:@[^/]+\/)?[^@]+@\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/

// The name of a manifest, undefined when it is missing or broken.
function manifestName(folder: string): string | undefined {
  try {
    const { name } = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')) as { name?: unknown }

    return typeof name === 'string' ? name : undefined
  }
  catch {
    return undefined
  }
}

// The packages a publish run from here can release: the manifests from here up to the repository root, and the workspace members below that root.
function ownPackages(): Set<string> {
  const names = new Set<string>()
  let folder = process.cwd()

  while (true) {
    const name = manifestName(folder)

    if (name !== undefined)
      names.add(name)

    for (const member of existsSync(join(folder, 'packages')) ? readdirSync(join(folder, 'packages')) : []) {
      const memberName = manifestName(join(folder, 'packages', member))

      if (memberName !== undefined)
        names.add(memberName)
    }

    if (existsSync(join(folder, '.git')) || dirname(folder) === folder)
      return names

    folder = dirname(folder)
  }
}

// `name` of `name@1.2.3`, scope included.
function specName(spec: string): string {
  return spec.slice(0, spec.lastIndexOf('@'))
}

// The registry packages a command adds, as `name` or `name@version`, for `pkg` to check first; after a publish in the same command, an exact version of a package the repository publishes is what it just released, which pkg cannot see yet, so only those are left out.
export function addedPackages(command: string): string[] {
  let published = false
  let own: Set<string> | undefined

  return splitCommand(command).flatMap((piece) => {
    published ||= PUBLISH.test(piece.command)
    const { program, args } = parseCommand(piece.command)
    const [sub = '', ...rest] = args

    const names = piecePackages(program, sub, args, rest)

    if (!published)
      return names

    own ??= ownPackages()

    return names.filter(name => !EXACT_SPEC.test(name) || !own!.has(specName(name)))
  })
}

function piecePackages(program: string, sub: string, args: string[], rest: string[]): string[] {
  if (RUNNERS.has(program))
    return runnerPackages(args)

  if (RUNS[program]?.has(sub))
    return runnerPackages(rest)

  if (!ADDS[program]?.has(sub))
    return []

  return rest.flatMap((word, index) => isSkipped(word, rest[index - 1] ?? '') ? [] : registryName(word))
}

function isSkipped(word: string, previous: string): boolean {
  return word.startsWith('-') || REDIRECT.test(word) || VALUE_FLAGS.has(previous) || BARE_REDIRECT.test(previous)
}

function registryName(word: string): string[] {
  return NOT_REGISTRY.test(word) ? [] : [NPM_ALIAS.exec(word)?.[1] ?? word]
}

// What `bunx`, `npx`, `bun x` and `pnpm dlx` fetch and run: the packages named with -p/--package, else the first word that is not a flag, the rest being the program's own arguments.
function runnerPackages(words: string[]): string[] {
  const named: string[] = []

  for (const [index, word] of words.entries()) {
    const previous = words[index - 1] ?? ''

    if (PACKAGE_FLAGS.has(previous))
      named.push(word)
    else if (word.startsWith('--package='))
      named.push(word.slice('--package='.length))
    else if (!isSkipped(word, previous) && named.length === 0)
      return registryName(word)
    else if (!isSkipped(word, previous))
      break
  }

  return named.flatMap(registryName)
}
