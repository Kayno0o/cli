import { extname } from 'node:path'
import { fail } from '@kaynooo/cli-kit'

// The JSON, YAML and TOML files ev reads, by extension, each with the parser Bun has for it; `.json` takes comments too, as tsconfig-style files carry them.
const PARSERS: Record<string, [format: string, parse: (text: string) => unknown]> = {
  '.json': ['JSON', text => Bun.JSONC.parse(text)],
  '.jsonc': ['JSON', text => Bun.JSONC.parse(text)],
  '.json5': ['JSON', text => Bun.JSON5.parse(text)],
  '.yaml': ['YAML', text => Bun.YAML.parse(text)],
  '.yml': ['YAML', text => Bun.YAML.parse(text)],
  '.toml': ['TOML', text => Bun.TOML.parse(text)],
}

export function structuredFormat(path: string): string | undefined {
  return PARSERS[extname(path).toLowerCase()]?.[0]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null)
    return false

  const prototype = Object.getPrototypeOf(value) as unknown

  return prototype === Object.prototype || prototype === null
}

// Each leaf under its dotted path (`database.password`, `servers.0.host`); a TOML date prints as written, a null as nothing. An empty object or list leaves no key, a key holding a dot reads like a nested one, and a number prints as JavaScript reads it (`1.0` as `1`).
function flatten(value: unknown, path: string, into: Map<string, string>): void {
  if (Array.isArray(value) || isRecord(value)) {
    for (const [key, each] of Object.entries(value))
      flatten(each, path === '' ? key : `${path}.${key}`, into)

    return
  }

  into.set(path, value === null || value === undefined ? '' : String(value))
}

// The keys of a JSON, YAML or TOML file as dotted paths to their values, `name` naming it in a refusal.
export function parseStructured(name: string, text: string): Map<string, string> {
  const [format, parse] = PARSERS[extname(name).toLowerCase()] ?? []

  if (format === undefined || parse === undefined)
    fail(`${name} is not JSON, YAML or TOML`)

  let parsed: unknown

  try {
    parsed = parse(text)
  }
  catch (error) {
    fail(`${name} is not valid ${format}: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (!Array.isArray(parsed) && !isRecord(parsed))
    fail(`${name} holds a single ${format} value, no keys`)

  const into = new Map<string, string>()

  flatten(parsed, '', into)

  return into
}
