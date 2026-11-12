import type { ExitRow, Ran } from '@kaynooo/cli-kit'
import type { Finding, Severity } from './report'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { configuredNumber, fail, jsonOption, oneOf, paint, parse, pool, printJson, role, runCommand, table } from '@kaynooo/cli-kit'
import { progressLine } from '@kaynooo/cli-kit/progress'
import { holdsOsvLock, osvAudit } from './osv'
import { directDependencies, findingsOf, lockGraph, parseAudit, reachedFrom, SEVERITIES, workspaceFolders } from './report'

const USAGE = `ws audit [options] [root]: the known vulnerabilities of the Bun, Composer, Cargo and uv repositories under root (the current folder by default), one table per repository

Each package with an advisory is one row: its worst severity, how many advisories, whether a production dependency needs it (prod) or only a development one (dev), whether the repository asks for it itself (direct) or a dependency does (the row then says via and the direct dependencies leading to it, upgrading one of which is what fixes it), and the version that fixes every advisory at once, "-" when an advisory names none. The worst and the production ones come first.
Advisories under --level (moderate by default) are counted under the table, and what \`bun audit\` warned about, such as a private registry that would not audit its packages, is repeated there. It runs \`bun audit --json\` in each repository holding a bun.lock, which reaches the registry, and asks osv.dev about the packages of a composer.lock, Cargo.lock or uv.lock (a severity the source leaves out reads as moderate, and only composer's manifest tells direct from pulled in); the walk goes three levels deep, stops at a lockfile and skips node_modules and hidden folders.

Reach for it to sweep many repositories at once; \`pkg audit\` vets the one repository in a folder (package age, install scripts, licences) as well as its advisories, and shares --level, --prod and --ignore.`

const EXITS: ExitRow[] = [[0, 'no repository has an advisory at the level asked'], [1, 'one has'], [2, 'a repository\'s audit failed, no lockfile sits under root, a usage error or a root that is no folder']]

const OPTIONS = {
  level: { type: 'string', choices: SEVERITIES, default: 'moderate', description: 'only the advisories at least this severe: low, moderate, high or critical' },
  prod: { type: 'boolean', description: 'only the packages a production dependency needs' },
  ignore: { type: 'string', multiple: true, description: 'an advisory skipped by GHSA or numeric id, repeatable' },
  json: jsonOption('[{repo, path, findings: [{package, severity, scope, direct, via, fix, advisories: [{id, ghsa, url, title, severity, fixed}]}], below: advisories under --level, warnings: what bun audit could not audit, error}]'),
} as const

const MAX_DEPTH = 3
const CONCURRENCY = 4
const AUDIT_MS = 60_000

interface RepoAudit {
  repo: string
  path: string
  findings: Finding[]
  /** Advisories under the level asked, counted so the table says what it leaves out. */
  below: number
  /** What `bun audit` said about packages it could not audit, such as a private registry answering 403. */
  warnings: string[]
  error: string | undefined
}

const WARNING = /^warn: .+$/gm
const VIA_SHOWN = 2

function countAdvisories(findings: Finding[]): number {
  return findings.reduce((sum, found) => sum + found.advisories.length, 0)
}

function holdsBunLock(dir: string): boolean {
  return existsSync(join(dir, 'bun.lock')) || existsSync(join(dir, 'bun.lockb'))
}

