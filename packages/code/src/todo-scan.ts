#!/usr/bin/env bun

import type { Mark } from './todo'
import { join } from 'node:path'
import process from 'node:process'
import { capped, jsonOption, limitOf, limitOptions, parse, printJson, runMain, warn } from '@kaynooo/cli-kit'
import { listFiles, readText } from './files'
import { lookUp, marksIn, refKey } from './todo'

const USAGE = `todo-scan [options] [path...]: lists the TODO, FIXME and owner/repo#N comments under the paths (here by default), each as <file>:<line>: <comment>, honouring .gitignore

--stale keeps only the comments naming a closed issue, each issue's state looked up with ft, or gh for a GitHub repository, and exits 1 when it finds one.

Lists at most 100 comments, the count of the rest after them (--limit <n>, --full for all); --json is never cut unless --limit is given.

Exits 0 when it listed the comments or found no stale one, 1 when --stale finds one, 2 on a usage error or when --stale could not look a repository up (ft and gh both failed), so a clean exit never hides an unchecked issue.`

const LIST_LIMIT = 100

const OPTIONS = {
  stale: { type: 'boolean', description: 'only the comments naming a closed issue, looked up with ft or gh' },
  ...limitOptions(LIST_LIMIT),
  json: jsonOption('[{path, line, kind, text, refs: [{repo, number, state?}]}]'),
} as const

function printLines(lines: string[], footer: string | undefined): void {
  const all = [...lines, ...footer === undefined ? [] : [footer]]

  if (all.length > 0)
    console.log(all.join('\n'))
}

async function main(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, USAGE, OPTIONS, { positionals: ['[path...]'], replaces: 'grep -rn TODO, then opening each issue it names', examples: ['todo-scan src', ['todo-scan --stale', 'only the comments naming a closed issue']] })
  const cwd = process.cwd()
  const limit = limitOf(values, LIST_LIMIT)
  const marks: Mark[] = []

  for (const path of await listFiles(positionals, cwd)) {
    const text = await readText(join(cwd, path))

    if (text !== undefined)
      marks.push(...marksIn(text, path))
  }

  if (values.stale !== true) {
    const { shown, footer } = capped(marks, limit)

    if (values.json === true)
      printJson(shown)
    else
      printLines(shown.map(mark => `${mark.path}:${mark.line}: ${mark.text}`), footer)

    return 0
  }

  const { states, failed } = await lookUp(marks.flatMap(mark => mark.refs), cwd)

  for (const [repo, reason] of failed)
    warn(`could not look ${repo} up`, reason)

  const stale = marks.filter(mark => mark.refs.some(ref => states.get(refKey(ref)) === 'closed'))

  const { shown, footer } = capped(stale, limit)

  if (values.json === true)
    printJson(shown.map(mark => ({ ...mark, refs: mark.refs.map(ref => ({ ...ref, state: states.get(refKey(ref)) })) })))
  else
    printLines(shown.map(mark => `${mark.path}:${mark.line}: ${mark.refs.filter(ref => states.get(refKey(ref)) === 'closed').map(refKey).join(', ')} closed: ${mark.text}`), footer)

  if (stale.length > 0)
    return 1

  return failed.size > 0 ? 2 : 0
}

process.exitCode = await runMain({ name: 'todo-scan', run: main })
