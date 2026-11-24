#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import type { Line, UrlExpect } from './conditions'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { duration, fail, formatDuration, formatElapsed, jsonOption, paint, parse, printJson, problem, runCommand, runMain, truncate, wholeNumber } from '@kaynooo/cli-kit'
import { liveRegion } from '@kaynooo/cli-kit/progress'
import { FileWatch, healthyProblem, parseStatus, portProblem, urlCheck } from './conditions'
import { exitCode, isTranscript, pidAlive, taskEnd, taskFile } from './task'

const USAGE = `waitfor [options]: waits until a file shows a line, a port listens, a URL answers 2xx, a Docker service is healthy, a process exits or a command exits 0
waitfor task <task id | file>: waits for a Claude Code background task to end (waitfor task --help)

All conditions are polled in parallel every tick. Every condition given must be met, or with --any the first of them; --port, --url and --healthy may be repeated. A --fail line in --file or a --while-pid process exiting ends the wait immediately with exit 1.`

const TASK_USAGE = `waitfor task [options] <task id | file>: waits for a Claude Code background task to end, then prints its exit code, its last lines and the (fail) and error: lines above them

The task is the id a background Bash call returned, or the path of its .output file.
--json prints {task, path, code, ms, failures, tail}, each line as {number, text}.`

const TIMEOUT_EXIT = 124
const EXITS: ExitRow[] = [[0, 'every condition was met'], [1, 'a --fail line showed up or --while-pid exited'], [124, 'it timed out'], [2, 'a usage error']]
const TASK_EXITS: ExitRow[] = [[0, 'the task exited 0'], [1, 'it exited with another code'], [124, 'it timed out'], [2, 'a usage error']]

const TIMEOUT = { type: 'string', short: 't', description: 'how long before giving up (5m): 30s, 5m, 1h, a bare number in seconds' } as const

const TASK_OPTIONS = {
  lines: { type: 'string', short: 'n', description: 'how many of its last lines to print (20)' },
  timeout: TIMEOUT,
  json: jsonOption(),
  quiet: { type: 'boolean', short: 'q', description: 'no live progress line' },
} as const