function holdsLock(dir: string): boolean {
  return holdsBunLock(dir) || holdsOsvLock(dir)
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

async function audited(path: string, shown: string, level: Severity, ignore: readonly string[]): Promise<RepoAudit> {
  const bun = holdsBunLock(path) ? await bunAudited(path, shown, level, ignore) : { repo: shown, path, findings: [], below: 0, warnings: [], error: undefined }

  if (bun.error !== undefined || !holdsOsvLock(path))
    return bun

  try {
    const osv = await osvAudit(path, level, ignore)

    return { ...bun, findings: [...bun.findings, ...osv.findings], below: bun.below + osv.below }
  }
  catch (error) {
    return { ...bun, error: `osv.dev: ${error instanceof Error ? error.message : String(error)}` }
  }
}

async function bunAudited(path: string, shown: string, level: Severity, ignore: readonly string[]): Promise<RepoAudit> {
  const [all, production] = await Promise.all([
    runCommand(['bun', 'audit', '--json'], { cwd: path, timeoutMs: AUDIT_MS }),
    runCommand(['bun', 'audit', '--json', '--prod'], { cwd: path, timeoutMs: AUDIT_MS }),
  ])
  const audit = parseAudit(stdoutOf(all))
  const reached = parseAudit(stdoutOf(production))

  if (audit === undefined || reached === undefined)
    return { repo: shown, path, findings: [], below: 0, warnings: [], error: failure(audit === undefined ? all : production) }

  const reaching = new Set(Object.keys(reached))
  const direct = directDependencies(path, workspaceFolders(path, children(path)))
  const via = reachedFrom(lockGraph(lockText(path)), direct, new Set(Object.keys(audit)))
  const findings = findingsOf(audit, reaching, direct, level, ignore, via)

  return { repo: shown, path, findings, below: countAdvisories(findingsOf(audit, reaching, direct, 'low', ignore)) - countAdvisories(findings), warnings: [...new Set(all.text.match(WARNING) ?? [])], error: undefined }
}

function lockText(path: string): string {
  try {
    return readFileSync(join(path, 'bun.lock'), 'utf8')
  }
  catch {
    return ''
  }
}

/** Where a package came from: `direct`, or `via` the packages the repository asks for that lead to it. */
function originOf(found: Finding): string {
  if (found.direct)
    return 'direct'

  if (found.via.length === 0)
    return 'via'

  return `via ${found.via.slice(0, VIA_SHOWN).join(', ')}${found.via.length > VIA_SHOWN ? ` +${found.via.length - VIA_SHOWN}` : ''}`
}

function stdoutOf(ran: Ran): string {
  return Buffer.concat(ran.chunks.filter(chunk => chunk.stream === 'stdout').map(chunk => chunk.data)).toString()
}

function failure(ran: Ran): string {
  return ran.timedOut ? `timed out after ${AUDIT_MS / 1000}s` : ran.text.trim().split('\n').at(-1) ?? `exit ${ran.code}`
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
    String(found.advisories.length),
    found.scope,
    originOf(found),
    found.fix ?? '-',
  ])
}

export async function audit(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, USAGE, OPTIONS, { positionals: ['[root]'], exits: EXITS, replaces: 'a bun audit run in each repository and a read of every advisory to find what is worth fixing', examples: ['ws audit', 'ws audit ~/Workspace --level high --prod'] })
  const root = resolve(positionals[0] ?? '.')

  if (!existsSync(root) || !statSync(root).isDirectory())
    fail(`no folder ${root}`)

  const level = oneOf(values.level, 'level', SEVERITIES)
  const progress = progressLine()
  let audits: RepoAudit[]

  try {
    progress.update({ step: 'finding the repositories' })
    const paths = await findRepos(root)

    if (paths.length === 0)
      fail(`no bun.lock, composer.lock, Cargo.lock or uv.lock under ${root}`)

    progress.update({ step: 'auditing', done: 0, total: paths.length, unit: 'repositories' })
    audits = await pool(paths, configuredNumber('audit', 'concurrency', CONCURRENCY), async path => audited(path, relative(root, path) || '.', level, values.ignore ?? []), (done, total) => progress.update({ step: 'auditing', done, total, unit: 'repositories' }))
  }
  finally {
    progress.stop()
  }

  const kept = audits.map(each => ({ ...each, findings: values.prod === true ? each.findings.filter(found => found.scope === 'prod') : each.findings }))

  if (values.json === true)
    printJson(kept)
  else
    show(kept, audits.length)

  if (kept.some(each => each.error !== undefined))
    return 2

  return kept.some(each => each.findings.length > 0) ? 1 : 0
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
      console.log(table([['package', 'severity', 'advisories', 'scope', 'origin', 'fix'], ...rows(each.findings)], { header: true, align: ['left', 'left', 'right', 'left', 'left', 'left'] }))

    if (each.findings.some(found => !found.direct))
      console.log(label('via: a dependency of the ones named, fixed by upgrading one of them to a release that depends on the fixed version'))

    if (each.below > 0)
      console.log(label(`${each.below} ${each.below === 1 ? 'advisory' : 'advisories'} below the level left out, --level low lists them`))

    for (const warning of each.warnings)
      console.log(label(warning))
  }
}
