import type { Arg } from '@kaynooo/cli-kit/picker'
import type { Entry, Kind } from './jobs'
import process from 'node:process'
import { closest, fail, jsonOption, paint, parse, printJson } from '@kaynooo/cli-kit'
import { byRecency, emit, list, record, runs } from '@kaynooo/cli-kit/picker'
import { input } from '@kaynooo/cli-kit/prompt'
import { labelled, pickJob } from './job-picker'
import { everything, id, justFlags, key, readKind, resolve, shortest, signature } from './jobs'

const usage = `j [name] [args...]
j -

Without a name, picks a recipe, target, script or task of this folder, its parents and its child folders when a terminal is attached, and runs it. The ones run last come first, per folder. Without a terminal it lists them instead.
\`j -\` runs the last one again with the same arguments, \`j <name> [args...]\` runs without the picker, the words after the name filling the parameters in order and the required ones left being asked for.
The sources are a Justfile, a Makefile, the scripts of a package.json (through its package manager), composer.json scripts, deno tasks, a Taskfile, mise tasks and a pyproject (poe tasks and entry points).
A name is the key behind the folder it runs from, \`api/test\`, bare for this folder. A name several entries share offers them, unless it comes qualified by its runner: \`just:check\`, \`bun:api/test\`.

Exits with the code of the command it ran, 1 when there is nothing to run here or nothing by that name.`

const options = {
  json: jsonOption('[{ id, key, runner, dir, name, doc, parameters }]'),
} as const

// The command it runs, then its body.
function preview(kind: Kind, dir: string, name: string): void {
  const entry = readKind(kind, dir).find(candidate => candidate.name === name)

  if (entry === undefined)
    return

  const colors = paint(process.stdout)

  console.log(`${colors.dim(`$ ${dir === '.' ? '' : `env -C ${dir} `}`)}${colors.bold([...entry.runner, entry.name].join(' '))}\n`)

  if (entry.body !== undefined)
    console.log(entry.body)
  else
    Bun.spawnSync(['just', ...justFlags(dir, dir === '.') ?? [], '--show', name], { stdout: 'inherit', stderr: 'inherit' })
}

// The qualified forms only for the keys that need one, each with the description fish shows beside it: the doc comment, else the runner.
function names(found: Entry[]): [name: string, description: string][] {
  const described = (entry: Entry) => entry.doc === null || entry.doc === '' ? entry.tag : entry.doc

  return [...new Set(found.map(key))].flatMap((name) => {
    const same = resolve(found, name)

    return same.length === 1
      ? [[name, described(same[0]!)] as [string, string]]
      : [[name, same.map(entry => entry.tag).join(', ')] as [string, string], ...same.map(entry => [id(entry), described(entry)] as [string, string])]
  })
}

// The rows term lists in place of the picker.
function listed(found: Entry[]) {
  const labels = labelled(found)

  return byRecency(found, runs('j'), id).map(entry => ({
    label: [labels ? entry.tag : '', key(entry), signature(entry)].filter(Boolean).join(' '),
    hint: entry.doc ?? '',
    typed: shortest(found, entry),
    preview: ['--show', entry.kind, entry.dir, entry.name],
    editsTyped: true,
  }))
}

function table(found: Entry[]): string {
  const colors = paint(process.stdout)
  const labels = labelled(found)
  const rows = found.map(entry => [...labels ? [entry.tag] : [], key(entry), signature(entry)])
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map(cells => cells[column]!.length))) ?? []

  return found.map((entry, index) => `${rows[index]!.map((cell, column) => cell.padEnd(widths[column]!)).join('  ')}  ${colors.dim(entry.doc ?? '')}`.trimEnd()).join('\n')
}

// The words typed after the name fill its parameters in order, so only the required ones past them are asked for.
function missing(entry: Entry, given: string[]): string[] {
  return entry.parameters.slice(given.length).filter(parameter => parameter.default === null && parameter.kind === 'singular').map(parameter => parameter.name)
}

