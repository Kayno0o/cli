import { basename } from 'node:path'
import { fail } from '@kaynooo/cli-kit'
import { smallFile } from './download'

// `<hash>  <name>` as sha256sum writes it, `*` marking binary mode, or a hash alone as a `.sha256` file holds it.
const GNU_LINE = /^([0-9a-f]{64})(?:\s+\*?(\S.*))?$/i
// `SHA256 (<name>) = <hash>` as BSD's sha256 and shasum --tag write it.
const BSD_LINE = /^SHA256 \((.+)\) = ([0-9a-f]{64})$/i

const DOT_SLASH = /^\.\//

// The download's path under the folder of the checksums file: `linux/foo` for .../v1/linux/foo beside .../v1/SHA256SUMS; undefined when it is not under it.
export function pathUnder(sumsUrl: string, url: string): string | undefined {
  const sums = new URL(sumsUrl)
  const file = new URL(url)
  const folder = sums.pathname.slice(0, sums.pathname.lastIndexOf('/') + 1)

  return sums.origin === file.origin && file.pathname.startsWith(folder) ? decoded(file.pathname.slice(folder.length)) : undefined
}

// A URL path with its escapes decoded, or as it is when a `%` starts no valid one.
function decoded(path: string): string {
  try {
    return decodeURIComponent(path)
  }
  catch {
    return path
  }
}

// The sha256 a checksums file gives for the file at `path` under it, else for the one line naming `name`, or the lone hash of a file holding one; undefined when it names none for it.
export function sumFor(text: string, name: string, path?: string): string | undefined {
  const entries: [hash: string, name: string | undefined][] = []

  for (const line of text.split('\n').map(line => line.trim())) {
    const gnu = GNU_LINE.exec(line)
    const bsd = gnu === null ? BSD_LINE.exec(line) : null

    if (gnu !== null)
      entries.push([gnu[1]!, gnu[2]])
    else if (bsd !== null)
      entries.push([bsd[2]!, bsd[1]])
  }

  const exact = path === undefined ? undefined : entries.find(([, file]) => file?.replace(DOT_SLASH, '') === path)

  if (exact !== undefined)
    return exact[0].toLowerCase()

  const named = entries.filter(([, file]) => file !== undefined && basename(file) === name)
  const hashes = new Set(named.map(([hash]) => hash.toLowerCase()))

  // Two different files of that name and none at the download's path: which one is meant cannot be told.
  if (hashes.size > 1)
    fail(`the checksums file lists ${name} as ${named.map(([, file]) => file).join(', ')}, none at the download's path`, 1)

  if (named[0] !== undefined)
    return named[0][0].toLowerCase()

  const [only] = entries

  return entries.length === 1 && only![1] === undefined ? only![0].toLowerCase() : undefined
}

// The checksums file at `url`, as bytes so a signature over it can be checked.
export async function fetchSums(url: string): Promise<Uint8Array> {
  return smallFile(url)
}

// The sha256 the checksums file `sums`, fetched from `url`, gives for the download at `fileUrl`, named `name`.
export function sumIn(sums: Uint8Array, url: string, fileUrl: string, name: string): string {
  return sumFor(new TextDecoder().decode(sums), name, pathUnder(url, fileUrl)) ?? fail(`${url} holds no sha256 for ${name}`, 1)
}
