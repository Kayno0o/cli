import type { ExitRow } from '@kaynooo/cli-kit'
import type { Service } from './stack'
import process from 'node:process'
import { loadKnown } from '@kaynooo/cli-env/files'
import { Redactor } from '@kaynooo/cli-env/redactor'
import { badUsage, fail, isHumanTerminal, parse, wholeNumber } from '@kaynooo/cli-kit'
import { dlog } from './dlog'
import { allServices, key, LOGS_TAIL, nearestStack, stackAt } from './stack'

const usage = `dc logs [service...] [--tail <n>] [--since <dur>] [--grep <regex>] [--errors] [--follow | --no-follow] [--raw]

Prints or follows compose service logs with secrets masked by default (--raw disables redaction).
With --errors, delegates to \`dc health\` to show service states and deduplicated recent errors.
Follows on a human terminal by default unless --no-follow or --grep is set; prints once off a terminal.`

const EXITS: ExitRow[] = [['its own', 'exit code of docker compose logs'], [0, 'logs printed'], [1, 'no matching service or compose failed'], [2, 'a usage error']]

const options = {
  tail: { type: 'string', short: 'n', description: `lines from the end (${LOGS_TAIL})` },
  since: { type: 'string', description: 'show logs since timestamp or duration (e.g. 15m, 1h)' },
  grep: { type: 'string', short: 'g', description: 'keep only log lines matching this regex (case-insensitive)' },
  errors: { type: 'boolean', short: 'e', description: 'show health + deduplicated recent error lines (same as dc health)' },
  follow: { type: 'boolean', short: 'f', negative: 'print logs once and exit', description: 'follow log output' },
  raw: { type: 'boolean', description: 'disable secret redaction on log output' },
} as const

function compileGrep(pattern: string | undefined): RegExp | undefined {
  if (pattern === undefined)
    return undefined

  try {
    return new RegExp(pattern, 'i')
  }
  catch {
    return badUsage(`--grep takes a regex, ${pattern} is not one`)
  }
}

async function streamFiltered(stream: ReadableStream<Uint8Array>, out: NodeJS.WriteStream, redactor: Redactor | undefined, grep: RegExp | undefined): Promise<void> {
  const decoder = new TextDecoder()
  let pending = ''

  const emitChunk = (text: string) => {
    const clean = redactor === undefined ? text : redactor.push(text)

    if (grep === undefined) {
      if (clean !== '')
        out.write(clean)

      return
    }

    pending += clean
    const lines = pending.split('\n')

    pending = lines.pop() ?? ''

    for (const line of lines) {
      if (grep.test(line))
        out.write(`${line}\n`)
    }
  }

  for await (const chunk of stream)
    emitChunk(decoder.decode(chunk, { stream: true }))

  emitChunk(decoder.decode())

  const tail = redactor === undefined ? '' : redactor.end()

  if (grep === undefined) {
    if (tail !== '')
      out.write(tail)

    return
  }

  const last = pending + tail

  if (last !== '' && grep.test(last))
    out.write(last.endsWith('\n') ? last : `${last}\n`)
}

export async function dcLogs(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options, { positionals: ['[service...]'], allowNegative: true, exits: EXITS })

  if (parsed.values.errors === true) {
    const forwarded = [
      ...parsed.positionals,
      ...(parsed.values.tail === undefined ? [] : ['-n', parsed.values.tail]),
      ...(parsed.values.since === undefined ? [] : ['--since', parsed.values.since]),
      ...(parsed.values.grep === undefined ? [] : ['--grep', parsed.values.grep]),
    ]

    return dlog(forwarded)
  }

  const grep = compileGrep(parsed.values.grep)
  const tail = parsed.values.tail === undefined ? LOGS_TAIL : wholeNumber(parsed.values.tail, 'tail', LOGS_TAIL, 0)
  const follow = parsed.values.follow ?? (grep === undefined && isHumanTerminal(process.stdout))
  const raw = parsed.values.raw === true
  const services = await allServices()
  const wanted = parsed.positionals
  let targetStack = nearestStack('.') ?? services[0]?.stack ?? stackAt('.')
  let serviceNames: string[] = wanted

  if (wanted.length > 0 && services.length > 0) {
    const resolved: Service[] = []

    for (const name of wanted) {
      const hit = services.find(s => key(s) === name) ?? services.find(s => s.name === name)

      if (hit === undefined)
        fail(`no service named ${name}`, 1)

      resolved.push(hit)
    }

    targetStack = resolved[0]!.stack
    serviceNames = resolved.map(s => s.name)
  }

  const composeArgs = [
    ...targetStack.list.argv,
    'logs',
    `--tail=${tail}`,
    ...(parsed.values.since === undefined ? [] : [`--since=${parsed.values.since}`]),
    ...(follow ? ['-f'] : []),
    ...serviceNames,
  ]

  if (raw && grep === undefined)
    return Bun.spawn(composeArgs, { cwd: targetStack.list.cwd, env: targetStack.list.env, stdio: ['inherit', 'inherit', 'inherit'] }).exited

  const known = raw ? undefined : await loadKnown()
  const proc = Bun.spawn(composeArgs, { cwd: targetStack.list.cwd, env: targetStack.list.env, stdin: 'inherit', stdout: 'pipe', stderr: 'pipe' })

  await Promise.all([
    streamFiltered(proc.stdout, process.stdout, raw ? undefined : new Redactor(known), grep),
    streamFiltered(proc.stderr, process.stderr, raw ? undefined : new Redactor(known), grep),
  ])

  return proc.exited
}
