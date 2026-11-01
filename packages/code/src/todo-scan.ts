#!/usr/bin/env bun

import type { Mark } from './todo'
import { join } from 'node:path'
import process from 'node:process'
import { fail, jsonOption, parse, printJson, runMain, warn } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { listFiles, readText } from './files'
import { lookUp, marksIn, refKey } from './todo'

const USAGE = `todo-scan [options] [path...]: lists the TODO, FIXME and owner/repo#N comments under the paths (here by default), each as <file>:<line>: <comment>, honouring .gitignore

--stale keeps only the comments naming a closed issue, each issue's state looked up with ft, or gh for a GitHub repository, and exits 1 when it finds one.

Exits 0 when it listed the comments or found no stale one, 1 when --stale finds one or ft is not installed, 2 on a usage error.`

const OPTIONS = {
  stale: { type: 'boolean', description: 'only the comments naming a closed issue, looked up with ft or gh' },
  json: jsonOption('[{path, line, kind, text, refs: [{repo, number, state?}]}]'),
} as const

async function main(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, USAGE, OPTIONS, { positionals: ['[path...]'] })
  const cwd = process.cwd()
  const marks: Mark[] = []

  for (const path of await listFiles(positionals, cwd)) {
    const text = await readText(join(cwd, path))

    if (text !== undefined)
      marks.push(...marksIn(text, path))
  }

  if (values.stale !== true) {
    if (values.json === true)
      printJson(marks)
    else
      console.log(marks.map(mark => `${mark.path}:${mark.line}: ${mark.text}`).join('\n'))

    return 0
  }

  if (Bun.which('ft') === null)
    fail('--stale looks the issues up with ft, which is not installed', 1)

  const { states, failed } = await lookUp(marks.flatMap(mark => mark.refs), cwd)

  for (const [repo, reason] of failed)
    warn(`could not look ${repo} up`, reason)

  const stale = marks.filter(mark => mark.refs.some(ref => states.get(refKey(ref)) === 'closed'))

  if (values.json === true)
    printJson(stale.map(mark => ({ ...mark, refs: mark.refs.map(ref => ({ ...ref, state: states.get(refKey(ref)) })) })))
  else
    console.log(stale.map(mark => `${mark.path}:${mark.line}: ${mark.refs.filter(ref => states.get(refKey(ref)) === 'closed').map(refKey).join(', ')} closed: ${mark.text}`).join('\n'))

  return stale.length > 0 ? 1 : 0
}

process.exitCode = await runMain({ name: 'todo-scan', version, run: main })
