#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { findIcons } from '@kayjs/icons/search'
import { badUsage, fail, jsonOption, parse, printJson, runMain, wholeNumber } from '@kaynooo/cli-kit'

const USAGE = `icons [options] <words>: finds the icons of the project's iconify sets by name, related word, typo or half-typed word

Searches every @iconify-json/* set installed in the nearest node_modules, and prints each found icon as <set>:<name>, best first, up to --limit per set.
Beyond the names holding the words, it finds the icons a related word names (garbage finds trash, dark mode finds moon), a typo (calnedar) or a half-typed word (shopp), from a word table built offline: English only, no network.`

const EXITS: ExitRow[] = [[0, 'it searched, found icons or not'], [1, 'no icon set installed'], [2, 'a usage error']]

const OPTIONS = {
  set: { type: 'string', description: 'search only this set, by its prefix (tabler)' },
  limit: { type: 'string', description: 'icons per set, 10 by default' },
  json: jsonOption('[{set, name}]'),
} as const

const DEFAULT_LIMIT = 10

interface IconifyJson { prefix: string, icons: Record<string, unknown>, aliases?: Record<string, unknown> }

// The @iconify-json folder of the nearest node_modules holding one, from `from` up.
function setsFolder(from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const folder = join(dir, 'node_modules/@iconify-json')

    if (existsSync(folder))
      return folder

    if (dirname(dir) === dir)
      return undefined
  }
}

async function main(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, USAGE, OPTIONS, { exits: EXITS, replaces: 'guessing icon names, or searching icones.js.org by hand', examples: ['icons garbage', 'icons --set tabler dark mode', 'icons --json calnedar'] })
  const query = positionals.map(String).join(' ').trim()
  const limit = wholeNumber(values.limit, 'limit', DEFAULT_LIMIT)

  if (query === '')
    badUsage('give the words to search for')

  const folder = setsFolder(process.cwd())
  const prefixes = folder === undefined ? [] : [...new Bun.Glob('*/icons.json').scanSync({ cwd: folder, followSymlinks: true })].map(dirname).sort()
  const searched = values.set === undefined ? prefixes : prefixes.filter(prefix => prefix === values.set)

  if (searched.length === 0)
    fail(values.set === undefined ? 'no icon set installed in this project' : `the set ${values.set} is not installed in this project`, 1, `install one, such as bun add -d @iconify-json/${values.set ?? 'tabler'}`)

  const found: { set: string, name: string }[] = []

  for (const prefix of searched) {
    const set = await Bun.file(join(folder!, prefix, 'icons.json')).json() as IconifyJson

    for (const name of findIcons(set, query, { limit }))
      found.push({ set: set.prefix, name })
  }

  if (values.json === true)
    printJson(found)
  else if (found.length > 0)
    console.log(found.map(({ set, name }) => `${set}:${name}`).join('\n'))

  return 0
}

process.exitCode = await runMain({ name: 'icons', run: main })
