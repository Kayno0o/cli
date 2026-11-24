import type { BinBrief } from './generated-bins'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { xdgFolder } from '@kaynooo/cli-kit'
import { GENERATED_BINS } from './generated-bins'

const JS_EXT = /\.js$/
const WHITESPACE = /\s+/g

// All known @kaynooo/cli-* bins and their compact generated briefs (replaces the hand-maintained prose list).
export const BINS: Record<string, BinBrief> = GENERATED_BINS

interface CachedEntry {
  description?: { summary?: string, replaces?: string }
}

function shorten(text: string, max: number): string {
  const clean = text.replace(WHITESPACE, ' ').trim()

  if (clean.length <= max)
    return clean

  const cut = clean.slice(0, max)
  const sep = Math.max(cut.lastIndexOf('; '), cut.lastIndexOf(', '), cut.lastIndexOf(' '))

  return `${(sep > max * 0.5 ? cut.slice(0, sep) : cut).trimEnd()}…`
}

// Reads the cached KIT_HELP=json descriptions written by `cli list` when available, keyed by bin name.
function cachedBriefs(home = homedir()): Record<string, BinBrief> {
  const cacheBase = xdgFolder(process.env.XDG_CACHE_HOME, join(home, '.cache'))
  const file = join(cacheBase, 'kaynooo-cli', 'bins.json')

  if (!existsSync(file))
    return {}

  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, CachedEntry>
    const result: Record<string, BinBrief> = {}

    for (const [entryPath, entry] of Object.entries(raw)) {
      const summary = entry.description?.summary

      if (typeof summary !== 'string' || summary === '')
        continue

      const replaces = typeof entry.description?.replaces === 'string' ? shorten(entry.description.replaces, 36) : undefined
      const base = entryPath.split('/').at(-1)?.replace(JS_EXT, '') ?? ''

      if (base !== '' && base in GENERATED_BINS)
        result[base] = { summary: shorten(summary, 64), ...(replaces === undefined ? {} : { replaces }) }
    }

    return result
  }
  catch {
    return {}
  }
}

// Compact 2-tier SessionStart index covering all installed bins: one short line per bin, pointing to `<bin> --help` / `cli list` for flags.
export function binsSection(installed: Set<string>, home?: string): string | undefined {
  const live = home === undefined ? {} : cachedBriefs(home)
  const lines = Object.entries(GENERATED_BINS)
    .filter(([bin]) => installed.has(bin))
    .map(([bin, fallback]) => {
      const brief = live[bin] ?? fallback
      const tail = brief.replaces === undefined ? '' : ` (instead of ${brief.replaces})`

      return `- \`${bin}\`: ${brief.summary}${tail}`
    })

  if (lines.length === 0)
    return undefined

  return `# CLIs\n\nInstalled \`@kaynooo/cli-*\` bins (prefer over hand-rolled shell; run \`<bin> --help\` or \`cli list <word>\` for flags):\n${lines.join('\n')}`
}
