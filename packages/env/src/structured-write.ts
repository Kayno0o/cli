import type { ParseError } from 'jsonc-parser'
// Kept out of structured.ts: the editors are bundled into ev's dist, and the modules other packages import from src must not need them.
import { parse as parseToml, patch as patchToml } from '@decimalturn/toml-patch'
import { fail } from '@kaynooo/cli-kit'
import { applyEdits, createScanner, findNodeAtLocation, modify, parse as parseJsonc, parseTree } from 'jsonc-parser'
import { isMap, isScalar, parseDocument, stringify } from 'yaml'
import { parseStructured, parseStructuredValue, structuredFormat } from './structured'

type Path = (string | number)[]

interface Located { path: Path, current: unknown }

const INDEX = /^\d+$/
const INDENT = /^([ \t]+)\S/m
const BLANK = /^[ \t]*$/
// jsonc-parser's SyntaxKind, a const enum its types declare and modules cannot import.
const LINE_COMMENT = 12
const BLOCK_COMMENT = 13
const END = 17

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
}

// The path of `key` in the parsed file: a key holding dots is matched whole before it is split, and a list takes an item's index. A key not there yet is created under the deepest one that is.
function locate(name: string, parsed: unknown, key: string): Located {
  const segments = key.split('.')
  const path: Path = []
  let node = parsed
  let at = 0

  while (at < segments.length) {
    const segment = segments[at]!

    if (Array.isArray(node)) {
      if (!INDEX.test(segment) || Number(segment) >= node.length)
        fail(`${name}: ${path.join('.') || 'the file'} is a list with no item ${segment}`, 1)

      path.push(Number(segment))
      node = node[Number(segment)]
      at++

      continue
    }

    if (!isRecord(node))
      return fail(`${name}: ${path.join('.')} holds a value, not keys`, 1)

    const record = node
    let end = segments.length

    while (end > at && !Object.hasOwn(record, segments.slice(at, end).join('.')))
      end--

    if (end === at)
      return { path: [...path, ...segments.slice(at)], current: undefined }

    const own = segments.slice(at, end).join('.')

    path.push(own)
    node = record[own]
    at = end
  }

  if (Array.isArray(node) || isRecord(node))
    fail(`${name}: ${key} holds ${Array.isArray(node) ? 'a list' : 'keys'}, not a value`, 1)

  return { path, current: node }
}

// The value as the type the key holds: a number or a boolean stays one when the text reads back as written, anything else is a string.
function typed(current: unknown, value: string): unknown {
  if (typeof current === 'number' && value.trim() !== '' && String(Number(value)) === value)
    return Number(value)

  return typeof current === 'boolean' && (value === 'true' || value === 'false') ? value === 'true' : value
}

function unchanged(name: string, format: string): never {
  return fail(`${name}: the ${format} editor would not give this file back as it is, so nothing was written`, 1, 'edit it by hand')
}

// The comments of a JSON text with where each starts, those inside `[from, to)` left out.
function jsonComments(text: string, from = 0, to = 0): string[] {
  const scanner = createScanner(text, false)
  const found: string[] = []

  for (let token: number = scanner.scan(); token !== END; token = scanner.scan()) {
    const at = scanner.getTokenOffset()

    if ((token === LINE_COMMENT || token === BLOCK_COMMENT) && (at < from || at >= to))
      found.push(scanner.getTokenValue())
  }

  return found
}

// jsonc-parser edits the span of the key alone; removing one also takes the text up to the previous value, so a comment there would go with it unless refused.
function editJson(name: string, text: string, path: Path, value: unknown): string {
  const errors: ParseError[] = []

  parseJsonc(text, errors, { allowTrailingComma: true })

  if (errors.length > 0)
    unchanged(name, 'JSON')

  const indent = INDENT.exec(text)?.[1] ?? '  '
  const formattingOptions = { insertSpaces: !indent.includes('\t'), tabSize: indent.includes('\t') ? 1 : indent.length, eol: text.includes('\r\n') ? '\r\n' : '\n' }
  const edited = applyEdits(text, modify(text, path, value, { formattingOptions }))
  const property = value === undefined ? findNodeAtLocation(parseTree(text)!, path)?.parent : undefined
  const kept = jsonComments(text, property?.offset, property === undefined ? 0 : property.offset + property.length)

  if (jsonComments(edited).join('\0') !== kept.join('\0'))
    fail(`${name}: removing ${path.join('.')} would take a comment beside it, so nothing was written`, 1, 'edit it by hand')

  return edited
}

// A YAML scalar written as the one it replaces was: a quoted one keeps its quotes, and a plain one stays plain when YAML reads it back as the same value. A line break always goes double-quoted, whose escapes are JSON's.
function yamlScalar(value: unknown, type?: string): string {
  if (typeof value === 'string' && (value.includes('\n') || type === 'QUOTE_DOUBLE'))
    return JSON.stringify(value)

  if (typeof value === 'string' && type === 'QUOTE_SINGLE')
    return `'${value.replaceAll('\'', '\'\'')}'`

  return stringify(value, { lineWidth: 0 }).trimEnd()
}

function lineStart(text: string, at: number): number {
  return text.lastIndexOf('\n', at - 1) + 1
}

