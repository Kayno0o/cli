import type { ExitRow } from '@kaynooo/cli-kit'
import process from 'node:process'
import { exitCodeOf, fail, holdSignals, parse } from '@kaynooo/cli-kit'
import { loadKnown, readEntries } from '../files'
import { Redactor } from '../redactor'

const usage = `ev run [-f <file>]... [--redact] [--no-override] -- <command> [args...]

Loads the variables from .env (or each -f <file> in order) into the child process's environment and runs <command>, without printing secret values.
With --redact, streams stdout and stderr through ev's redactor so any secret from the loaded files (or known token formats) is masked before it reaches the terminal or transcript.`

const EXITS: ExitRow[] = [['its own', 'the exit code of <command>'], [2, 'a usage error or missing env file'], [127, 'the command could not be started']]

const options = {
  'file': { type: 'string', short: 'f', multiple: true, description: 'env file to load (repeatable, applied in order; defaults to .env)' },
  'redact': { type: 'boolean', short: 'r', description: 'mask secrets in stdout and stderr of the child command' },
  'no-override': { type: 'boolean', description: 'keep existing process environment variables instead of overriding them from the file' },
} as const

async function pipeRedacted(stream: ReadableStream<Uint8Array>, out: NodeJS.WriteStream, redactor: Redactor): Promise<void> {
  const decoder = new TextDecoder()

  for await (const chunk of stream) {
    const text = redactor.push(decoder.decode(chunk, { stream: true }))

    if (text !== '')
      out.write(text)
  }

  const tail = redactor.push(decoder.decode()) + redactor.end()

  if (tail !== '')
    out.write(tail)
}

export async function run(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options, {
    rest: true,
    exits: EXITS,
    replaces: 'export $(cat .env | xargs) && cmd, or sourcing .env into the shell',
    examples: [
      ['ev run -- bun test', 'run tests with .env loaded'],
      ['ev run -f .env.test --redact -- bun test', 'load .env.test and redact secrets from output'],
    ],
  })
  const command = parsed.rest ?? []

  if (command.length === 0)
    fail(`give the command after --\n\n${usage}`)

  const files = parsed.values.file !== undefined && parsed.values.file.length > 0 ? parsed.values.file : ['.env']
  const loadedMaps: Map<string, string>[] = []
  const env: Record<string, string | undefined> = { ...process.env }
  const keepExisting = parsed.values['no-override'] === true

  for (const file of files) {
    const entries = await readEntries(file)

    loadedMaps.push(entries)

    for (const [key, value] of entries) {
      if (!keepExisting || env[key] === undefined)
        env[key] = value
    }
  }

  const redact = parsed.values.redact === true
  const signals = holdSignals()

  try {
    const child = Bun.spawn(command, {
      env,
      stdin: 'inherit',
      stdout: redact ? 'pipe' : 'inherit',
      stderr: redact ? 'pipe' : 'inherit',
    })

    signals.forward(child)

    if (redact) {
      const known = await loadKnown(process.cwd(), loadedMaps)

      await Promise.all([
        pipeRedacted(child.stdout as ReadableStream<Uint8Array>, process.stdout, new Redactor(known)),
        pipeRedacted(child.stderr as ReadableStream<Uint8Array>, process.stderr, new Redactor(known)),
      ])
    }

    const code = await child.exited

    return signals.signal === undefined ? code : exitCodeOf(null, signals.signal)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      fail(`command not found: ${command[0]}`, 127)

    throw error
  }
  finally {
    signals.release()
  }
}
