import type { ExitRow } from '@kaynooo/cli-kit'
import { existsSync, rmSync } from 'node:fs'
import { fail, formatAge, jsonOption, parse, printJson, table } from '@kaynooo/cli-kit'
import { readLedger, removeFromLedger } from './state'

const USAGE = `dl ls [options]: lists the commands dl installed with --bin and the scripts it ran with --exec, with where each came from and when

A command installed again, or a script run again, keeps one line, the latest.`

const EXITS: ExitRow[] = [[0, 'listed, even nothing'], [2, 'a usage error']]

export function ls(args: string[]): number {
  const { values } = parse(args, USAGE, { json: jsonOption() }, {
    exits: EXITS,
    replaces: 'remembering which tools came from a curl and from where',
    examples: ['dl ls', 'dl ls --json'],
  })
  const entries = readLedger().sort((a, b) => a.name.localeCompare(b.name))

  if (values.json === true)
    printJson(entries)
  else if (entries.length === 0)
    console.log('nothing installed or run through dl yet')
  else
    console.log(table([['name', 'kind', 'when', 'sha256', 'from'], ...entries.map(entry => [entry.name, entry.kind, formatAge(entry.at), entry.sha256.slice(0, 12), entry.url])], { header: true }))

  return 0
}

const RM_USAGE = `dl rm [options] <name...>: uninstalls a command dl installed (deleting its binary) and removes the entry from the ledger

Alias: dl uninstall. Use --keep-file to untrack a binary without deleting it from disk.`

const RM_EXITS: ExitRow[] = [[0, 'removed every named entry'], [1, 'a named entry was not found in the ledger'], [2, 'a usage error']]

export function rm(args: string[]): number {
  const { values, positionals } = parse(args, RM_USAGE, {
    'keep-file': { type: 'boolean', description: 'remove from the ledger without deleting the installed binary' },
    'json': jsonOption('{removed: [{name, kind, path?, deleted}]}'),
  }, {
    exits: RM_EXITS,
    positionals: ['<name...>'],
    replaces: 'rm ~/.local/bin/<tool> and editing the ledger by hand',
    examples: ['dl rm rg', ['dl uninstall tool --keep-file', 'untrack without deleting']],
  })
  const ledger = readLedger()
  const missing = positionals.filter(name => !ledger.some(entry => entry.name === name))

  if (missing.length > 0)
    return fail(`dl installed or ran nothing named ${missing.join(', ')}`, 1, 'dl ls lists what it did')

  const removed = removeFromLedger(positionals)
  const results = removed.map((entry) => {
    let deleted = false

    if (entry.kind === 'bin' && entry.path !== undefined && values['keep-file'] !== true && existsSync(entry.path)) {
      rmSync(entry.path, { force: true })
      deleted = true
    }

    return { name: entry.name, kind: entry.kind, ...entry.path === undefined ? {} : { path: entry.path }, deleted }
  })

  if (values.json === true) {
    printJson({ removed: results })

    return 0
  }

  for (const item of results)
    console.log(item.deleted ? `removed ${item.name} (${item.path})` : `untracked ${item.name}`)

  return 0
}
