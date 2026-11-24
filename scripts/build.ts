import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import process from 'node:process'
import { shellShebang } from './shell-shebang'

const args = process.argv.slice(2)
const entrypoints: string[] = []
const external: string[] = []
let root: string | undefined
let outdir = 'dist'
let splitting = false

for (let i = 0; i < args.length; i++) {
  const arg = args[i]!

  if (arg === '--splitting')
    splitting = true
  else if (arg === '--root')
    root = args[++i]
  else if (arg === '--outdir')
    outdir = args[++i] ?? outdir
  else if (arg === '--external')
    external.push(args[++i] ?? '')
  else
    entrypoints.push(arg)
}

if (entrypoints.length === 0) {
  console.error('usage: bun scripts/build.ts <entry...> [--root <dir>] [--outdir <dir>] [--splitting] [--external <pkg>...]')
  process.exit(2)
}

const stage = `${outdir}.tmp-${process.pid}-${Date.now()}`

try {
  const built = await Bun.build({
    entrypoints,
    outdir: stage,
    target: 'bun',
    splitting: splitting || entrypoints.length > 1,
    minify: { whitespace: true, syntax: true },
    ...(root === undefined ? {} : { root }),
    ...(external.length === 0 ? {} : { external }),
  })

  if (!built.success) {
    for (const log of built.logs)
      console.error(log)

    process.exit(1)
  }

  const kept = new Set<string>()

  for (const file of readdirSync(stage, { recursive: true, encoding: 'utf8' })) {
    if (!file.endsWith('.js'))
      continue

    const path = join(stage, file)
    const rewritten = shellShebang(readFileSync(path, 'utf8'))

    if (rewritten !== undefined) {
      writeFileSync(path, rewritten)
      chmodSync(path, 0o755)
    }

    kept.add(file)
  }

  mkdirSync(outdir, { recursive: true })

  for (const file of kept) {
    const dest = join(outdir, file)

    mkdirSync(join(dest, '..'), { recursive: true })
    renameSync(join(stage, file), dest)
  }

  // Remove stale outputs left from older builds without ever leaving an active bin missing mid-build.
  for (const file of readdirSync(outdir, { recursive: true, encoding: 'utf8' })) {
    if (file.endsWith('.js') && !kept.has(file) && !basename(file).startsWith('.'))
      rmSync(join(outdir, file), { force: true })
  }
}
finally {
  rmSync(stage, { recursive: true, force: true })
}
