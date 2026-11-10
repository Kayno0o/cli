import type { ExitRow } from '@kaynooo/cli-kit'
import { formatAge, jsonOption, parse, printJson, table } from '@kaynooo/cli-kit'
import { readLedger } from './state'

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