// The offset after the line holding `at`, its line break included.
function lineEnd(text: string, at: number): number {
  const end = text.indexOf('\n', at)

  return end === -1 ? text.length : end + 1
}

// yaml prints a whole document anew, folding lines and respacing comments, so the edit is a splice of the source at the ranges it parsed: the value's own span, a line added after the last of its map, or the key's line taken out.
function editYaml(name: string, text: string, path: Path, value: unknown): string {
  const document = parseDocument(text)

  if (document.errors.length > 0)
    unchanged(name, 'YAML')

  const node = document.getIn(path, true)
  const refuse = (why: string): never => fail(`${name}: ${path.join('.')} ${why}, which ev does not edit`, 1, 'edit it by hand')

  if (value !== undefined && isScalar(node)) {
    if (node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED')
      refuse('is a block scalar')

    return `${text.slice(0, node.range![0])}${yamlScalar(value, node.type)}${text.slice(node.range![1])}`
  }

  let depth = path.length - 1
  let parent = document.getIn(path.slice(0, depth), true) ?? (depth === 0 ? document.contents : undefined)

  // A key added under parents not there yet goes into the deepest map that is
  if (value !== undefined) {
    while (!isMap(parent) && depth > 0) {
      depth--
      parent = depth === 0 ? document.contents : document.getIn(path.slice(0, depth), true)
    }
  }

  if (!isMap(parent) || parent.flow === true || parent.items.length === 0)
    return refuse(depth === 0 ? 'is not under a block mapping' : 'sits in a flow mapping or list')

  if (value === undefined) {
    const pair = parent.items.find(each => isScalar(each.key) && String(each.key.value) === String(path.at(-1)))
    const key = pair?.key as { range: [number, number, number] } | undefined
    const own = pair?.value as { range?: [number, number, number] } | null | undefined

    if (key === undefined)
      return text

    const start = lineStart(text, key.range[0])

    if (!BLANK.test(text.slice(start, key.range[0])))
      refuse('shares its line with another key')

    return `${text.slice(0, start)}${text.slice(lineEnd(text, Math.max(key.range[1], own?.range?.[1] ?? 0)))}`
  }

  const first = parent.items[0]!.key as { range: [number, number, number] }
  const column = first.range[0] - lineStart(text, first.range[0])
  const unit = INDENT.exec(text)?.[1] ?? '  '
  const lines = path.slice(depth).map((segment, index, missing) => {
    const indent = ' '.repeat(column + index * unit.length)
    const key = yamlScalar(String(segment))

    return index === missing.length - 1 ? `${indent}${key}: ${yamlScalar(value)}` : `${indent}${key}:`
  })
  const at = lineEnd(text, parent.range![1] - 1)
  const before = text.slice(0, at)

  return `${before}${before.endsWith('\n') ? '' : '\n'}${lines.join('\n')}\n${text.slice(at)}`
}

function editToml(name: string, text: string, path: Path, value: unknown): string {
  let parsed: Record<string, unknown>

  try {
    parsed = parseToml(text) as Record<string, unknown>
  }
  catch {
    return unchanged(name, 'TOML')
  }

  if (patchToml(text, parsed) !== text)
    unchanged(name, 'TOML')

  let node: Record<string, unknown> = parsed

  for (const segment of path.slice(0, -1)) {
    node[segment] ??= {}
    node = node[segment] as Record<string, unknown>
  }

  const last = path.at(-1)!

  if (value === undefined)
    delete node[last]
  else
    node[last] = value

  return patchToml(text, parsed)
}

const EDITORS: Record<string, (name: string, text: string, path: Path, value: unknown) => string> = { JSON: editJson, YAML: editYaml, TOML: editToml }

// The edited text, refused unless it reads back as the file did with only `key` changed, so no edit reaches past it.
function edit(name: string, text: string, key: string, value: string | undefined): string | undefined {
  const format = structuredFormat(name)!
  const editor = EDITORS[format]

  if (editor === undefined || name.toLowerCase().endsWith('.json5'))
    return fail(`${name}: ev reads JSON5 but does not write it`, 1)

  const before = parseStructured(name, text)
  const { path, current } = locate(name, parseStructuredValue(name, text), key)

  if (value === undefined && current === undefined)
    return undefined

  if (value === undefined && typeof path.at(-1) === 'number')
    fail(`${name}: ${key} is a list item, and removing it would renumber the ones after it`, 1)

  const written = value === undefined ? undefined : typed(current, value)
  const after = editor(name, text, path, written)
  const expected = new Map(before)
  const flat = path.join('.')

  if (written === undefined)
    expected.delete(flat)
  else
    expected.set(flat, String(written))

  const read = parseStructured(name, after)

  if (read.size !== expected.size || [...expected].some(([each, was]) => read.get(each) !== was))
    fail(`${name}: the edit would change more than ${key}, so nothing was written`, 1, 'edit it by hand')

  return after
}

/** The file's text with `key` set to `value`, a number or boolean key keeping its type, its comments, order and quoting kept. */
export function setStructured(name: string, text: string, key: string, value: string): string {
  return edit(name, text, key, value)!
}

/** The file's text without `key`, or undefined when it does not set it. */
export function unsetStructured(name: string, text: string, key: string): string | undefined {
  return edit(name, text, key, undefined)
}
