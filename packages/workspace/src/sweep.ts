import type { Outcome } from './apply'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { badUsage, duration, fail, formatAge, formatFileSize, jsonOption, note, ok, parse, parseSize, printJson, problem, runTool, table } from '@kaynooo/cli-kit'
import { confirm } from '@kaynooo/cli-kit/prompt'
import { applyAll } from './apply'
import { findCandidates, inspect, MAX_DEPTH } from './sweep-scan'

const USAGE = `sweep [options] [root]: lists the regenerable folders (node_modules, .output, dist, build, target beside a Cargo.toml), the caches (.nuxt, .next, .turbo, .svelte-kit and node_modules/.cache per project; ~/.bun/install/cache, ~/.npm/_cacache, ~/.cache/{pip,uv,ms-playwright,puppeteer,go-build,typescript} and ~/.cargo/registry, exact paths only, listed only when no root is given or with --only caches) and the .worktrees/* and .claude/worktrees/* entries under root (~/Workspace by default, ${MAX_DEPTH} levels down), largest first with the age of the repo's last commit; --only worktrees, folders or caches keeps one kind

Dry unless --apply, which deletes after a confirm showing the total (read from the terminal; off one, pass --yes). A folder is deleted for good, not trashed. Never touched: a symlink, a folder git tracks files in, a build folder git does not ignore. A worktree is removed with git worktree remove, never forced, and only when it is clean and every commit of its branch is on another branch or a remote; the others stay listed as kept and count for nothing in the total. With --docker the Docker usage comes after the list, left to dclean.

Exits 0 when it listed, or removed every entry it was allowed to, 1 when a removal failed or the confirm was declined, 2 on a usage error, a missing root, or --apply off a terminal without --yes.`

const ONLY_KINDS = { worktrees: 'worktree', folders: 'folder', caches: 'cache' } as const

const OPTIONS = {
  apply: { type: 'boolean', description: 'delete what is listed as removable, after the confirm' },
  yes: { type: 'boolean', short: 'y', description: 'with --apply, skip the confirm' },
  older: { type: 'string', description: 'only the entries whose repo last committed longer ago than this (30d, 12h)' },
  min: { type: 'string', description: 'only the entries of at least this size (500K, 10M, 1G)' },
  only: { type: 'string', description: 'worktrees, folders or caches: leave the other kinds out (.nuxt, .next, .turbo and .svelte-kit are caches; the global caches are listed with no root or with caches)' },
  docker: { type: 'boolean', description: 'add the docker system df output, which alone takes about ten seconds' },
  json: jsonOption('{root, entries: [{path, kind (folder, worktree or cache), bytes, committedAt, action (remove or keep), reason}], skipped: [{path, reason}], reclaimable, docker, removed?}'),
} as const

async function dockerUsage(): Promise<string | undefined> {
  if (Bun.which('docker') === null)
    return undefined

  try {
    const { code, stdout } = await runTool('docker system df', ['docker', 'system', 'df'], { timeoutMs: 10_000 })

    return code === 0 ? stdout.trimEnd() : undefined
  }
  catch {
    return undefined
  }
}

