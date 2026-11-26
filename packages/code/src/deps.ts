import type { ExitRow } from '@kaynooo/cli-kit'
import { existsSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { badUsage, fail, jsonOption, parse, printJson, role } from '@kaynooo/cli-kit'
import { listFiles, MAX_SIZE_OPTION, readText, unreadableReason, useMaxSize } from './files'

const USAGE = `src deps <file|folder>... [--json]: inspects the local dependency graph of JS/TS files

Shows what local files each imports, which files in the repo import it, any circular dependency cycles through it, and any exports unused by other files in the repository. A folder stands for the JS/TS files under it, one report per file.`
const EXITS: ExitRow[] = [[0, 'it inspected the file'], [1, 'a file could not be read, or a folder has no JS/TS file'], [2, 'a usage error']]

const OPTIONS = {
  json: jsonOption('one file {file, imports: string[], importers: string[], cycles: string[][], unusedExports: string[]}, several files or a folder an array of them'),
  ...MAX_SIZE_OPTION,
} as const

const CODE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
const LOADER_BY_EXT: Record<string, 'ts' | 'tsx' | 'js' | 'jsx'> = {
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'jsx',
}
const EXPORT_DECL = /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:type|interface|enum|class|function\*?|const|let|var)\s+([A-Za-z_$][\w$]*)/gm
const EXPORT_LIST = /^\s*export\s+(?:type\s+)?\{([^}]+)\}(?!\s*from\b)/gm
const IMPORT_FROM = /^\s*(?:import|export)\s[^\n'"]+\bfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm
const AS_ALIAS = /\s+as\s+([A-Za-z_$][\w$]*)$/
const TYPE_PREFIX = /^type\s+/
const JS_EXT = /\.[cm]?[jt]sx?$/

export interface DepsReport {
  file: string
  imports: string[]
  importers: string[]
  cycles: string[][]
  unusedExports: string[]
}

function resolveLocal(fromFile: string, specifier: string, cwd: string): string | undefined {
  if (!specifier.startsWith('.'))
    return undefined

  const base = resolve(cwd, dirname(fromFile), specifier)
  const stripped = JS_EXT.test(base) ? base.replace(JS_EXT, '') : base
  const candidates = [
    base,
    ...CODE_EXTS.map(ext => `${stripped}${ext}`),
    ...CODE_EXTS.map(ext => join(base, `index${ext}`)),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate))
      return relative(cwd, candidate)
  }

  return undefined
}

export function scanModule(text: string, path: string): { specifiers: string[], exports: string[] } {
  const loader = LOADER_BY_EXT[extname(path).toLowerCase()]
  const specifiers = new Set<string>()
  const exports = new Set<string>()

  if (loader !== undefined) {
    try {
      const transpiler = new Bun.Transpiler({ loader })
      const scanned = transpiler.scan(text)

      for (const imp of scanned.imports)
        specifiers.add(imp.path)

      for (const exp of scanned.exports) {
        if (exp !== 'default')
          exports.add(exp)
      }
    }
    catch {}
  }

  // Catch type-only imports/exports that the transpiler erases.
  for (const match of text.matchAll(IMPORT_FROM)) {
    const spec = match[1] ?? match[2]

    if (spec !== undefined)
      specifiers.add(spec)
  }

  for (const match of text.matchAll(EXPORT_DECL)) {
    if (match[1] !== undefined)
      exports.add(match[1])
  }

  for (const match of text.matchAll(EXPORT_LIST)) {
    for (const part of (match[1] ?? '').split(',')) {
      const clean = part.trim().replace(TYPE_PREFIX, '')

      if (clean === '')
        continue

      const aliased = AS_ALIAS.exec(clean)
      const name = aliased?.[1] ?? clean

      if (name !== '' && name !== 'default')
        exports.add(name)
    }
  }

  return { specifiers: [...specifiers], exports: [...exports] }
}

function findCyclesFrom(start: string, graph: Map<string, string[]>): string[][] {
  const cycles: string[][] = []
  const seen = new Set<string>()
  const stack: string[] = [start]
  const onStack = new Set<string>([start])
  const visited = new Set<string>()

  function dfs(node: string): void {
    for (const next of graph.get(node) ?? []) {
      if (next === start) {
        const cycle = [...stack, start]
        const key = cycle.join(' -> ')

        if (!seen.has(key)) {
          seen.add(key)
          cycles.push(cycle)
        }

        continue
      }

      if (onStack.has(next) || visited.has(next))
        continue

      stack.push(next)
      onStack.add(next)
      dfs(next)
      stack.pop()
      onStack.delete(next)
    }

    visited.add(node)
  }

  dfs(start)

  return cycles
}

