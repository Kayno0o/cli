import type { ExitRow } from '@kaynooo/cli-kit'
import { capped, jsonOption, limitOf, limitOptions, parse, printJson, table, workspaceRoot } from '@kaynooo/cli-kit'
import { findConsumers, similarDependencies } from '../consumers'
import { ROOT_OPTION } from './bump'

const usage = `pkg consumers <name>

Lists the folders under --root whose package.json depends on the package, by its own name or through an \`npm:\` alias of it (the alias key is shown after the kind): the folder, the kind of dependency, the version it asks for and the manager its lockfile pins, 30 at most with the count of the rest after them (--limit <n>, --full for all; --json is never cut unless --limit is given).`
const EXITS: ExitRow[] = [[0, 'it listed them'], [2, 'a usage error']]

const CONSUMERS_LIMIT = 30

const options = {
  root: ROOT_OPTION,
  ...limitOptions(CONSUMERS_LIMIT),
  json: jsonOption('[{dir, path, kind, spec, manager}]'),
} as const

export function consumers(args: string[]): number {
  const { values, positionals: [name] } = parse(args, usage, options, { exits: EXITS, positionals: ['<name>'] })
  const root = workspaceRoot({ given: values.root })
  const { shown, footer } = capped(findConsumers(name, root), limitOf(values, CONSUMERS_LIMIT))

  if (values.json === true) {
    printJson(shown)
  }
  else if (shown.length === 0) {
    const similar = similarDependencies(name, root)

    console.log(`nothing under ${root} depends on ${name}${similar.length === 0 ? '' : `, did you mean ${similar.join(', ')}`}`)
  }
  else {
    console.log([table([['FOLDER', 'KIND', 'VERSION', 'MANAGER'], ...shown.map(each => [each.dir, each.alias === undefined ? each.kind : `${each.kind} as ${each.alias}`, each.spec, each.manager])], { header: true }), ...footer === undefined ? [] : [footer]].join('\n'))
  }

  return 0
}