export async function sweep(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, USAGE, OPTIONS, { positionals: ['[root]'], replaces: 'find ~/Workspace -name node_modules, du -sh and rm -rf by hand', examples: ['sweep', 'sweep ~/Workspace --older 30d --min 100M --apply', 'sweep --only worktrees --apply'] })

  if (positionals.length > 1)
    badUsage('give one root')

  const root = resolve(positionals[0] ?? join(homedir(), 'Workspace'))

  if (!existsSync(root) || !statSync(root).isDirectory())
    fail(`${root} is not a folder`)

  if (values.only !== undefined && !Object.hasOwn(ONLY_KINDS, values.only))
    badUsage(`--only takes worktrees, folders or caches, not ${values.only}`)

  const olderMs = values.older === undefined ? undefined : duration(values.older, 'older', 0)
  const minBytes = values.min === undefined ? 0 : parseSize(values.min)

  if (minBytes === undefined)
    badUsage(`--min takes a size such as 500K, 10M or 1G, not ${values.min}`)

  const now = Date.now()
  const found = await findCandidates(root, homedir(), positionals.length === 0 || values.only === 'caches')
  const wanted = values.only === undefined ? found.candidates : found.candidates.filter(candidate => candidate.kind === ONLY_KINDS[values.only as keyof typeof ONLY_KINDS])
  const { entries: all, skipped } = await inspect({ candidates: wanted, skipped: found.skipped })
  const entries = all
    .filter(entry => entry.bytes >= minBytes && (olderMs === undefined || (entry.committedAt !== undefined && now - entry.committedAt >= olderMs)))
    .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))
  const removable = entries.filter(entry => entry.action === 'remove')
  const reclaimable = removable.reduce((sum, entry) => sum + entry.bytes, 0)
  const docker = values.docker === true ? await dockerUsage() : undefined
  const json = values.json === true

  if (values.apply === true && removable.length > 0 && values.yes !== true) {
    if (!json)
      print(root, entries, skipped.length, reclaimable, now)

    const agreed = await confirm(`Delete ${removable.length} ${removable.length === 1 ? 'entry' : 'entries'} (${formatFileSize(reclaimable)})?`, { default: false, hint: 'pass --yes to skip the confirm' })

    if (agreed !== true) {
      if (json)
        fail('nothing deleted: the confirm was declined', 1, 'pass --yes to skip the confirm')

      note('nothing deleted')

      return 1
    }
  }

  const outcomes = values.apply === true ? await applyAll(removable, outcome => report(root, outcome, json)) : undefined
  const failed = outcomes?.filter(outcome => !outcome.removed).length ?? 0

  if (json) {
    printJson({ root, entries: entries.map(entry => ({ path: entry.path, kind: entry.kind, bytes: entry.bytes, committedAt: entry.committedAt === undefined ? null : new Date(entry.committedAt).toISOString(), action: entry.action, reason: entry.reason ?? null })), skipped, reclaimable, docker: docker ?? null, ...(outcomes === undefined ? {} : { removed: outcomes }) })

    return failed === 0 ? 0 : 1
  }

  if (outcomes === undefined) {
    print(root, entries, skipped.length, reclaimable, now)

    if (removable.length > 0)
      console.log('dry run, pass --apply to delete')
  }
  else {
    const bytes = new Map(removable.map(entry => [entry.path, entry.bytes]))

    note(`freed ${formatFileSize(outcomes.reduce((sum, outcome) => sum + (outcome.removed ? bytes.get(outcome.path) ?? 0 : 0), 0))}`)
  }

  if (docker !== undefined)
    console.log(`\ndocker (left to dclean):\n${docker}`)

  return failed === 0 ? 0 : 1
}

function report(root: string, outcome: Outcome, json: boolean): void {
  if (json)
    return

  if (outcome.removed)
    ok(`removed ${relative(root, outcome.path)}`)
  else
    problem(`kept ${relative(root, outcome.path)}`, outcome.error)
}

function print(root: string, entries: Awaited<ReturnType<typeof inspect>>['entries'], skipped: number, reclaimable: number, now: number): void {
  if (entries.length === 0) {
    console.log('nothing to sweep')

    return
  }

  console.log(table([['size', 'age', 'what', 'path', 'note'], ...entries.map(entry => [formatFileSize(entry.bytes), entry.committedAt === undefined ? '-' : formatAge(entry.committedAt, now), entry.kind, relative(root, entry.path), entry.action === 'keep' ? `kept: ${entry.reason}` : ''])], { header: true, align: ['right', 'right', 'left', 'left', 'left'] }))
  console.log(`\n${formatFileSize(reclaimable)} reclaimable${skipped === 0 ? '' : `, ${skipped} skipped (symlinks, tracked or not ignored by git)`}`)
}
