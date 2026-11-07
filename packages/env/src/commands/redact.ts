import type { ExitRow } from '@kaynooo/cli-kit'
import process from 'node:process'
import { parse, readInput } from '@kaynooo/cli-kit'
import { loadKnown } from '../files'
import { check, Redactor } from '../redactor'

const usage = `redact [--check]

Copies stdin to stdout line by line with secrets masked: known token formats (GitHub, GitLab, Slack, AWS, npm, Stripe, Google and SendGrid keys, sk-, JWTs, Authorization headers, password= and secret= pairs), private key blocks, the password and the tokens of any URL and the values of secret-looking keys in this folder's .env* files.
--check prints nothing of the input and lists the file and line of each secret found, exiting 1 when there is any: \`git diff --cached | redact --check\`.`

const EXITS: ExitRow[] = [[0, 'it copied the input or found no secret'], [1, '--check finds one'], [2, 'a usage error']]

const options = {
  'check': { type: 'boolean', description: 'list where secrets are instead of masking them, exit 1 when found' },
  'no-env': { type: 'boolean', description: 'do not search for the values of the .env* files' },
} as const

export async function redact(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options, { exits: EXITS, replaces: 'printing a command\'s secrets into a log or a transcript', examples: [['docker compose config | redact', 'the resolved compose file, secrets masked'], ['git diff --cached | redact --check', 'refuse a commit carrying a secret']] })

  const known = parsed.values['no-env'] === true ? undefined : await loadKnown()

  if (parsed.values.check === true) {
    const findings = check(await readInput('-'), known)

    for (const { file, line, kind } of findings)
      console.log(`${file}:${line}: ${kind}`)

    return findings.length === 0 ? 0 : 1
  }

  const redactor = new Redactor(known)
  const decoder = new TextDecoder()

  for await (const chunk of Bun.stdin.stream())
    process.stdout.write(redactor.push(decoder.decode(chunk, { stream: true })))

  process.stdout.write(redactor.push(decoder.decode()) + redactor.end())

  return 0
}
