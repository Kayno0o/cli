import process from 'node:process'
import { jsonOption, oneOf, parse, printJson } from '@kaynooo/cli-kit'
import { ACTIONS, commandFor, detectManager } from '../manager'

const usage = `pkg manager <install|dev|remove|update|exec>

Prints the command the package manager of this folder runs for the action: install is the add or install of a package, dev adds one as a dev dependency, remove drops one, update upgrades them and exec runs a package's bin without installing it. The manager is the one whose lockfile (bun.lock, yarn.lock, pnpm-lock.yaml, package-lock.json, uv.lock) or composer.json is nearest, here or in a parent folder, bun when none is found.

Exits 0 when it printed the command, 2 on a usage error.`

const options = {
  json: jsonOption('{manager, action, command}'),
} as const

export function manager(args: string[]): number {
  const { values, positionals } = parse(args, usage, options, {
    positionals: ['<action>'],
    candidates: { '<action>': () => [...ACTIONS] },
    replaces: 'telling bun, yarn, pnpm, npm, composer and uv apart by their lockfile before typing an add, remove or dlx',
    examples: ['pkg manager dev', ['pkg manager exec', 'bunx, npx, pnpm dlx... for this folder']],
  })
  const action = oneOf(positionals[0] ?? '', '<action>', ACTIONS)
  const found = detectManager(process.cwd())
  const command = commandFor(action, found)

  if (values.json === true)
    printJson({ manager: found, action, command })
  else
    console.log(command)

  return 0
}
