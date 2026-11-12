import type { Edit, Node as JsonNode, ParseError } from 'jsonc-parser'
import type { Document, Pair } from 'yaml'
// Kept out of structured.ts: the editors are bundled into ev's dist, and the modules other packages import from src must not need them.
import { parse as parseToml, patch as patchToml } from '@decimalturn/toml-patch'
import { fail } from '@kaynooo/cli-kit'
import { applyEdits, createScanner, findNodeAtLocation, modify, parseTree } from 'jsonc-parser'
import { isAlias, isMap, isScalar, isSeq, parseDocument, stringify } from 'yaml'
import { isRecord, parseStructured, parseStructuredValue, structuredFormat } from './structured'

type Path = (string | number)[]

interface Located { path: Path, current: unknown }

const INDEX = /^\d+$/
const INDENT = /^([ \t]+)\S/m
const INDENT_ONLY = /^[ \t]*/
const BLANK = /^[ \t]*$/
const CR = /\r$/
// What may follow a JSON value on its line, so a property added after it goes on the next line and leaves a comment there in place.
const LINE_TAIL = /^[ \t]*(?:\/\/.*|\/\*.*\*\/[ \t]*)?\r?$/
const SPACED_COLON = /"[ \t]*:[ \t]/
const SPACED_COMMA = /,[ \t]/
// jsonc-parser's SyntaxKind, a const enum its types declare and modules cannot import.
const LINE_COMMENT = 12
const BLOCK_COMMENT = 13
const END = 17

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

function lineStart(text: string, at: number): number {
  return text.lastIndexOf('\n', at - 1) + 1
}

// The offset after the line holding `at`, its line break included.
function lineEnd(text: string, at: number): number {
  const end = text.indexOf('\n', at)

  return end === -1 ? text.length : end + 1
}

function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

// The comments of a JSON text, those starting inside `[from, to)` left out.
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

// A property added to a JSON object as its siblings are written: on a line of its own at their indent in a multi-line object, inline with their spacing in a one-line one, the rest of the file untouched.
function jsonInsert(text: string, tree: JsonNode, path: Path, value: unknown): Edit[] {
  let depth = path.length - 1
  let parent = findNodeAtLocation(tree, path.slice(0, depth))

  while (parent?.type !== 'object' && depth > 0)
    parent = findNodeAtLocation(tree, path.slice(0, --depth))

  if (parent?.type !== 'object')
    return fail(`the file holds no object to add ${path.join('.')} to`, 1)

  const added = path.slice(depth + 1).reduceRight<unknown>((inner, key) => ({ [key]: inner }), value)
  const own = text.slice(parent.offset, parent.offset + parent.length)
  const colon = SPACED_COLON.test(text) ? ': ' : ':'
  const last = parent.children?.at(-1)

  if (!own.includes('\n')) {
    const property = `${JSON.stringify(path[depth])}${colon}${JSON.stringify(added)}`

    return last === undefined
      ? [{ offset: parent.offset + 1, length: parent.length - 2, content: property }]
      : [{ offset: last.offset + last.length, length: 0, content: `${SPACED_COMMA.test(own) ? ', ' : ','}${property}` }]
  }

  const eol = eolOf(text)
  const unit = INDENT.exec(text)?.[1] ?? '  '
  const outer = INDENT_ONLY.exec(text.slice(lineStart(text, parent.offset), parent.offset))?.[0] ?? ''
  const indent = last === undefined ? `${outer}${unit}` : text.slice(lineStart(text, last.offset), last.offset)
  const property = `${indent}${JSON.stringify(path[depth])}${colon}${JSON.stringify(added, null, unit).replaceAll('\n', `${eol}${indent}`)}`

  if (last === undefined)
    return [{ offset: parent.offset + 1, length: parent.length - 2, content: `${eol}${property}${eol}${outer}` }]

  // The comma goes right after the last value, or a trailing one is kept, and the new line goes after a comment ending that line.
  const rest = text.slice(last.offset + last.length)
  const trailing = rest.trimStart().startsWith(',')
  const end = last.offset + last.length + (trailing ? rest.length - rest.trimStart().length + 1 : 0)
  const lineBreak = text.indexOf('\n', end)
  const tail = lineBreak === -1 ? undefined : text.slice(end, lineBreak)
  const after = tail !== undefined && LINE_TAIL.test(tail) ? end + tail.replace(CR, '').length : end
  const comma = trailing ? '' : ','

  return after === end
    ? [{ offset: end, length: 0, content: `${comma}${eol}${property}` }]
    : [{ offset: end, length: 0, content: comma }, { offset: after, length: 0, content: `${eol}${property}` }]
}

