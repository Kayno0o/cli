import { existsSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fail, formatSize } from '@kaynooo/cli-kit'
import { progressLine } from '@kaynooo/cli-kit/progress'

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
}

// How much of the start is kept to tell an HTML page or a binary apart.
const HEAD_BYTES = 8192
const HTML_START = /^\s*<(?:!doctype html|html)[\s>]/i
const DISPOSITION_NAME = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i

// Streams `url` into a new file of `dir`, hashing it on the way under a progress line; the file goes again on any failure.
export async function download(url: string, dir: string, maxSize: number): Promise<Downloaded> {
  // A .tar.gz an S3 bucket or static host labels Content-Encoding: gzip would otherwise be saved inflated, under a sha256 nobody published.
  const response = await reach(url, { headers: { 'accept-encoding': 'identity' }, decompress: false })
  const name = fileName(response, url)
  const path = join(dir, name)

  if (existsSync(path))
    return fail(`'${path}' already exists`, 1, 'download into another folder with -o, or none to get a new one')

  const length = Number(response.headers.get('content-length') ?? Number.NaN)
  const total = Number.isFinite(length) && length > 0 ? length : undefined

  if (total !== undefined && total > maxSize)
    return fail(`${url} is ${formatSize(total)}, over --max-size ${formatSize(maxSize)}`, 1)

  const line = progressLine()
  const hasher = new Bun.CryptoHasher('sha256')
  const writer = Bun.file(path).writer()
  const head: Uint8Array[] = []
  let headSize = 0
  let size = 0

  line.update({ step: name, ...counted(0, total) })

  try {
    for await (const chunk of (response.body ?? new ReadableStream()) as AsyncIterable<Uint8Array>) {
      size += chunk.length

      if (size > maxSize)
        fail(`${url} goes over --max-size ${formatSize(maxSize)}`, 1)

      if (headSize < HEAD_BYTES) {
        head.push(chunk.subarray(0, HEAD_BYTES - headSize))
        headSize += head.at(-1)!.length
      }

      hasher.update(chunk)
      await writer.write(chunk)
      line.update({ step: name, ...counted(size, total) })
    }

    await writer.end()
  }
  catch (error) {
    await writer.end()
    rmSync(path, { force: true })
    line.failed(name)

    throw error
  }

  line.done(`${name} ${formatSize(size)}`)

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
  }
}

// The answer of `url` after its redirects, failing with exit 1 when it cannot be reached or answers an error status.
export async function reach(url: string, init?: BunFetchRequestInit): Promise<Response> {
  let response: Response

  try {
    response = await fetch(url, init)
  }
  catch (error) {
    return fail(`cannot reach ${url}: ${error instanceof Error ? error.message : String(error)}`, 1)
  }

  return response.ok ? response : fail(`${url} answered ${response.status} ${response.statusText}`.trimEnd(), 1)
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