// One report per target, over a graph of the repository's JS/TS files built once.
export async function analyzeDeps(targetPaths: readonly string[], cwd: string): Promise<DepsReport[]> {
  const targets: string[] = []
  const targetTexts = new Map<string, string>()

  for (const targetPath of targetPaths) {
    const abs = resolve(cwd, targetPath)
    const target = relative(cwd, abs)
    const text = await readText(abs)

    if (text === undefined)
      fail(`cannot read ${targetPath} (${await unreadableReason(abs)})`, 1)

    targets.push(target)
    targetTexts.set(target, text)
  }

  const allFiles = (await listFiles([], cwd)).filter(file => LOADER_BY_EXT[extname(file).toLowerCase()] !== undefined)
  const fileTexts = new Map<string, string>()
  const graph = new Map<string, string[]>()

  function addToGraph(file: string, text: string): void {
    fileTexts.set(file, text)
    graph.set(file, [...new Set(scanModule(text, file).specifiers.map(spec => resolveLocal(file, spec, cwd)).filter((item): item is string => item !== undefined))].sort())
  }

  await Promise.all(allFiles.map(async (file) => {
    const text = targetTexts.get(file) ?? await readText(join(cwd, file))

    if (text !== undefined)
      addToGraph(file, text)
  }))

  for (const [target, text] of targetTexts) {
    if (!graph.has(target))
      addToGraph(target, text)
  }

  return targets.map((target) => {
    const targetText = targetTexts.get(target) ?? ''
    const importers = [...graph.entries()].filter(([file, deps]) => file !== target && deps.includes(target)).map(([file]) => file).sort()
    const importerTexts = importers.map(file => fileTexts.get(file) ?? '')
    const unusedExports = scanModule(targetText, target).exports.filter((name) => {
      const word = new RegExp(String.raw`(?<![\w$])${name}(?![\w$])`)

      return !importerTexts.some(text => word.test(text))
    }).sort()

    return { file: target, imports: graph.get(target) ?? [], importers, cycles: findCyclesFrom(target, graph), unusedExports }
  })
}

// The files named, a folder standing for the JS/TS files under it; an explicit file is kept whatever its extension.
async function expandTargets(positionals: readonly string[], cwd: string): Promise<string[]> {
  const targets: string[] = []

  for (const positional of positionals) {
    if (statSync(resolve(cwd, positional), { throwIfNoEntry: false })?.isDirectory() !== true) {
      targets.push(positional)

      continue
    }

    const inside = (await listFiles([positional], cwd)).filter(file => LOADER_BY_EXT[extname(file).toLowerCase()] !== undefined)

    if (inside.length === 0)
      fail(`no JS/TS file under ${positional}`, 1)

    targets.push(...inside)
  }

  return [...new Set(targets)]
}

function printReport(report: DepsReport): void {
  const p = role('path', process.stdout)
  const label = role('label', process.stdout)
  const warnRole = role('warn', process.stdout)

  console.log(p(report.file))
  console.log(`${label('imports')} (${report.imports.length}):${report.imports.length === 0 ? ' none' : ''}`)

  for (const file of report.imports)
    console.log(`  ${file}`)

  console.log(`${label('importers')} (${report.importers.length}):${report.importers.length === 0 ? ' none' : ''}`)

  for (const file of report.importers)
    console.log(`  ${file}`)

  if (report.cycles.length > 0) {
    console.log(`${warnRole('cycles')} (${report.cycles.length}):`)

    for (const cycle of report.cycles)
      console.log(`  ${cycle.join(' -> ')}`)
  }

  if (report.unusedExports.length > 0) {
    console.log(`${warnRole('unused exports')} (${report.unusedExports.length}):`)
    console.log(`  ${report.unusedExports.join(', ')}`)
  }
}

export async function deps(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, USAGE, OPTIONS, { exits: EXITS, positionals: ['<file|folder>...'], examples: [['src deps packages/kit/src/args.ts', 'imports, importers, cycles and unused exports'], ['src deps src/a.ts src/b.ts', 'one report per file'], ['src deps packages/kit/src', 'one report per JS/TS file in the folder']] })

  if (positionals.length === 0)
    badUsage('give a file or a folder')

  useMaxSize(values['max-size'])

  const cwd = process.cwd()
  const reports = await analyzeDeps(await expandTargets(positionals, cwd), cwd)

  if (values.json === true) {
    // One explicit file keeps the single object it always printed.
    printJson(reports.length === 1 && positionals.length === 1 && reports[0]?.file === relative(cwd, resolve(cwd, positionals[0] ?? '')) ? reports[0] : reports)

    return 0
  }

  for (const [index, report] of reports.entries()) {
    if (index > 0)
      console.log()

    printReport(report)
  }

  return 0
}