// jsonc-parser replaces or removes the key's span alone when no formatting is asked, as its formatter would redo the lines around it; an added key is written by jsonInsert. Removing one also takes the text up to the previous value, so a comment there would go with it unless refused.
function editJson(name: string, text: string, path: Path, value: unknown): string {
  const errors: ParseError[] = []
  const tree = parseTree(text, errors, { allowTrailingComma: true })

  if (errors.length > 0 || tree === undefined)
    return unchanged(name, 'JSON')

  const existing = findNodeAtLocation(tree, path)
  const edited = applyEdits(text, value === undefined || existing !== undefined ? modify(text, path, value, {}) : jsonInsert(text, tree, path, value))
  const property = value === undefined ? existing?.parent : undefined
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

type Range = [number, number, number]

// Where `path` leads in the document, keys matched as the text the parsed file reads them as (so `404:` is key '404'): the pair or list item it names, else the deepest map on the way and how many segments lead to it.
interface YamlSpot { map?: unknown, depth: number, pair?: Pair, item?: unknown }

function yamlSpot(document: Document, path: Path): YamlSpot {
  let node: unknown = document.contents

  for (let depth = 0; depth < path.length; depth++) {
    const segment = path[depth]!

    if (isSeq(node)) {
      if (depth === path.length - 1)
        return { depth, item: node.items[Number(segment)] }

      node = node.items[Number(segment)]

      continue
    }

    if (!isMap(node))
      return { depth }

    const pair = node.items.find(each => isScalar(each.key) && String(each.key.value) === String(segment))

    if (pair === undefined)
      return { map: node, depth }

    if (depth === path.length - 1)
      return { map: node, depth, pair }

    node = pair.value
  }

  return { depth: path.length }
}

// yaml prints a whole document anew, folding lines and respacing comments, so the edit is a splice of the source at the ranges it parsed: the value's own span, a line added after the last of its map, or the key's lines taken out.
function editYaml(name: string, text: string, path: Path, value: unknown): string {
  const document = parseDocument(text)

  if (document.errors.length > 0)
    unchanged(name, 'YAML')

  const refuse = (why: string): never => fail(`${name}: ${path.join('.')} ${why}, which ev does not edit`, 1, 'edit it by hand')
  const spot = yamlSpot(document, path)
  const node = spot.pair === undefined ? spot.item : spot.pair.value

  if (value !== undefined && (spot.pair !== undefined || spot.item !== undefined)) {
    if (isAlias(node))
      refuse('is an alias')

    if (!isScalar(node))
      return refuse('holds no plain value')

    const scalar = node
    const [from, to] = scalar.range!

    if (scalar.type === 'BLOCK_LITERAL' || scalar.type === 'BLOCK_FOLDED')
      refuse('is a block scalar')

    // An empty value has an empty range wherever the parser stopped, so the value goes right after the key's colon.
    if (from === to) {
      const key = spot.pair?.key as { range: Range } | undefined
      const colon = key === undefined ? -1 : text.indexOf(':', key.range[1])

      if (colon === -1)
        refuse('is an empty list item')

      return `${text.slice(0, colon + 1)} ${yamlScalar(value)}${text.slice(colon + 1)}`
    }

    return `${text.slice(0, from)}${yamlScalar(value, scalar.type)}${text.slice(to)}`
  }

  if (value === undefined) {
    const key = spot.pair?.key as { range: Range } | undefined

    if (key === undefined)
      return text

    const start = lineStart(text, key.range[0])
    const valueEnd = (node as { range?: Range } | null | undefined)?.range?.[1] ?? 0

    if (!BLANK.test(text.slice(start, key.range[0])))
      refuse('shares its line with another key')

    // A block scalar's range ends at the start of the next line, so the removal ends on the line of the value's last character.
    return `${text.slice(0, start)}${text.slice(lineEnd(text, Math.max(key.range[1], valueEnd) - 1))}`
  }

  const parent = spot.map as { flow?: boolean, items: Pair[], range?: Range } | undefined

  if (!isMap(parent) || parent.flow === true || parent.items.length === 0)
    return refuse(spot.depth === 0 ? 'is not under a block mapping' : 'sits in a flow mapping or list')

  const first = parent.items[0]!.key as { range: Range }
  const column = first.range[0] - lineStart(text, first.range[0])
  const unit = INDENT.exec(text)?.[1] ?? '  '
  const eol = eolOf(text)
  const lines = path.slice(spot.depth).map((segment, index, missing) => {
    const indent = ' '.repeat(column + index * unit.length)
    const key = yamlScalar(String(segment))

    return index === missing.length - 1 ? `${indent}${key}: ${yamlScalar(value)}` : `${indent}${key}:`
  })
  const at = lineEnd(text, parent.range![1] - 1)
  const before = text.slice(0, at)

  return `${before}${before.endsWith('\n') ? '' : eol}${lines.join(eol)}${eol}${text.slice(at)}`
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
