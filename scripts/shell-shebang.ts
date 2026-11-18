import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const ENV_SHEBANG = /^#!\/usr\/bin\/env -S bun((?: --[\w-]+(?:=\S+)?)*)\n/
const BUN_PRAGMA = /^\/\/ @bun\b.*$/m

/**
 * A built bin's `#!/usr/bin/env -S bun <flags>` turned into a header BusyBox runs too, its env having no -S (kaynooo/cli#339): sh tries the `//` folder, silenced, then hands the file to Bun with the flags.
 * The exec goes on Bun's own `// @bun` line when the build wrote one, since sh would run that line first.
 */
export function shellShebang(source: string): string | undefined {
  const shebang = ENV_SHEBANG.exec(source)

  if (shebang === null)
    return undefined

  const exec = `2>/dev/null; exec bun${shebang[1]} "$0" "$@"`
  const body = source.slice(shebang[0].length)
  const pragma = BUN_PRAGMA.exec(body)

  return pragma?.index === 0 ? `#!/bin/sh\n${pragma[0]} ${exec}${body.slice(pragma[0].length)}` : `#!/bin/sh\n// ${exec}\n${body}`
}

if (import.meta.main) {
  const dir = process.argv[2] ?? 'dist'

  for (const file of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    if (!file.endsWith('.js'))
      continue

    const path = join(dir, file)
    const rewritten = shellShebang(readFileSync(path, 'utf8'))

    if (rewritten !== undefined)
      writeFileSync(path, rewritten)
  }
}
