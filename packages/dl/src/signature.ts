import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { badUsage, fail, runTool } from '@kaynooo/cli-kit'
import { smallFile } from './download'

type Tool = 'gpg' | 'minisign' | 'cosign'

/** How `--key` names the key: a gpg fingerprint of the user's keyring, or a key file or minisign key string, with the tool that checks it. */
export interface Key {
  tool: Tool
  fingerprint?: string
  file?: string
  minisignKey?: string
}

const FINGERPRINT = /^(?:[0-9A-F]{40}|[0-9A-F]{64})$/
const SPACES = /\s+/g
// A minisign public key as `minisign -G` prints it: base64 of "Ed" and 40 bytes.
const MINISIGN_KEY = /^RW[A-Za-z0-9+/]{54}$/
const GET: Record<Tool, string> = {
  gpg: 'the gnupg package of the system',
  minisign: 'https://jedisct1.github.io/minisign/',
  cosign: 'https://docs.sigstore.dev/cosign/system_config/installation/',
}

// The tool a key file belongs to, read from its first bytes: an OpenPGP packet has its top bit set when it is binary.
function toolOfFile(path: string): Tool | undefined {
  const bytes = readFileSync(path)
  const text = bytes.subarray(0, 4096).toString('latin1')

  if (text.includes('-----BEGIN PGP PUBLIC KEY BLOCK-----') || ((bytes[0] ?? 0) & 0x80) !== 0)
    return 'gpg'

  if (text.includes('minisign public key'))
    return 'minisign'

  return text.includes('-----BEGIN PUBLIC KEY-----') ? 'cosign' : undefined
}

/** Reads `--key` before anything is downloaded, refusing a key it cannot tell, or one whose tool is not on PATH. */
export function readKey(key: string): Key {
  const fingerprint = key.replace(SPACES, '').toUpperCase()
  let found: Key

  if (FINGERPRINT.test(fingerprint)) {
    found = { tool: 'gpg', fingerprint }
  }
  else if (MINISIGN_KEY.test(key)) {
    found = { tool: 'minisign', minisignKey: key }
  }
  else if (existsSync(key) && statSync(key).isFile()) {
    const tool = toolOfFile(key) ?? badUsage(`--key ${key} is no OpenPGP, minisign or cosign public key`)

    found = { tool, file: key }
  }
  else {
    return badUsage(`--key takes a gpg fingerprint, a minisign key or a public key file, not '${key}'`)
  }

  if (Bun.which(found.tool) === null)
    fail(`--key is a ${found.tool} key and ${found.tool} is not on PATH`, 1, `install it: ${GET[found.tool]}`)

  return found
}

// A status line gpg writes on --status-fd, its fields after `[GNUPG:] <keyword>`.
function statusFields(status: string, keyword: string): string[] | undefined {
  const line = status.split('\n').find(each => each.startsWith(`[GNUPG:] ${keyword} `))

  return line?.split(' ').slice(2)
}

// gpg trusts a signature made by any key of the keyring, so the fingerprint it was made with is checked against the one asked; a key file is imported into a keyring of its own, holding only it.
async function gpgVerify(key: Key, signature: string, signed: string, work: string): Promise<string> {
  const dir = join(work, 'gnupg')
  const home = key.file === undefined ? [] : ['--homedir', dir]

  if (key.file !== undefined) {
    mkdirSync(dir, { mode: 0o700 })

    const imported = await runTool('gpg --import', ['gpg', '--batch', ...home, '--import', key.file])

    if (imported.code !== 0)
      fail(`gpg could not import ${key.file}:\n${imported.stderr.trim()}`, 1)
  }

  const verified = await runTool('gpg --verify', ['gpg', '--batch', ...home, '--status-fd', '1', '--verify', signature, signed])
  const valid = statusFields(verified.stdout, 'VALIDSIG')
  // VALIDSIG names the subkey that signed first and the primary key last.
  const by = [valid?.[0], valid?.at(-1)].filter(each => each !== undefined).map(each => each.toUpperCase())

  if (verified.code !== 0 || statusFields(verified.stdout, 'GOODSIG') === undefined || valid === undefined)
    fail(`the gpg signature does not verify:\n${verified.stderr.trim()}`, 1)

  if (key.fingerprint !== undefined && !by.includes(key.fingerprint))
    fail(`the gpg signature is by ${by.at(-1)}, not ${key.fingerprint}`, 1)

  return `gpg, by ${by.at(-1)}`
}

// minisign and cosign exit 0 only on a signature made by the key they are given.
async function toolVerify(key: Key, signature: string, signed: string): Promise<string> {
  const argv = key.tool === 'minisign'
    ? ['minisign', '-V', '-q', '-m', signed, '-x', signature, ...key.file === undefined ? ['-P', key.minisignKey!] : ['-p', key.file]]
    : ['cosign', 'verify-blob', '--key', key.file!, '--signature', signature, signed]
  const verified = await runTool(`${key.tool} verify`, argv)

  if (verified.code !== 0)
    fail(`the ${key.tool} signature does not verify:\n${`${verified.stderr}${verified.stdout}`.trim()}`, 1)

  return key.tool
}

/** Fetches the detached signature at `url` and checks it signs `signed`, a file's path or the bytes of one; answers how it was signed, for the report. */
export async function verifySignature(signed: string | Uint8Array, url: string, key: Key): Promise<string> {
  const work = mkdtempSync(join(tmpdir(), 'dl-sig-'))

  try {
    const signature = join(work, 'signature')
    const data = typeof signed === 'string' ? signed : join(work, 'signed')

    writeFileSync(signature, await smallFile(url))

    if (typeof signed !== 'string')
      writeFileSync(data, signed)

    return key.tool === 'gpg' ? await gpgVerify(key, signature, data, work) : await toolVerify(key, signature, data)
  }
  finally {
    // gpg starts its daemons for a keyring of its own too, and they would outlive the folder
    if (existsSync(join(work, 'gnupg')))
      await runTool('gpgconf --kill', ['gpgconf', '--homedir', join(work, 'gnupg'), '--kill', 'all'])

    rmSync(work, { recursive: true, force: true })
  }
}
