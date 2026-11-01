#!/usr/bin/env bun

import type { Line } from './conditions'
import process from 'node:process'
import { duration, fail, formatDuration, parse, runMain, truncate, wholeNumber } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { FileWatch, portProblem, urlCheck } from './conditions'

const USAGE = `waitfor [options]: waits until a file shows a line, a port listens or a URL answers 2xx, instead of a sleep or a polling loop

Every condition given must be met. A --fail line in --file ends the wait at once.
Exits 0 once met, 1 on a --fail line, 2 on a timeout or a usage error, each with an excerpt of what it saw last.`

const OPTIONS = {
  file: { type: 'string', short: 'f', description: 'a log file to read, from its start, waiting for it to exist' },
  until: { type: 'string', short: 'u', description: 'a regular expression a line of --file must match' },
  fail: { type: 'string', short: 'e', description: 'a regular expression whose first matching line of --file is a failure' },
  port: { type: 'string', short: 'p', description: 'a TCP port that must accept connections' },
  host: { type: 'string', short: 'H', description: 'the host of --port (127.0.0.1)' },
  url: { type: 'string', description: 'a URL that must answer 2xx' },
  timeout: { type: 'string', short: 't', description: 'how long before giving up (5m): 30s, 5m, 1h, a bare number in seconds' },
} as const

const POLL = 250
const URL_TIMEOUT = 5000
const WIDTH = 400

function regex(source: string | undefined, name: string): RegExp | undefined {
  if (source === undefined)
    return undefined

  try {
    return new RegExp(source)
  }
  catch (error) {
    fail(`--${name} is no valid regular expression: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function numbered(lines: Line[], marked?: Line): string {
  const width = String(lines.at(-1)?.number ?? 0).length

  return lines.map(line => `${line === marked ? '>' : ' '} ${String(line.number).padStart(width)}  ${truncate(line.text, WIDTH)}`).join('\n')
}

async function main(args: string[]): Promise<number> {
  const parsed = parse(args, USAGE, OPTIONS)

  const { values, positionals } = parsed

  if (positionals.length > 0)
    fail(`unexpected argument ${positionals[0]}\n\n${USAGE}`)

  if (values.until === undefined && values.port === undefined && values.url === undefined)
    fail(`give --until with --file, --port or --url\n\n${USAGE}`)

  if ((values.until !== undefined || values.fail !== undefined) !== (values.file !== undefined))
    fail('--until and --fail read the --file lines, and --file needs one of them')

  if (values.host !== undefined && values.port === undefined)
    fail('--host goes with --port')

  const port = values.port === undefined ? undefined : wholeNumber(values.port, 'port', 0)

  if (port !== undefined && port > 65_535)
    fail(`--port takes a port up to 65535, not ${port}`)

  if (values.url !== undefined && !URL.canParse(values.url))
    fail(`--url ${values.url} is no URL`)

  const host = values.host ?? '127.0.0.1'
  const timeout = duration(values.timeout, 'timeout', 5 * 60_000)
  const watch = values.file === undefined ? undefined : new FileWatch(values.file, regex(values.until, 'until'), regex(values.fail, 'fail'))
  const started = Date.now()
  let portLeft = port === undefined ? undefined : 'not checked yet'
  let urlLeft = values.url === undefined ? undefined : 'not checked yet'

  for (;;) {
    if (watch !== undefined) {
      for (const event of await watch.poll()) {
        if (event.kind === 'until') {
          console.log(`${watch.path}:${event.line.number}: ${truncate(event.line.text, WIDTH)}`)

          continue
        }

        console.error(`waitfor: ${watch.path}:${event.line.number} matched --fail after ${formatDuration(Date.now() - started)}\n${numbered(event.excerpt, event.line)}`)

        return 1
      }
    }

    if (port !== undefined && portLeft !== undefined) {
      portLeft = await portProblem(host, port)

      if (portLeft === undefined)
        console.log(`${host}:${port} listening after ${formatDuration(Date.now() - started)}`)
    }

    if (values.url !== undefined && urlLeft !== undefined) {
      const check = await urlCheck(values.url, Math.max(1, Math.min(URL_TIMEOUT, started + timeout - Date.now())))

      urlLeft = 'problem' in check ? check.problem : undefined

      if ('status' in check)
        console.log(`${values.url} answered ${check.status} after ${formatDuration(Date.now() - started)}`)
    }

    if ((watch?.done ?? true) && portLeft === undefined && urlLeft === undefined)
      return 0

    if (Date.now() - started >= timeout && !(watch?.failing ?? false))
      break

    await Bun.sleep(POLL)
  }

  const missing: string[] = []

  if (watch !== undefined && !watch.done)
    missing.push(watch.exists ? `no line of ${watch.path} matched --until` : `${watch.path} does not exist`)

  if (portLeft !== undefined)
    missing.push(`${host}:${port} is not listening (${portLeft})`)

  if (urlLeft !== undefined)
    missing.push(`${values.url} ${urlLeft}`)

  const lines = watch?.excerpt() ?? []

  fail(`gave up after ${formatDuration(timeout)}: ${missing.join(', ')}${lines.length === 0 ? '' : `\nlast lines of ${watch?.path}:\n${numbered(lines)}`}`)
}

process.exitCode = await runMain({ name: 'waitfor', version, run: main })
