#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import type { Line, UrlExpect } from './conditions'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { duration, fail, formatDuration, formatElapsed, jsonOption, paint, parse, printJson, problem, runCommand, runMain, truncate, wholeNumber } from '@kaynooo/cli-kit'
import { liveRegion } from '@kaynooo/cli-kit/progress'
import { FileWatch, parseStatus, portProblem, urlCheck } from './conditions'
import { exitCode, isTranscript, pidAlive, taskEnd, taskFile } from './task'

const USAGE = `waitfor [options]: waits until a file shows a line, a port listens, a URL answers 2xx, a process exits or a command exits 0
waitfor task <task id | file>: waits for a Claude Code background task to end (waitfor task --help)

Every condition given must be met, or with --any the first of them to be; --port and --url may be repeated, and --status and --body then apply to every --url. A --fail line in --file ends the wait at once. A timeout or a --fail line comes with an excerpt of what it saw last.
--json prints {met, ms, line, conditions} once met or on a --fail line, conditions naming each one met as {name, ms}, line being the last --until line or the --fail one as {number, text} (null when none), and the progress lines go to stderr.`

const TASK_USAGE = `waitfor task [options] <task id | file>: waits for a Claude Code background task to end, then prints its exit code, its last lines and the (fail) and error: lines above them

The task is the id a background Bash call returned, or the path of its .output file.
--json prints {task, path, code, ms, failures, tail}, each line as {number, text}.`

const EXITS: ExitRow[] = [[0, 'every condition was met'], [1, 'a --fail line showed up'], [2, 'it timed out or a usage error']]
const TASK_EXITS: ExitRow[] = [[0, 'the task exited 0'], [1, 'it exited with another code'], [2, 'it timed out or a usage error']]

const TIMEOUT = { type: 'string', short: 't', description: 'how long before giving up (5m): 30s, 5m, 1h, a bare number in seconds' } as const

const TASK_OPTIONS = {
  lines: { type: 'string', short: 'n', description: 'how many of its last lines to print (20)' },
  timeout: TIMEOUT,
  json: jsonOption(),
  quiet: { type: 'boolean', short: 'q', description: 'no live progress line' },
} as const

const OPTIONS = {
  file: { type: 'string', short: 'f', description: 'a log file to read, from its start, waiting for it to exist' },
  until: { type: 'string', short: 'u', description: 'a regular expression a line of --file must match' },
  fail: { type: 'string', short: 'e', description: 'a regular expression whose first matching line of --file is a failure' },
  port: { type: 'string', short: 'p', multiple: true, description: 'a TCP port that must accept connections, repeatable' },
  host: { type: 'string', short: 'H', description: 'the host of --port (127.0.0.1 and ::1)' },
  url: { type: 'string', multiple: true, description: 'a URL that must answer 2xx (or --status), repeatable' },
  status: { type: 'string', description: 'the status a --url must answer instead of 2xx: 301, 200-299, 2xx or a comma list, for every --url' },
  body: { type: 'string', description: 'a regular expression the first MiB of a --url body must match, for every --url' },
  pid: { type: 'string', description: 'a process id that must exit' },
  cmd: { type: 'string', short: 'c', description: 'a shell command that must exit 0, re-run every --interval' },
  interval: { type: 'string', description: 'how long between two runs of --cmd (1s)' },
  any: { type: 'boolean', description: 'met by the first condition that is, not all of them (needs two)' },
  timeout: TIMEOUT,
  json: jsonOption('{met, ms, line}'),
  quiet: { type: 'boolean', short: 'q', description: 'no live progress line: only what was met and the failure' },
} as const

// A --port or --url being awaited: `left` is what it last saw, undefined once met.
interface Probe {
  name: string
  port?: number
  left: string | undefined
}

const POLL = 250
const URL_TIMEOUT = 5000
const WIDTH = 400
const CMD_RUN_LIMIT = 30_000
const LAST_LINE = /[^\n]+(?=\n*$)/

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

