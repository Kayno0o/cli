import { basename } from 'node:path'
import { fail } from '@kaynooo/cli-kit'
import { reach } from './download'

// `<hash>  <name>` as sha256sum writes it, `*` marking binary mode, or a hash alone as a `.sha256` file holds it.
const GNU_LINE = /^([0-9a-f]{64})(?:\s+\*?(\S.*))?$/i
// `SHA256 (<name>) = <hash>` as BSD's sha256 and shasum --tag write it.
const BSD_LINE = /^SHA256 \((.+)\) = ([0-9a-f]{64})$/i

// The sha256 a checksums file gives for `name`, or the lone hash of a file holding one; undefined when it names none for it.
export function sumFor(text: string, name: string): string | undefined {
  const entries: [hash: string, name: string | undefined][] = []

  for (const line of text.split('\n').map(line => line.trim())) {
    const gnu = GNU_LINE.exec(line)
    const bsd = gnu === null ? BSD_LINE.exec(line) : null

    if (gnu !== null)
      entries.push([gnu[1]!, gnu[2]])
    else if (bsd !== null)
      entries.push([bsd[2]!, bsd[1]])
  }

  const named = entries.find(([, file]) => file !== undefined && basename(file) === name)

  if (named !== undefined)
    return named[0].toLowerCase()

  const [only] = entries

  return entries.length === 1 && only![1] === undefined ? only![0].toLowerCase() : undefined
}

// Fetches the checksums file at `url` and answers the sha256 it gives for `name`.
export async function fetchSum(url: string, name: string): Promise<string> {
  return sumFor(await (await reach(url)).text(), name) ?? fail(`${url} holds no sha256 for ${name}`, 1)
}
