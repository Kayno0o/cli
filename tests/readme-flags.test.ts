import type { Description } from '../packages/kit/src/args'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, test } from 'bun:test'
import { bins, run } from './bins'

const FLAG = /(?<![\w-])--[a-z][a-z0-9-]*/g
const NEGATED = /^--no-/
// A table row or bullet opening with backticked terms, the ones starting with a dash being the flags it documents; a term starting with a command is an example and prose mentions other tools' flags.
const LEADING_TERMS = /^[|-] +(`[^`]*`(?:, `[^`]*`)*)/
const TERM = /`(-[^`]*)`/g

// A README's table rows and bullets leading with a flag name an option of the package, checked for the packages whose bins are all single commands, the only ones `describe` lists the options of.
for (const [dir, packageBins] of Map.groupBy(bins, ({ source }) => dirname(dirname(source)))) {
  const described = packageBins.map(({ source }) => JSON.parse(run(source, ['--help'], { KIT_HELP: 'json' })) as Description)

  if (!described.every(({ options }) => options !== undefined))
    continue

  test(dir.split('/').pop()!, () => {
    const known = new Set(described.flatMap(({ options }) => options!.map(({ name }) => `--${name}`)))
    const documented = readFileSync(join(dir, 'README.md'), 'utf8').split('\n').flatMap((line) => {
      const terms = LEADING_TERMS.exec(line)?.[1] ?? ''

      return [...terms.matchAll(TERM)].flatMap(([, term]) => term!.match(FLAG) ?? [])
    })
    const unknown = new Set(documented.map(flag => known.has(flag) ? flag : flag.replace(NEGATED, '--')).filter(flag => !known.has(flag)))

    expect(unknown).toEqual(new Set())
  })
}
