#!/usr/bin/env bun

import type { Finding, Severity } from './report'
import { existsSync, readdirSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fail, jsonOption, oneOf, paint, parse, printJson, role, runCommand, runMain, table } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { directDependencies, findingsOf, parseAudit, SEVERITIES, workspaceFolders } from './report'

const USAGE = `audit [options] [root]: the known vulnerabilities of the Bun repositories under root (the current folder by default), one table per repository

Each package with an advisory is one row: its worst severity, how many advisories, whether a production dependency needs it (prod) or only a development one (dev), whether the repository asks for it itself (direct) or a dependency does (the row then says via), and the version that fixes every advisory at once, "-" when an advisory names none. The worst and the production ones come first.
It runs \`bun audit --json\` in each repository holding a bun.lock, which reaches the registry; the walk goes three levels deep, stops at a bun.lock and skips node_modules and hidden folders.

Exits 0 when no repository has an advisory at the level asked, 1 when one has or a repository's audit failed, 2 on a usage error or a root that is no folder.`

const OPTIONS = {
  level: { type: 'string', choices: SEVERITIES, default: 'moderate', description: 'only the advisories at least this severe: low, moderate, high or critical' },
  prod: { type: 'boolean', description: 'only the packages a production dependency needs' },
  json: jsonOption('[{repo, path, findings: [{package, severity, advisories, titles, scope, direct, fix}], error}]'),
} as const

const MAX_DEPTH = 3
const CONCURRENCY = 4
const AUDIT_MS = 60_000

interface RepoAudit {
  repo: string
  path: string
  findings: Finding[]
  error: string | undefined
}

function holdsLock(dir: string): boolean {
  return existsSync(join(dir, 'bun.lock')) || existsSync(join(dir, 'bun.lockb'))
}

async function findRepos(root: string): Promise<string[]> {
  if (holdsLock(root))
    return [root]

  const found: string[] = []

  async function walk(dir: string, depth: number): Promise<void> {
    let entries

    try {
      entries = await readdir(dir, { withFileTypes: true })
    }
    catch {
      return
    }

    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.'))
        continue

      const path = join(dir, entry.name)

      if (holdsLock(path))
        found.push(path)
      else if (depth < MAX_DEPTH)
        await walk(path, depth + 1)
    }
  }

  await walk(root, 1)

  return found
}

async function pool<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = Array.from<R>({ length: items.length })
  let next = 0

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++

      results[index] = await task(items[index] as T)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))

  return results
}

function children(root: string): (folder: string) => string[] {
  return (folder) => {
    try {
      return readdirSync(join(root, folder), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
    }
    catch {
      return []
    }
  }
}

async function audited(path: string, shown: string, level: Severity): Promise<RepoAudit> {
  const [all, production] = await Promise.all([
    runCommand(['bun', 'audit', '--json'], { cwd: path, timeoutMs: AUDIT_MS }),
    runCommand(['bun', 'audit', '--json', '--prod'], { cwd: path, timeoutMs: AUDIT_MS }),
  ])
  const stdout = (code: Awaited<ReturnType<typeof runCommand>>) => Buffer.concat(code.chunks.filter(chunk => chunk.stream === 'stdout').map(chunk => chunk.data)).toString()
  const audit = parseAudit(stdout(all))

  if (audit === undefined) {
    const why = all.timedOut ? `timed out after ${AUDIT_MS / 1000}s` : all.text.trim().split('\n').at(-1) ?? `exit ${all.code}`

    return { repo: shown, path, findings: [], error: why }
  }

  const reaching = new Set(Object.keys(parseAudit(stdout(production)) ?? {}))
  const direct = directDependencies(path, workspaceFolders(path, children(path)))

  return { repo: shown, path, findings: findingsOf(audit, reaching, direct, level), error: undefined }
}

function tint(severity: Severity): (text: string) => string {
  const colors = paint(process.stdout)

  if (severity === 'critical' || severity === 'high')
    return colors.red

  return severity === 'moderate' ? colors.yellow : colors.dim
}

function rows(findings: Finding[]): string[][] {
  return findings.map(found => [
    found.package,
    tint(found.severity)(found.severity),
    String(found.advisories),
    found.scope,
    found.direct ? 'direct' : 'via',
    found.fix ?? '-',
  ])
}

async function main(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, USAGE, OPTIONS, { positionals: ['[root]'], replaces: 'a bun audit run in each repository and a read of every advisory to find what is worth fixing', examples: ['audit', 'audit ~/Workspace --level high --prod'] })
  const root = resolve(positionals[0] ?? '.')

  if (!existsSync(root))
    fail(`no folder ${root}`)

  const level = oneOf(values.level, 'level', SEVERITIES)
  const paths = await findRepos(root)

  if (paths.length === 0)
    fail(`no bun.lock under ${root}`, 1)

  const audits = await pool(paths, CONCURRENCY, async path => audited(path, relative(root, path) || '.', level))
  const kept = audits.map(each => ({ ...each, findings: values.prod === true ? each.findings.filter(found => found.scope === 'prod') : each.findings }))

  if (values.json === true)
    printJson(kept)
  else
    show(kept, audits.length)

  return kept.some(each => each.error !== undefined || each.findings.length > 0) ? 1 : 0
}

function show(audits: RepoAudit[], total: number): void {
  const label = role('label', process.stdout)
  const path = role('path', process.stdout)
  const flagged = audits.filter(each => each.error !== undefined || each.findings.length > 0)

  if (flagged.length === 0) {
    console.log(label(`no advisory in ${total} ${total === 1 ? 'repository' : 'repositories'}`))

    return
  }

  for (const each of flagged) {
    console.log(`${path(each.repo)} ${label(each.error === undefined ? `${each.findings.length} ${each.findings.length === 1 ? 'package' : 'packages'}` : `audit failed: ${each.error}`)}`)

    if (each.findings.length > 0)
      console.log(table([['package', 'severity', 'advisories', 'scope', 'reached', 'fix'], ...rows(each.findings)], { header: true, align: ['left', 'left', 'right', 'left', 'left', 'left'] }))
  }
}

process.exitCode = await runMain({ name: 'audit', version, run: main })