// What a run of the command left unmet: its exit code and last line, or why it could not run; undefined when it exited 0.
async function cmdProblem(command: string, timeoutMs: number): Promise<string | undefined> {
  try {
    const ran = await runCommand(['sh', '-c', command], { timeoutMs })

    if (ran.code === 0 && !ran.timedOut)
      return undefined

    const last = LAST_LINE.exec(ran.text)?.[0]

    return `${ran.timedOut ? 'timed out' : `exited ${ran.code}`}${last === undefined ? '' : ` (${truncate(last, WIDTH)})`}`
  }
  catch (error) {
    return `could not run: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function waitTask(args: string[]): Promise<number> {
  const { values, positionals: [task] } = parse(args, TASK_USAGE, TASK_OPTIONS, { positionals: ['<task>'], exits: TASK_EXITS })
  const path = taskFile(task)

  if (path === undefined)
    fail(`no background task ${task}: give the id a background Bash call returned, or the path of its .output file`)

  if (!existsSync(path))
    fail(`no output file ${path}: ${task} is no background task of this machine`)

  if (isTranscript(path))
    fail(`${task} is a subagent, whose end its notification reports: waitfor task waits on a background Bash task`)

  const lines = wholeNumber(values.lines, 'lines', 20)
  const timeout = duration(values.timeout, 'timeout', 5 * 60_000)
  const started = Date.now()
  const { dim } = paint(process.stderr)
  const region = values.quiet === true ? undefined : liveRegion(spinner => [`${spinner} task ${task}: still running ${dim(formatElapsed(Date.now() - started))}`])
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
    region?.stop()
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

  const parsed = parse(args, USAGE, OPTIONS, { exits: EXITS, replaces: 'sleep loops, tail -f and until ! pgrep -f', examples: [['waitfor --file dev.log --until "ready in" --fail error', 'a dev server up, or its first error'], ['waitfor --port 5432 -t 2m', 'Postgres accepting connections']] })

  const { values, positionals } = parsed

  if (positionals.length > 0)
    fail(`unexpected argument ${positionals[0]}\n\n${USAGE}`)

  const portTexts = values.port ?? []
  const urlTexts = values.url ?? []

  if (values.until === undefined && portTexts.length === 0 && urlTexts.length === 0 && values.pid === undefined && values.cmd === undefined)
    fail(`give --until with --file, --port, --url, --pid or --cmd\n\n${USAGE}`)

  if ((values.until !== undefined || values.fail !== undefined) !== (values.file !== undefined))
    fail('--until and --fail read the --file lines, and --file needs one of them')

  if (values.host !== undefined && portTexts.length === 0)
    fail('--host goes with --port')

  if ((values.status !== undefined || values.body !== undefined) && urlTexts.length === 0)
    fail('--status and --body go with --url')

  const conditions = [values.until, ...portTexts, ...urlTexts, values.pid, values.cmd].filter(condition => condition !== undefined).length

  if (values.any === true && conditions < 2)
    fail('--any needs two or more of --until, --port, --url, --pid and --cmd')

  if (values.interval !== undefined && values.cmd === undefined)
    fail('--interval goes with --cmd')

  const ports = portTexts.map((text): Probe => {
    const port = wholeNumber(text, 'port', 0)

    if (port > 65_535)
      fail(`--port takes a port up to 65535, not ${port}`)

    return { name: String(port), port, left: 'not checked yet' }
  })

  for (const url of urlTexts) {
    if (!URL.canParse(url))
      fail(`--url ${url} is no URL`)
  }

  const statusTest = values.status === undefined ? undefined : parseStatus(values.status)

  if (values.status !== undefined && statusTest === undefined)
    fail(`--status takes a code, a range or a class such as 301, 200-299 or 2xx, not ${values.status}`)

  const expect: UrlExpect = {}

  if (values.status !== undefined && statusTest !== undefined)
    expect.status = { test: statusTest, spec: values.status }

  const body = regex(values.body, 'body')

  if (body !== undefined)
    expect.body = body

  const urls = urlTexts.map((url): Probe => ({ name: url, left: 'not checked yet' }))
  // Each condition met and when, for --json.
  const metAt: { name: string, ms: number }[] = []

  const pid = values.pid === undefined ? undefined : wholeNumber(values.pid, 'pid', 0)
  // Without --host a server bound to ::1 only (`localhost` in vite or nuxt) counts as well.
  const hosts = values.host === undefined ? ['127.0.0.1', '::1'] : [values.host]

  const interval = duration(values.interval, 'interval', 1000)
  const isAny = values.any === true
  const timeout = duration(values.timeout, 'timeout', 5 * 60_000)
  const watch = values.file === undefined ? undefined : new FileWatch(values.file, regex(values.until, 'until'), regex(values.fail, 'fail'))
  const started = Date.now()
  const json = values.json === true
  const say = json ? console.error : console.log
  let matched: { number: number, text: string } | undefined

  let isPidLeft = pid !== undefined
  let cmdLeft = values.cmd === undefined ? undefined : 'not run yet'
  let cmdRanAt = 0
  const { dim } = paint(process.stderr)
  // What is still awaited, on a terminal: a line per condition with what it last saw.
  const region = values.quiet === true
    ? undefined
    : liveRegion((spinner) => {
      const waited = dim(formatElapsed(Date.now() - started))
      const left = [
        watch === undefined || watch.done ? undefined : `${watch.path}: ${watch.exists ? 'no --until line yet' : 'does not exist yet'}`,
        ...ports.filter(probe => probe.left !== undefined).map(probe => `${hosts[0]}:${probe.port}: ${probe.left}`),
        ...urls.filter(probe => probe.left !== undefined).map(probe => `${probe.name}: ${probe.left}`),
        isPidLeft ? `pid ${pid}: still running` : undefined,
        cmdLeft === undefined ? undefined : `\`${values.cmd}\`: ${cmdLeft}`,
      ]

      return left.filter(line => line !== undefined).map(line => `${spinner} ${line} ${waited}`)
    })

  try {
    for (;;) {
      if (watch !== undefined) {
        for (const event of await watch.poll()) {
          if (event.kind === 'until') {
            say(`${watch.path}:${event.line.number}: ${truncate(event.line.text, WIDTH)}`)
            matched = { number: event.line.number, text: event.line.text }

            continue
          }

          problem(`waitfor: ${watch.path}:${event.line.number} matched --fail after ${formatDuration(Date.now() - started)}\n${numbered(event.excerpt, event.line)}`)

          if (json)
            printJson({ met: false, ms: Date.now() - started, line: { number: event.line.number, text: event.line.text } })

          return 1
        }
      }

      for (const probe of ports) {
        if (probe.left === undefined)
          continue

        for (const candidate of hosts) {
          const problem = await portProblem(candidate, probe.port ?? 0)

          if (candidate === hosts[0])
            probe.left = problem

          if (problem === undefined) {
            const name = `${candidate.includes(':') ? `[${candidate}]` : candidate}:${probe.port}`

            probe.left = undefined
            probe.name = name
            metAt.push({ name, ms: Date.now() - started })
            say(`${name} listening after ${formatDuration(Date.now() - started)}`)

            break
          }
        }
      }

      for (const probe of urls) {
        if (probe.left === undefined)
          continue

        const budget = Math.max(1, Math.min(URL_TIMEOUT, started + timeout - Date.now()))
        const check = await urlCheck(probe.name, budget, expect)
        // a probe the deadline cut short says less than the answer before it
        const isCutShort = 'problem' in check && check.isTimeout === true && budget < URL_TIMEOUT && probe.left !== 'not checked yet'

        if (!isCutShort)
          probe.left = 'problem' in check ? check.problem : undefined

        if ('status' in check) {
          metAt.push({ name: probe.name, ms: Date.now() - started })
          say(`${probe.name} answered ${check.status} after ${formatDuration(Date.now() - started)}`)
        }
      }

      if (pid !== undefined && isPidLeft) {
        isPidLeft = pidAlive(pid)

        if (!isPidLeft) {
          metAt.push({ name: `pid ${pid}`, ms: Date.now() - started })
          say(`pid ${pid} exited after ${formatDuration(Date.now() - started)}`)
        }
      }

      if (values.cmd !== undefined && cmdLeft !== undefined && Date.now() - cmdRanAt >= interval) {
        const budget = Math.max(1, Math.min(CMD_RUN_LIMIT, started + timeout - Date.now()))

        const problem = await cmdProblem(values.cmd, budget)

        // a run the deadline cut short says less than the answer before it
        if (!(problem?.startsWith('timed out') === true && budget < CMD_RUN_LIMIT && cmdLeft !== 'not run yet'))
          cmdLeft = problem

        cmdRanAt = Date.now()

        if (cmdLeft === undefined) {
          metAt.push({ name: `\`${values.cmd}\``, ms: Date.now() - started })
          say(`\`${values.cmd}\` exited 0 after ${formatDuration(Date.now() - started)}`)
        }
      }

      const isMet = [
        values.until !== undefined && (watch?.done ?? false),
        ports.some(probe => probe.left === undefined),
        urls.some(probe => probe.left === undefined),
        pid !== undefined && !isPidLeft,
        values.cmd !== undefined && cmdLeft === undefined,
      ]

      if (isAny ? isMet.includes(true) : (watch?.done ?? true) && ports.every(probe => probe.left === undefined) && urls.every(probe => probe.left === undefined) && !isPidLeft && cmdLeft === undefined) {
        if (json)
          printJson({ met: true, ms: Date.now() - started, line: matched ?? null, conditions: metAt })

        return 0
      }

      if (Date.now() - started >= timeout && !(watch?.failing ?? false))
        break

      await Bun.sleep(POLL)
    }
  }
  finally {
    region?.stop()
  }

  const missing: string[] = []

  if (watch !== undefined && !watch.done)
    missing.push(watch.exists ? `no line of ${watch.path} matched --until` : `${watch.path} does not exist`)

  for (const probe of ports) {
    if (probe.left !== undefined)
      missing.push(`${hosts[0]}:${probe.port} is not listening (${probe.left})`)
  }

  for (const probe of urls) {
    if (probe.left !== undefined)
      missing.push(`${probe.name} ${probe.left}`)
  }

  if (isPidLeft)
    missing.push(`pid ${pid} is still running`)

  if (cmdLeft !== undefined)
    missing.push(`\`${values.cmd}\` ${cmdLeft}`)

  const lines = watch?.excerpt() ?? []

  fail(`gave up after ${formatDuration(timeout)}${isAny ? ', none met' : ''}: ${missing.join(', ')}${lines.length === 0 ? '' : `\nlast lines of ${watch?.path}:\n${numbered(lines)}`}`)
}

process.exitCode = await runMain({ name: 'waitfor', run: main })
