export const CONVERT_FORMATS = ['json', 'yaml', 'toml'] as const

export type ConvertFormat = (typeof CONVERT_FORMATS)[number]

const BARE_KEY = /^[\w-]+$/

export function normalizeFormat(raw: string): ConvertFormat | undefined {
  const lower = raw.toLowerCase()

  if (lower === 'yml')
    return 'yaml'

  return (CONVERT_FORMATS as readonly string[]).includes(lower) ? lower as ConvertFormat : undefined
}

export function parseStructured(format: ConvertFormat, text: string): unknown {
  if (format === 'json')
    return Bun.JSONC.parse(text)

  return format === 'yaml' ? Bun.YAML.parse(text) : Bun.TOML.parse(text)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
}

function tomlKey(key: string): string {
  return BARE_KEY.test(key) ? key : JSON.stringify(key)
}

function tomlValue(value: unknown): string {
  if (typeof value === 'string')
    return JSON.stringify(value)

  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value)

  if (value instanceof Date)
    return value.toISOString()

  if (Array.isArray(value))
    return `[${value.map(item => tomlValue(item)).join(', ')}]`

  if (isPlainObject(value)) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined && item !== null)
      .map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`)

    return `{ ${entries.join(', ')} }`
  }

  throw new Error(`TOML cannot represent ${value === null ? 'null' : typeof value}`)
}

function emitTomlTable(obj: Record<string, unknown>, prefix: string[], lines: string[]): void {
  const scalars: [string, unknown][] = []
  const tables: [string, Record<string, unknown>][] = []
  const tableArrays: [string, Record<string, unknown>[]][] = []

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null)
      continue

    if (isPlainObject(value))
      tables.push([key, value])
    else if (Array.isArray(value) && value.length > 0 && value.every(isPlainObject))
      tableArrays.push([key, value])
    else
      scalars.push([key, value])
  }

  if (prefix.length > 0 && (scalars.length > 0 || (tables.length === 0 && tableArrays.length === 0))) {
    if (lines.length > 0)
      lines.push('')

    lines.push(`[${prefix.map(tomlKey).join('.')}]`)
  }

  for (const [key, value] of scalars)
    lines.push(`${tomlKey(key)} = ${tomlValue(value)}`)

  for (const [key, table] of tables)
    emitTomlTable(table, [...prefix, key], lines)

  for (const [key, items] of tableArrays) {
    const header = [...prefix, key].map(tomlKey).join('.')

    for (const item of items) {
      if (lines.length > 0)
        lines.push('')

      lines.push(`[[${header}]]`)
      emitTomlTable(item, [], lines)
    }
  }
}

export function stringifyToml(value: unknown): string {
  if (!isPlainObject(value))
    throw new Error('TOML requires an object at the root')

  const lines: string[] = []

  emitTomlTable(value, [], lines)

  return lines.join('\n')
}

export function formatStructured(format: ConvertFormat, value: unknown, compact = false): string {
  if (format === 'json')
    return JSON.stringify(value, null, compact ? undefined : 2)

  return format === 'yaml' ? Bun.YAML.stringify(value, null, 2).trimEnd() : stringifyToml(value)
}
