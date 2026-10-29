#!/usr/bin/env bun

import process from 'node:process'
import { Exit, parse } from '@kaynooo/cli-kit'
import { loadKnown } from './files'
import { check, Redactor } from './redactor'

const usage = `redact [--check]

Copies stdin to stdout line by line with secrets masked: known token formats (ghp_, github_pat_, glpat-, sk-, xox?-, JWTs), private key blocks, the password of any URL and the values of secret-looking keys in this folder's .env* files.
--check prints nothing of the input and lists the file and line of each secret found, exiting 1 when there is any: \`git diff --cached | redact --check\`.`

const options = {
  'check': { type: 'boolean', description: 'list where secrets are instead of masking them, exit 1 when found' },
  'no-env': { type: 'boolean', description: 'do not search for the values of the .env* files' },
} as const

async function run(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options)

  if (parsed === undefined)
    return 0

  const known = parsed.values['no-env'] === true ? undefined : await loadKnown()

  if (parsed.values.check === true) {
    const findings = check(await Bun.stdin.text(), known)

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

try {
  process.exitCode = await run(process.argv.slice(2))
}
catch (error) {
  console.error(`redact: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = error instanceof Exit ? error.code : 1
}
