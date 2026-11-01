import { homedir } from 'node:os'
import { join } from 'node:path'
import { jsonOption, parse, printJson, table } from '@kaynooo/cli-kit'
import { findConsumers } from '../consumers'
import { ROOT_OPTION } from './bump'

const usage = `pkg consumers <name>

Lists the folders under --root whose package.json depends on the package: the folder, the kind of dependency, the version it asks for and the manager its lockfile pins.

Exits 0 when it listed them, 2 on a usage error.`

const options = {
  root: ROOT_OPTION,
  json: jsonOption('[{dir, path, kind, spec, manager}]'),
} as const

export function consumers(args: string[]): number {
  const { values, positionals: [name] } = parse(args, usage, options, { positionals: ['<name>'] })
  const root = values.root ?? join(homedir(), 'Workspace')
  const found = findConsumers(name, root)

  if (values.json === true)
    printJson(found)
  else if (found.length === 0)
    console.log(`nothing under ${root} depends on ${name}`)
  else
    console.log(table([['FOLDER', 'KIND', 'VERSION', 'MANAGER'], ...found.map(each => [each.dir, each.kind, each.spec, each.manager])], { header: true }))

  return 0
}
