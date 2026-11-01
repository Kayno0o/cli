#!/usr/bin/env bun

import type { Line } from './conditions'
import process from 'node:process'
import { duration, fail, formatDuration, jsonOption, paint, parse, printJson, runMain, truncate, wholeNumber } from '@kaynooo/cli-kit'
import { liveRegion } from '@kaynooo/cli-kit/progress'
import { version } from '../package.json'
import { FileWatch, portProblem, urlCheck } from './conditions'
import { exitCode, isTranscript, pidAlive, taskEnd, taskFile } from './task'

const USAGE = `waitfor [options]: waits until a file shows a line, a port listens, a URL answers 2xx or a process exits, instead of a sleep or a polling loop
waitfor task <task id | file>: waits for a Claude Code background task to end (waitfor task --help)

Every condition given must be met. A --fail line in --file ends the wait at once.
Exits 0 once met, 1 on a --fail line, 2 on a timeout or a usage error, each with an excerpt of what it saw last.`

const TASK_USAGE = `waitfor task [options] <task id | file>: waits for a Claude Code background task to end, then prints its exit code, its last lines and the (fail) and error: lines above them

The task is the id a background Bash call returned, or the path of its .output file.
Exits 0 when the task exited 0, 1 when it exited with another code, 2 on a timeout or a usage error.
--json prints {task, path, code, ms, failures, tail}, each line as {number, text}.`

const TIMEOUT = { type: 'string', short: 't', description: 'how long before giving up (5m): 30s, 5m, 1h, a bare number in seconds' } as const

const TASK_OPTIONS = {
  lines: { type: 'string', short: 'n', description: 'how many of its last lines to print (20)' },
  timeout: TIMEOUT,
  json: jsonOption(),
} as const

