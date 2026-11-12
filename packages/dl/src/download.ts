import type { Part } from './state'
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fail, formatSize } from '@kaynooo/cli-kit'
import { progressLine } from '@kaynooo/cli-kit/progress'
import { dropPart, dropStaleParts, keepPart, partOf } from './state'

export interface Downloaded {
  path: string
  name: string
  size: number
  // Where the redirects ended.
  url: string
  type: string
  sha256: string
  // Whether the first bytes are an HTML page.
  html: boolean
  // Whether the first bytes hold no NUL, so a diff of two versions can be read.
  text: boolean
  etag?: string
  lastModified?: string
}

// How much of the start is kept to tell an HTML page or a binary apart.
const HEAD_BYTES = 8192
const HTML_START = /^\s*<(?:!doctype html|html)[\s>]/i
const DISPOSITION_NAME = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i
const CONTENT_RANGE = /^bytes (\d+)-\d+\/(?:\d+|\*)$/
const RANGE_NOT_SATISFIABLE = 416

// The request of `url`, asking for the rest of a part kept from a download that broke off; If-Range makes a server whose file changed since answer it whole. A weak ETag cannot go in If-Range, so Last-Modified stands in.
async function request(url: string, kept: (Part & { size: number }) | undefined): Promise<{ response: Response, offset: number }> {
  // A .tar.gz an S3 bucket or static host labels Content-Encoding: gzip would otherwise be saved inflated, under a sha256 nobody published.
  const headers: Record<string, string> = { 'accept-encoding': 'identity' }
  const validator = kept?.etag !== undefined && !kept.etag.startsWith('W/') ? kept.etag : kept?.lastModified

  if (kept === undefined || validator === undefined)
    return { response: await reach(url, { headers, decompress: false }), offset: 0 }

  const response = await reach(url, { headers: { ...headers, 'range': `bytes=${kept.size}-`, 'if-range': validator }, decompress: false }, [RANGE_NOT_SATISFIABLE])
  const start = CONTENT_RANGE.exec(response.headers.get('content-range') ?? '')?.[1]

  if (response.status === 206 && Number(start) === kept.size)
    return { response, offset: kept.size }

  // A 200 is the whole file, a server without ranges or one whose file changed; anything else is asked again from zero.
  if (response.status === 200)
    return { response, offset: 0 }

  await response.body?.cancel()

  return { response: await reach(url, { headers, decompress: false }), offset: 0 }
}

// The bytes a part already holds, through the hasher, and its first ones to tell an HTML page or a binary apart.
async function replay(file: string, hasher: Bun.CryptoHasher): Promise<Uint8Array> {
  for await (const chunk of Bun.file(file).stream())
    hasher.update(chunk)

  return Bun.file(file).slice(0, HEAD_BYTES).bytes()
}

// Moved into place, copied when the part lives on another filesystem than the folder.
function moveInto(from: string, to: string): void {
  try {
    renameSync(from, to)
  }
  catch {
    copyFileSync(from, to)
    rmSync(from, { force: true })
  }
}

/**
 * Streams `url` into a new file of `dir`, hashing it on the way under a progress line.
 * The bytes go to a part kept per URL until the file is whole, so a download that broke off is resumed by the next `dl` of that URL when the server can tell the file did not change.
 */
