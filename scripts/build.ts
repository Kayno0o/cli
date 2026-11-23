import { chmodSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

rmSync(outdir, { recursive: true, force: true })

const built = await Bun.build({
  entrypoints,
  outdir,
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

for (const file of readdirSync(outdir, { recursive: true, encoding: 'utf8' })) {
  if (!file.endsWith('.js'))
    continue

  const path = join(outdir, file)
  const rewritten = shellShebang(readFileSync(path, 'utf8'))

  if (rewritten !== undefined) {
    writeFileSync(path, rewritten)
    chmodSync(path, 0o755)
  }
}