const OPTIONS = {
  file: { type: 'string', short: 'f', description: 'a log file to read, from its start, waiting for it to exist' },
  until: { type: 'string', short: 'u', description: 'a regular expression a line of --file must match' },
  fail: { type: 'string', short: 'e', description: 'a regular expression whose first matching line of --file is a failure' },
  port: { type: 'string', short: 'p', description: 'a TCP port that must accept connections' },
  host: { type: 'string', short: 'H', description: 'the host of --port (127.0.0.1)' },
  url: { type: 'string', description: 'a URL that must answer 2xx' },
  pid: { type: 'string', description: 'a process id that must exit' },
  timeout: TIMEOUT,
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

async function waitTask(args: string[]): Promise<number> {
  const { values, positionals: [task] } = parse(args, TASK_USAGE, TASK_OPTIONS, { positionals: ['<task>'] })
  const path = taskFile(task)

  if (path === undefined)
    fail(`no background task ${task}: give the id a background Bash call returned, or the path of its .output file`)

  if (isTranscript(path))
    fail(`${task} is a subagent, whose end its notification reports: waitfor task waits on a background Bash task`)

  const lines = wholeNumber(values.lines, 'lines', 20)
  const timeout = duration(values.timeout, 'timeout', 5 * 60_000)
  const started = Date.now()
  const { dim } = paint(process.stderr)
  const region = liveRegion(spinner => [`${spinner} task ${task}: still running ${dim(formatDuration(Date.now() - started))}`])
  let code: number | undefined

  try {
    for (;;) {
      code = await exitCode(path)

      if (code !== undefined || Date.now() - started >= timeout)
        break

      await Bun.sleep(POLL)
    }
  }
  finally {
    region.stop()
  }

  const { failures, tail } = await taskEnd(path, lines)
  const last = tail.length === 0 ? '' : `\nlast lines of ${path}:\n${numbered(tail)}`

  if (code === undefined)
    fail(`gave up after ${formatDuration(timeout)}: task ${task} is still running${last}`)

  if (values.json === true) {
    printJson({ task, path, code, ms: Date.now() - started, failures, tail })

    return code === 0 ? 0 : 1
  }

  const failed = failures.length === 0 ? '' : `\n(fail) and error: lines above them:\n${numbered(failures)}`

  console.log(`task ${task} exited with code ${code}, waited ${formatDuration(Date.now() - started)}${failed}${last}`)

  return code === 0 ? 0 : 1
}

async function main(args: string[]): Promise<number> {
  if (args[0] === 'task')
    return waitTask(args.slice(1))

  const parsed = parse(args, USAGE, OPTIONS)

  const { values, positionals } = parsed

  if (positionals.length > 0)
    fail(`unexpected argument ${positionals[0]}\n\n${USAGE}`)

  if (values.until === undefined && values.port === undefined && values.url === undefined && values.pid === undefined)
    fail(`give --until with --file, --port, --url or --pid\n\n${USAGE}`)

  if ((values.until !== undefined || values.fail !== undefined) !== (values.file !== undefined))
    fail('--until and --fail read the --file lines, and --file needs one of them')

  if (values.host !== undefined && values.port === undefined)
    fail('--host goes with --port')

  const port = values.port === undefined ? undefined : wholeNumber(values.port, 'port', 0)

  if (port !== undefined && port > 65_535)
    fail(`--port takes a port up to 65535, not ${port}`)

  if (values.url !== undefined && !URL.canParse(values.url))
    fail(`--url ${values.url} is no URL`)

  const pid = values.pid === undefined ? undefined : wholeNumber(values.pid, 'pid', 0)
  const host = values.host ?? '127.0.0.1'
  const timeout = duration(values.timeout, 'timeout', 5 * 60_000)
  const watch = values.file === undefined ? undefined : new FileWatch(values.file, regex(values.until, 'until'), regex(values.fail, 'fail'))
  const started = Date.now()
  let portLeft = port === undefined ? undefined : 'not checked yet'
  let urlLeft = values.url === undefined ? undefined : 'not checked yet'
  let isPidLeft = pid !== undefined
  const { dim } = paint(process.stderr)
  // What is still awaited, on a terminal: a line per condition with what it last saw.
  const region = liveRegion((spinner) => {
    const waited = dim(formatDuration(Date.now() - started))
    const left = [
      watch === undefined || watch.done ? undefined : `${watch.path}: ${watch.exists ? 'no --until line yet' : 'does not exist yet'}`,
      portLeft === undefined ? undefined : `${host}:${port}: ${portLeft}`,
      urlLeft === undefined ? undefined : `${values.url}: ${urlLeft}`,
      isPidLeft ? `pid ${pid}: still running` : undefined,
    ]

    return left.filter(line => line !== undefined).map(line => `${spinner} ${line} ${waited}`)
  })

  try {
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

      if (pid !== undefined && isPidLeft) {
        isPidLeft = pidAlive(pid)

        if (!isPidLeft)
          console.log(`pid ${pid} exited after ${formatDuration(Date.now() - started)}`)
      }

      if ((watch?.done ?? true) && portLeft === undefined && urlLeft === undefined && !isPidLeft)
        return 0

      if (Date.now() - started >= timeout && !(watch?.failing ?? false))
        break

      await Bun.sleep(POLL)
    }
  }
  finally {
    region.stop()
  }

  const missing: string[] = []

  if (watch !== undefined && !watch.done)
    missing.push(watch.exists ? `no line of ${watch.path} matched --until` : `${watch.path} does not exist`)

  if (portLeft !== undefined)
    missing.push(`${host}:${port} is not listening (${portLeft})`)

  if (urlLeft !== undefined)
    missing.push(`${values.url} ${urlLeft}`)

  if (isPidLeft)
    missing.push(`pid ${pid} is still running`)

  const lines = watch?.excerpt() ?? []

  fail(`gave up after ${formatDuration(timeout)}: ${missing.join(', ')}${lines.length === 0 ? '' : `\nlast lines of ${watch?.path}:\n${numbered(lines)}`}`)
}

process.exitCode = await runMain({ name: 'waitfor', version, run: main })
