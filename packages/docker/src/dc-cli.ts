#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import process from 'node:process'
import { completion, parse, runMain } from '@kaynooo/cli-kit'
import { dc } from './dc'

const usage = `dc [project] <compose args>

Runs docker compose on the stack found here: the nearest compose file or .env setting COMPOSE_FILE up to the repository root, else the only stack with containers here.
A first word naming a compose project with containers here runs on that project, with the files and env file it came up with (\`dc dash logs\`); the command it stands for is shown on stderr.
Takes no option of its own: every word reaches compose as typed, \`dc --help\` alone excepted.`

const EXITS: ExitRow[] = [['its own', 'the code of compose'], [1, 'several stacks have containers here and none is named']]

// A passthrough to compose: only a lone --help or a completion is dc's own, every other word reaches compose as typed.
async function main(args: string[]): Promise<number> {
  if (completion.active || (args.length === 1 && (args[0] === '--help' || args[0] === '-h'))) {
    parse(args, usage, {}, { exits: EXITS, replaces: 'docker compose -f docker-compose.prod.yaml --env-file .env.prod, typed again for each stack', examples: ['dc up -d', ['dc dash logs -f', 'a stack that came up from other files']] })

    return 0
  }

  return dc(args)
}

process.exitCode = await runMain({ name: 'dc', run: main })