export async function download(url: string, dir: string, maxSize: number): Promise<Downloaded> {
  dropStaleParts()

  const { file: partFile, kept } = partOf(url)
  const { response, offset } = await request(url, kept)
  const name = offset > 0 ? kept!.name : fileName(response, url)
  const path = join(dir, name)

  if (existsSync(path)) {
    await response.body?.cancel()

    return fail(`'${path}' already exists`, 1, 'download into another folder with -o, or none to get a new one')
  }

  const length = Number(response.headers.get('content-length') ?? Number.NaN)
  const total = Number.isFinite(length) && length > 0 ? offset + length : undefined

  if (total !== undefined && total > maxSize) {
    await response.body?.cancel()

    return fail(`${url} is ${formatSize(total)}, over --max-size ${formatSize(maxSize)}`, 1)
  }

  // A 206 may leave its validators out, so a resumed part keeps the ones of the answer it began with
  const part: Part = { url, name, ...offset > 0 ? validators(kept!) : {}, ...validators(response.headers) }
  const resumable = part.etag !== undefined || part.lastModified !== undefined

  if (offset === 0)
    dropPart(url)

  if (resumable)
    keepPart(part)

  const line = progressLine()
  const hasher = new Bun.CryptoHasher('sha256')
  const head: Uint8Array[] = offset > 0 ? [await replay(partFile, hasher)] : []

  mkdirSync(dirname(partFile), { recursive: true })

  const handle = await open(partFile, offset > 0 ? 'a' : 'w')
  let headSize = head[0]?.length ?? 0
  let size = offset
  let overSize = false

  line.update({ step: name, ...counted(size, total) })

  try {
    for await (const chunk of (response.body ?? new ReadableStream()) as AsyncIterable<Uint8Array>) {
      size += chunk.length
      overSize = size > maxSize

      if (overSize)
        fail(`${url} goes over --max-size ${formatSize(maxSize)}`, 1)

      if (headSize < HEAD_BYTES) {
        head.push(chunk.subarray(0, HEAD_BYTES - headSize))
        headSize += head.at(-1)!.length
      }

      hasher.update(chunk)
      await handle.write(chunk)
      line.update({ step: name, ...counted(size, total) })
    }
  }
  catch (error) {
    await handle.close()
    line.failed(name)

    if (overSize || !resumable) {
      dropPart(url)

      throw error
    }

    return fail(`the download of ${url} broke off at ${formatSize(size)}: ${error instanceof Error ? error.message : String(error)}`, 1, 'run the same dl again to resume it')
  }

  await handle.close()
  moveInto(partFile, path)
  dropPart(url)
  line.done(`${name} ${formatSize(size)}${offset > 0 ? `, resumed at ${formatSize(offset)}` : ''}`)

  const start = Buffer.concat(head)

  return {
    path,
    name,
    size,
    url: response.url === '' ? url : response.url,
    type: response.headers.get('content-type') ?? '',
    sha256: hasher.digest('hex'),
    html: HTML_START.test(start.toString('utf8')),
    text: !start.includes(0),
    ...validators(part),
  }
}

// What tells the server's file did not change: from an answer's headers, or from a kept part.
function validators(from: Headers | Part): Pick<Part, 'etag' | 'lastModified'> {
  const etag = from instanceof Headers ? from.get('etag') ?? undefined : from.etag
  const lastModified = from instanceof Headers ? from.get('last-modified') ?? undefined : from.lastModified

  return { ...etag === undefined ? {} : { etag }, ...lastModified === undefined ? {} : { lastModified } }
}

// The answer of `url` after its redirects, failing with exit 1 when it cannot be reached or answers an error status other than one `allowed`.
export async function reach(url: string, init?: BunFetchRequestInit, allowed: number[] = []): Promise<Response> {
  let response: Response

  try {
    response = await fetch(url, init)
  }
  catch (error) {
    return fail(`cannot reach ${url}: ${error instanceof Error ? error.message : String(error)}`, 1)
  }

  return response.ok || allowed.includes(response.status) ? response : fail(`${url} answered ${response.status} ${response.statusText}`.trimEnd(), 1)
}

// The name the server gives in Content-Disposition, else the last part of the final URL, kept to a plain file name.
export function fileName(response: Response, requested: string): string {
  const disposition = DISPOSITION_NAME.exec(response.headers.get('content-disposition') ?? '')?.[1]
  const raw = disposition ?? new URL(response.url === '' ? requested : response.url).pathname.split('/').at(-1) ?? ''
  const name = basename(decoded(raw).replaceAll('\\', '/')).replaceAll('\0', '')

  return name === '' || name === '.' || name === '..' ? 'download' : name
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text)
  }
  catch {
    return text
  }
}

// The bar's counts in KiB or MiB, whole, so the line reads `12/38 MiB` rather than raw bytes; none when the size is unknown.
function counted(done: number, total: number | undefined): { done?: number, total?: number, unit?: string } {
  if (total === undefined)
    return {}

  const [unit, scale] = total >= 1024 ** 2 ? ['MiB', 1024 ** 2] : ['KiB', 1024]

  return { done: Math.floor(done / scale), total: Math.ceil(total / scale), unit }
}
