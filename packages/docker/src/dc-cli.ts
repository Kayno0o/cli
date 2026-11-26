#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import process from 'node:process'
import { completion, fail, parse, runMain } from '@kaynooo/cli-kit'
import { dc } from './dc'
import { dlog } from './dlog'
import { dx } from './dx'
import { dcLogs } from './logs'
import { dcPort, dcPorts } from './port'
import { ACTIONS, allServices, key } from './stack'

const usage = `dc: unified Docker Compose CLI — service picker/listing, health & error summary, redacted logs, shell/exec, deterministic ports, and compose passthrough

  dc [--json]                      pick a compose service (TTY) or list services (non-TTY)
  dc health [service...]           service state, health, and deduplicated recent errors (formerly dlog)
  dc logs [service...]             redacted logs by default (--raw, --tail, --since, --grep, --errors, --no-follow)
  dc shell [service]               open an interactive shell in a service (starts it if stopped)
  dc exec <service> <cmd...>       run a command inside a compose service
  dc port <name> [--min] [--max]   deterministic FNV-1a host port for a service name (formerly stack port)
  dc ports [--json]                list published host -> container ports across services
  dc [project] <compose args...>   pass any other docker compose verb (up, down, ps, restart, build, config...) to the stack found here`

const EXITS: ExitRow[] = [['its own', 'the exit code of compose or the command run'], [0, 'succeeded'], [1, 'a service is unhealthy/down, several stacks match, or compose failed'], [2, 'a usage error']]

const SUBCOMMANDS: [string, string][] = [
  ['health', 'service state, health and deduplicated recent errors'],
  ['logs', 'redacted service logs (--tail, --since, --grep, --errors, --raw)'],
  ['shell', 'open a shell in a compose service'],
  ['exec', 'run a command in a compose service'],
  ['port', 'deterministic FNV-1a host port for a service name'],
  ['ports', 'list published ports across compose services'],
  ['up', 'create and start containers'],
  ['down', 'stop and remove containers'],
  ['ps', 'list containers'],
  ['restart', 'restart service containers'],
  ['stop', 'stop running containers'],
  ['build', 'build or rebuild services'],
]

async function complete(words: string[]): Promise<number> {
  if (words.length <= 1) {
    const prefix = words[0] ?? ''

    for (const [name, desc] of SUBCOMMANDS) {
      if (name.startsWith(prefix))
        console.log(`${name}\t${desc}`)
    }

    return 0
  }

  if (words[0] === 'health' || words[0] === 'logs' || words[0] === 'shell' || words[0] === 'exec') {
    const prefix = words.at(-1) ?? ''

    try {
      for (const service of await allServices()) {
        const name = key(service)

        if (name.startsWith(prefix))
          console.log(`${name}\t${service.state}`)
      }
    }
    catch {
      // No compose services available.
    }

    return 0
  }

  // `dc <service> <action>` completion (formerly dx).
  if (words.length === 2) {
    const prefix = words[1] ?? ''

    for (const action of ACTIONS) {
      if (action.startsWith(prefix))
        console.log(action)
    }
  }

  return 0
}

async function main(args: string[]): Promise<number> {
  const [first, ...rest] = args

  if (completion.active)
    return complete(args)

  if (first === '__complete')
    return complete(rest)

  if (args.length === 1 && (first === '--help' || first === '-h' || first === '--version' || first === '-V')) {
    parse(args, usage, {}, {
      exits: EXITS,
      replaces: 'docker compose -f ..., docker compose ps/logs/exec, dlog, dx, and stack port',
      examples: [
        'dc',
        ['dc health', 'every service state, health and recent errors'],
        ['dc logs api --tail 50 --no-follow', 'redacted logs for api'],
        ['dc shell app', 'open a shell inside app'],
        ['dc port api', 'deterministic FNV-1a port for api'],
        ['dc up -d', 'pass through to docker compose on the nearest stack'],
      ],
    })

    return 0
  }

  // Bare `dc`, `dc --json`, `dc -`, or picker protocol flags (`--list`, `--names`, `--emit`, `--masked`, `--show`) delegate to the service picker / listing.
  if (first === undefined || first === '-' || first === '--json' || first === '--list' || first === '--names' || first === '--emit' || first === '--masked' || first === '--show')
    return dx(args)

  if (first === 'health')
    return dlog(rest)

  if (first === 'logs')
    return dcLogs(rest)

  if (first === 'port')
    return dcPort(rest)

  if (first === 'ports')
    return dcPorts(rest)

  if (first === 'shell') {
    if (rest.includes('--help') || rest.includes('-h')) {
      console.log('dc shell [service]: opens an interactive shell in the service (starts it if stopped)\n\nExits with the shell exit code, 1 if no service matches, 2 on a usage error.')

      return 0
    }

    if (rest.length === 0)
      return dx([])

    if (rest.length > 1)
      fail('dc shell takes one service name')

    return dx([rest[0]!, 'shell'])
  }

  if (first === 'exec') {
    if (rest.length === 1 && (rest[0] === '--help' || rest[0] === '-h')) {
      console.log('dc exec [options] <service> <cmd...>: runs a command inside a compose service on the nearest stack\n\nExits with the command exit code, 1 on failure, 2 on a usage error.')

      return 0
    }

    return dc(args)
  }

  return dc(args)
}

process.exitCode = await runMain({ name: 'dc', run: main })