function commandOf<T extends Arg>(entry: Entry, args: T[]): (string | T)[] {
  const separated = entry.separated && args.length > 0 ? ['--'] : []

  return [...entry.dir === '.' ? [] : ['env', '-C', entry.dir], ...entry.runner, entry.name, ...separated, ...args]
}

export async function j(argv: string[]): Promise<number> {
  const [flag = ''] = argv

  if (flag === '--show') {
    const [kind = 'just', dir = '.', name = ''] = argv.slice(1)

    preview(kind as Kind, dir, name)

    return 0
  }

  if (flag === '--record') {
    record('j', { id: argv[1] ?? '', args: argv.slice(2) })

    return 0
  }

  if (flag === '--list' || flag === '--names') {
    const found = everything()

    if (found.length === 0)
      fail('nothing to run here: no recipe, target, script or task', 1)

    if (flag === '--list')
      list(listed(found))
    else
      console.log(names(found).map(([name, description]) => `${name}\t${description}`).join('\n'))

    return 0
  }

  // The protocol the tmux picker reads instead of running the command: its mode, the words typed back, the id to record and the command's words, `?name` for a parameter to ask.
  const emitting = flag === '--emit'
  const args = emitting ? argv.slice(1) : argv
  // A lone dash is the last run again, which the option parser would take for a flag of the words after it.
  const last = args[0] === '-'
  const parsed = last
    ? { values: {} as { json?: boolean }, positionals: ['-'], rest: args.slice(1) }
    : parse(args, usage, options, {
      positionals: ['[name]'],
      trailing: true,
      replaces: 'reading the Justfile, Makefile, package.json scripts or composer scripts to find what to run, then retyping it',
      examples: ['j', ['j test', 'run the test recipe, script or task'], ['j api/test --watch', 'a child folder\'s, with an argument'], ['j just:check', 'the one of a runner, when several share the name'], ['j -', 'the last one again']],
    })
  const [named] = parsed.positionals
  const given = parsed.rest ?? []
  const found = everything()

  if (found.length === 0)
    fail('nothing to run here: no recipe, target, script or task', 1)

  const previous = runs('j')
  const interactive = process.stdin.isTTY && process.stderr.isTTY && parsed.values.json !== true
  let entry: Entry | undefined
  let words = given

  if (named === '-') {
    const earlier = previous[0]

    entry = earlier && found.find(candidate => id(candidate) === earlier.id)

    if (entry === undefined)
      fail(earlier ? `${earlier.id} is gone` : 'nothing run here yet', 1)

    words = [...earlier!.args, ...given]
  }
  else if (named === undefined) {
    if (!interactive) {
      if (emitting)
        fail('the picker needs a terminal', 1)

      if (parsed.values.json === true)
        printJson(found.map(each => ({ id: id(each), key: key(each), runner: each.tag, dir: each.dir, name: each.name, doc: each.doc, parameters: each.parameters })))
      else
        console.log(table(found))

      return 0
    }

    entry = await pickJob(byRecency(found, previous, id))
  }
  else {
    // A job on the command line runs as named, the picker only opens for a name several entries share.
    const matching = resolve(found, named)

    if (matching.length === 0) {
      const nearest = closest(named, found.map(key))

      fail(`nothing named ${named}${nearest === undefined ? '' : `, did you mean ${nearest}?`}`, 1)
    }

    if (matching.length > 1 && !interactive)
      fail(`${named} is several: ${matching.map(id).join(', ')}`, 1, 'qualify it with its runner')

    entry = matching.length === 1 ? matching[0] : await pickJob(matching, true)
  }

  if (entry === undefined)
    return 1

  const typed = shortest(found, entry)
  const asks = missing(entry, words)

  if (emitting) {
    emit('run', typed, id(entry), commandOf(entry, [...words.map(word => ({ given: word })), ...asks.map(ask => ({ ask }))]))

    return 0
  }

  const answers: string[] = []

  for (const ask of asks) {
    const answer = await input(ask)

    if (answer === undefined)
      return 1

    answers.push(answer)
  }

  const all = [...words, ...answers]

  record('j', { id: id(entry), args: all })

  return Bun.spawn(commandOf(entry, all), { stdio: ['inherit', 'inherit', 'inherit'] }).exited
}