const OPTIONS = {
  'file': { type: 'string', short: 'f', description: 'a log file to read, waiting for it to exist' },
  'from-end': { type: 'boolean', description: 'with --file, start reading from the current end of the file (ignore existing lines)' },
  'until': { type: 'string', short: 'u', description: 'a regular expression a line of --file must match' },
  'fail': { type: 'string', short: 'e', description: 'a regular expression whose first matching line of --file is a failure' },
  'port': { type: 'string', short: 'p', multiple: true, description: 'a TCP port that must accept connections, repeatable' },
  'host': { type: 'string', description: 'the host of --port (127.0.0.1 and ::1)' },
  'url': { type: 'string', multiple: true, description: 'a URL that must answer 2xx (or --status), repeatable' },
  'header': { type: 'string', short: 'H', multiple: true, description: '"Name: value" header sent with every --url request, repeatable' },
  'insecure': { type: 'boolean', short: 'k', description: 'with --url, ignore untrusted TLS certificates' },
  'status': { type: 'string', description: 'the status a --url must answer instead of 2xx: 301, 200-299, 2xx or a comma list, for every --url' },
  'body': { type: 'string', description: 'a regular expression the first MiB of a --url body must match, for every --url' },
  'healthy': { type: 'string', multiple: true, description: 'a Docker Compose service or container that must report healthy, repeatable' },
  'pid': { type: 'string', description: 'a process id that must exit' },
  'while-pid': { type: 'string', description: 'abort immediately with exit 1 if this process exits before conditions are met' },
  'cmd': { type: 'string', short: 'c', description: 'a shell command that must exit 0, re-run every --interval' },
  'interval': { type: 'string', description: 'how long between two runs of --cmd (1s)' },
  'any': { type: 'boolean', description: 'met by the first condition that is, not all of them (needs two)' },
  'timeout': TIMEOUT,
  'json': jsonOption('{met, ms, line, conditions: [{name, ms}]}, line being the last --until line or the --fail one as {number, text}; the progress lines go to stderr'),
  'quiet': { type: 'boolean', short: 'q', description: 'no live progress line: only what was met and the failure' },
} as const

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
const HEADER_LINE = /^[\w!#$%&'*+.^`|~-]+:/

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
    fail(`gave up after ${formatDuration(timeout)}: task ${task} is still running${last}`, TIMEOUT_EXIT)

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

  const parsed = parse(args, USAGE, OPTIONS, { exits: EXITS, replaces: 'sleep loops, tail -f and until ! pgrep -f', examples: [['waitfor --file dev.log --from-end --until "ready in" --fail error', 'a dev server up from new log lines, or its first error'], ['waitfor --port 5432 --while-pid 1234 -t 2m', 'Postgres accepting connections while its launcher is alive']] })

  const { values, positionals } = parsed

  if (positionals.length > 0)
    fail(`unexpected argument ${positionals[0]}\n\n${USAGE}`)

  const portTexts = values.port ?? []
  const urlTexts = values.url ?? []
  const healthyTexts = values.healthy ?? []

  if (values.until === undefined && portTexts.length === 0 && urlTexts.length === 0 && healthyTexts.length === 0 && values.pid === undefined && values.cmd === undefined)
    fail(`give --until with --file, --port, --url, --healthy, --pid or --cmd\n\n${USAGE}`)

  if ((values.until !== undefined || values.fail !== undefined) !== (values.file !== undefined))
    fail('--until and --fail read the --file lines, and --file needs one of them')

  if (values['from-end'] === true && values.file === undefined)
    fail('--from-end goes with --file')

  if (values.host !== undefined && portTexts.length === 0)
    fail('--host goes with --port')

  if ((values.status !== undefined || values.body !== undefined || (values.header?.length ?? 0) > 0 || values.insecure === true) && urlTexts.length === 0)
    fail('--status, --body, --header and --insecure go with --url')

  const conditions = [values.until, ...portTexts, ...urlTexts, ...healthyTexts, values.pid, values.cmd].filter(condition => condition !== undefined).length

  if (values.any === true && conditions < 2)
    fail('--any needs two or more of --until, --port, --url, --healthy, --pid and --cmd')

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

  const headers: Record<string, string> = {}

  for (const entry of values.header ?? []) {
    if (!HEADER_LINE.test(entry))
      fail(`-H takes "Name: value", not ${entry}`)

    const at = entry.indexOf(':')

    headers[entry.slice(0, at).trim()] = entry.slice(at + 1).trim()
  }

  const statusTest = values.status === undefined ? undefined : parseStatus(values.status)

  if (values.status !== undefined && statusTest === undefined)
    fail(`--status takes a code, a range or a class such as 301, 200-299 or 2xx, not ${values.status}`)

  const expect: UrlExpect = {
    ...(values.status !== undefined && statusTest !== undefined ? { status: { test: statusTest, spec: values.status } } : {}),
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
    ...(values.insecure === true ? { insecure: true } : {}),
  }

  const body = regex(values.body, 'body')

  if (body !== undefined)
    expect.body = body

  const urls = urlTexts.map((url): Probe => ({ name: url, left: 'not checked yet' }))
  const services = healthyTexts.map((service): Probe => ({ name: service, left: 'not checked yet' }))
  const metAt: { name: string, ms: number }[] = []

  const pid = values.pid === undefined ? undefined : wholeNumber(values.pid, 'pid', 0)
  const whilePid = values['while-pid'] === undefined ? undefined : wholeNumber(values['while-pid'], 'while-pid', 0)
  const hosts = values.host === undefined ? ['127.0.0.1', '::1'] : [values.host]

  const interval = duration(values.interval, 'interval', 1000)
  const isAny = values.any === true
  const timeout = duration(values.timeout, 'timeout', 5 * 60_000)
  const watch = values.file === undefined ? undefined : new FileWatch(values.file, regex(values.until, 'until'), regex(values.fail, 'fail'), values['from-end'] === true)
  const started = Date.now()
  const json = values.json === true
  const say = json ? console.error : console.log
  let matched: { number: number, text: string } | undefined

  let isPidLeft = pid !== undefined
  let cmdLeft = values.cmd === undefined ? undefined : 'not run yet'
  let cmdRanAt = 0
  const { dim } = paint(process.stderr)
  const region = values.quiet === true
    ? undefined
    : liveRegion((spinner) => {
      const waited = dim(formatElapsed(Date.now() - started))
      const left = [
        watch === undefined || watch.done ? undefined : `${watch.path}: ${watch.exists ? 'no --until line yet' : 'does not exist yet'}`,
        ...ports.filter(probe => probe.left !== undefined).map(probe => `${hosts[0]}:${probe.port}: ${probe.left}`),
        ...urls.filter(probe => probe.left !== undefined).map(probe => `${probe.name}: ${probe.left}`),
        ...services.filter(probe => probe.left !== undefined).map(probe => `service ${probe.name}: ${probe.left}`),
        isPidLeft ? `pid ${pid}: still running` : undefined,
        cmdLeft === undefined ? undefined : `\`${values.cmd}\`: ${cmdLeft}`,
      ]

      return left.filter(line => line !== undefined).map(line => `${spinner} ${line} ${waited}`)
    })

  try {
    for (;;) {
      if (whilePid !== undefined && !pidAlive(whilePid)) {
        problem(`waitfor: --while-pid ${whilePid} exited after ${formatDuration(Date.now() - started)} before conditions were met`)

        if (json)
          printJson({ met: false, ms: Date.now() - started, reason: `pid ${whilePid} exited`, line: null, conditions: metAt })

        return 1
      }

      const [fileEvents] = await Promise.all([
        watch === undefined ? Promise.resolve([]) : watch.poll(),
        Promise.all(ports.filter(probe => probe.left !== undefined).map(async (probe) => {
          for (const candidate of hosts) {
            const prob = await portProblem(candidate, probe.port ?? 0)

            if (candidate === hosts[0])
              probe.left = prob

            if (prob === undefined) {
              const name = `${candidate.includes(':') ? `[${candidate}]` : candidate}:${probe.port}`

              probe.left = undefined
              probe.name = name
              metAt.push({ name, ms: Date.now() - started })
              say(`${name} listening after ${formatDuration(Date.now() - started)}`)

              return
            }
          }
        })),
        Promise.all(urls.filter(probe => probe.left !== undefined).map(async (probe) => {
          const budget = Math.max(1, Math.min(URL_TIMEOUT, started + timeout - Date.now()))
          const check = await urlCheck(probe.name, budget, expect)
          const isCutShort = 'problem' in check && check.isTimeout === true && budget < URL_TIMEOUT && probe.left !== 'not checked yet'

          if (!isCutShort)
            probe.left = 'problem' in check ? check.problem : undefined

          if ('status' in check) {
            metAt.push({ name: probe.name, ms: Date.now() - started })
            say(`${probe.name} answered ${check.status} after ${formatDuration(Date.now() - started)}`)
          }
        })),
        Promise.all(services.filter(probe => probe.left !== undefined).map(async (probe) => {
          const prob = await healthyProblem(probe.name)

          probe.left = prob

          if (prob === undefined) {
            metAt.push({ name: `healthy:${probe.name}`, ms: Date.now() - started })
            say(`${probe.name} healthy after ${formatDuration(Date.now() - started)}`)
          }
        })),
        (async () => {
          if (values.cmd !== undefined && cmdLeft !== undefined && Date.now() - cmdRanAt >= interval) {
            const budget = Math.max(1, Math.min(CMD_RUN_LIMIT, started + timeout - Date.now()))
            const prob = await cmdProblem(values.cmd, budget)

            if (!(prob?.startsWith('timed out') === true && budget < CMD_RUN_LIMIT && cmdLeft !== 'not run yet'))
              cmdLeft = prob

            cmdRanAt = Date.now()

            if (cmdLeft === undefined) {
              metAt.push({ name: `\`${values.cmd}\``, ms: Date.now() - started })
              say(`\`${values.cmd}\` exited 0 after ${formatDuration(Date.now() - started)}`)
            }
          }
        })(),
      ])

      for (const event of fileEvents) {
        if (event.kind === 'until') {
          say(`${watch!.path}:${event.line.number}: ${truncate(event.line.text, WIDTH)}`)
          matched = { number: event.line.number, text: event.line.text }
          metAt.push({ name: `${watch!.path} --until`, ms: Date.now() - started })

          continue
        }

        problem(`waitfor: ${watch!.path}:${event.line.number} matched --fail after ${formatDuration(Date.now() - started)}\n${numbered(event.excerpt, event.line)}`)

        if (json)
          printJson({ met: false, ms: Date.now() - started, line: { number: event.line.number, text: event.line.text } })

        return 1
      }

      if (pid !== undefined && isPidLeft) {
        isPidLeft = pidAlive(pid)

        if (!isPidLeft) {
          metAt.push({ name: `pid ${pid}`, ms: Date.now() - started })
          say(`pid ${pid} exited after ${formatDuration(Date.now() - started)}`)
        }
      }

      const isMet = [
        values.until !== undefined && (watch?.done ?? false),
        ports.some(probe => probe.left === undefined),
        urls.some(probe => probe.left === undefined),
        services.some(probe => probe.left === undefined),
        pid !== undefined && !isPidLeft,
        values.cmd !== undefined && cmdLeft === undefined,
      ]

      const isAllMet = (watch?.done ?? true) && ports.every(probe => probe.left === undefined) && urls.every(probe => probe.left === undefined) && services.every(probe => probe.left === undefined) && !isPidLeft && cmdLeft === undefined

      if ((isAny ? isMet.includes(true) : isAllMet) && !(watch?.failsFirst ?? false)) {
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

  for (const probe of services) {
    if (probe.left !== undefined)
      missing.push(`service ${probe.name} is not healthy (${probe.left})`)
  }

  if (isPidLeft)
    missing.push(`pid ${pid} is still running`)

  if (cmdLeft !== undefined)
    missing.push(`\`${values.cmd}\` ${cmdLeft}`)

  const lines = watch?.excerpt() ?? []

  fail(`gave up after ${formatDuration(timeout)}${isAny ? ', none met' : ''}: ${missing.join(', ')}${lines.length === 0 ? '' : `\nlast lines of ${watch?.path}:\n${numbered(lines)}`}`, TIMEOUT_EXIT)
}

process.exitCode = await runMain({ name: 'waitfor', run: main })
