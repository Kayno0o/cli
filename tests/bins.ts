import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const PACKAGES = new URL('../packages', import.meta.url).pathname

export function run(source: string, args: string[], env: Record<string, string> = {}): string {
  return Bun.spawnSync([process.execPath, source, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1', ...env } }).stdout.toString()
}

// Every bin the packages install, with the source file it is built from.
export const bins = readdirSync(PACKAGES).flatMap((dir) => {
  const manifest = JSON.parse(readFileSync(join(PACKAGES, dir, 'package.json'), 'utf8')) as { bin?: Record<string, string> }

  return Object.entries(manifest.bin ?? {}).map(([bin, built]) => ({ bin, source: join(PACKAGES, dir, built.replace('./dist/', 'src/').replace('.js', '.ts')) }))
})
