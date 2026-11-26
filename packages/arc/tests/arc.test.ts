import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'
import { parse7z, parseRar, parseZip } from '../src/entries'
import { byteProgress, ratioSummary } from '../src/proc'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname
const temp = tempDirs()
// GNU tar with ACL and xattr support, and util-linux's findmnt and mountpoint: a busybox image has none of them.
const GNU = Bun.which('zstd') !== null && Bun.which('findmnt') !== null && Bun.which('mountpoint') !== null && Bun.spawnSync(['tar', '--version']).stdout.toString().includes('GNU tar')

function arc(args: string[], cwd = process.cwd(), env: Record<string, string> = {}) {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1', ...env } })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

function project(): { root: string, folder: string, dest: string } {
  const root = temp()
  const folder = join(root, 'project')
  const dest = join(root, 'dest')

  mkdirSync(join(folder, 'src'), { recursive: true })
  mkdirSync(dest)
  writeFileSync(join(folder, 'src/a.txt'), 'alpha')
  writeFileSync(join(folder, 'b.txt'), 'beta')

  return { root, folder, dest }
}

describe.skipIf(!GNU)('arc pack', () => {
  test('--delete packs, verifies and deletes the folder', () => {
    const { folder, dest } = project()
    const result = arc(['pack', '--delete', folder, dest])

    expect(result.code).toBe(0)
    expect(result.err).toContain('deleted')
    expect(existsSync(folder)).toBe(false)
    expect(existsSync(join(dest, 'project.tar.zst'))).toBe(true)
    expect(existsSync(join(dest, 'project.tar.zst.partial'))).toBe(false)
  })

  test('keeps the folder unless asked to delete it', () => {
    const { folder, dest } = project()
    const result = arc(['pack', folder, dest])

    expect(result.code).toBe(0)
    expect(result.err).toContain('kept')
    expect(existsSync(folder)).toBe(true)
    expect(existsSync(join(dest, 'project.tar.zst'))).toBe(true)
  })

  test('packs a folder holding a dangling symlink without sudo', () => {
    const { root, folder, dest } = project()
    const bin = join(root, 'bin')

    mkdirSync(bin)
    writeFileSync(join(bin, 'sudo'), `#!/bin/sh\ntouch '${join(root, 'sudo-ran')}'\nexit 1\n`, { mode: 0o755 })
    symlinkSync('/nonexistent', join(folder, 'x'))

    expect(arc(['pack', folder, dest], process.cwd(), { PATH: `${bin}:${process.env.PATH}` }).code).toBe(0)
    expect(existsSync(join(root, 'sudo-ran'))).toBe(false)
  })

  test('packs a folder holding a file name with a newline', () => {
    const { folder, dest } = project()

    writeFileSync(join(folder, 'nl\nname'), 'x')

    expect(arc(['pack', folder, dest]).code).toBe(0)
  })

  test('a refused pack removes the archive it wrote', () => {
    const { folder, dest } = project()
    const socket = Bun.listen({ unix: join(folder, 'held.sock'), socket: { data() {
      // held open only, so the folder holds a socket tar skips
    } } })

    try {
      const result = arc(['pack', folder, dest])

      expect(result.code).toBe(1)
      expect(result.err).toContain('archive removed')
      expect(existsSync(join(dest, 'project.tar.zst'))).toBe(false)
    }
    finally {
      socket.stop(true)
    }
  })

  test('packs into the current folder when no destination is given', () => {
    const { folder, dest } = project()

    expect(arc(['pack', folder], dest).code).toBe(0)
    expect(existsSync(folder)).toBe(true)
    expect(existsSync(join(dest, 'project.tar.zst'))).toBe(true)
  })

  test('overwrites nothing', () => {
    const { folder, dest } = project()

    writeFileSync(join(dest, 'project.tar.zst'), 'mine')

    const result = arc(['pack', folder, dest])

    expect(result.code).toBe(1)
    expect(result.err).toContain('already exists')
    expect(readFileSync(join(dest, 'project.tar.zst'), 'utf8')).toBe('mine')
    expect(existsSync(folder)).toBe(true)
  })

  test('keeps the folder and reports when an entry cannot be archived', () => {
    const { folder, dest } = project()
    const socket = Bun.listen({ unix: join(folder, 'sock'), socket: { data: () => undefined } })

    try {
      const result = arc(['pack', folder, dest])

      expect(result.code).toBe(1)
      expect(result.err).toContain('kept')
      expect(existsSync(join(folder, 'src/a.txt'))).toBe(true)
    }
    finally {
      socket.stop(true)
    }
  })

  test('sees through a symlinked parent when checking the destination', () => {
    const { root, folder } = project()

    symlinkSync(root, join(root, 'via'))

    const result = arc(['pack', join(root, 'via/project'), join(folder, 'src')])

    expect(result.code).toBe(1)
    expect(result.err).toContain('inside')
    expect(existsSync(folder)).toBe(true)
  })

  test('--exclude skips matching entries and still verifies the rest', () => {
    const { folder, dest } = project()

    mkdirSync(join(folder, 'node_modules/pkg'), { recursive: true })
    writeFileSync(join(folder, 'node_modules/pkg/index.js'), 'ignored')
    writeFileSync(join(folder, 'skip.log'), 'ignored')

    const result = arc(['pack', '--exclude', 'node_modules', '--exclude', '*.log', folder, dest])

    expect(result.code).toBe(0)
    const listed = arc(['ls', '-r', join(dest, 'project.tar.zst')]).out

    expect(listed).toContain('project/src/a.txt')
    expect(listed).not.toContain('node_modules')
    expect(listed).not.toContain('skip.log')
  })

  test('packs a single file, verifies it and deletes it with --delete', () => {
    const { root, folder, dest } = project()
    const file = join(folder, 'b.txt')
    const restored = join(root, 'restored')

    mkdirSync(restored)

    const result = arc(['pack', '--delete', file, dest])

    expect(result.code).toBe(0)
    expect(result.err).toContain('1 entries')
    expect(existsSync(file)).toBe(false)
    expect(arc(['unpack', join(dest, 'b.txt.tar.zst'), restored]).code).toBe(0)
    expect(readFileSync(join(restored, 'b.txt'), 'utf8')).toBe('beta')
  })

  test('refuses a symlink, a missing destination and a destination inside the folder', () => {
    const { root, folder, dest } = project()

    symlinkSync(folder, join(root, 'link'))

    expect(arc(['pack', join(root, 'link'), dest]).err).toContain('is a symlink')
    expect(arc(['pack', folder, join(root, 'nope')]).err).toContain('not a folder')

    mkdirSync(join(folder, 'inside'))

    expect(arc(['pack', folder, join(folder, 'inside')]).err).toContain('inside')
    expect(existsSync(folder)).toBe(true)
  })

  test('packs a read-only folder without sudo when --delete is not passed, and asks for sudo with --delete', () => {
    const { root, folder, dest } = project()
    const bin = join(root, 'bin')

    mkdirSync(bin)
    writeFileSync(join(bin, 'sudo'), `#!/bin/sh\ntouch '${join(root, 'sudo-ran')}'\nexit 1\n`, { mode: 0o755 })
    chmodSync(folder, 0o555)

    try {
      const kept = arc(['pack', folder, dest], process.cwd(), { PATH: `${bin}:${process.env.PATH}` })

      expect(kept.code).toBe(0)
      expect(existsSync(join(root, 'sudo-ran'))).toBe(false)

      const dest2 = join(root, 'dest2')

      mkdirSync(dest2)

      const del = arc(['pack', '--delete', folder, dest2], process.cwd(), { PATH: `${bin}:${process.env.PATH}` })

      expect(del.code).toBe(1)
      expect(existsSync(join(root, 'sudo-ran'))).toBe(true)
    }
    finally {
      chmodSync(folder, 0o755)
    }
  })

  test('accepts --level and --threads and rejects out-of-range values', () => {
    const { folder, dest } = project()

    expect(arc(['pack', '--level', '1', '--threads', '1', folder, dest]).code).toBe(0)
    expect(arc(['pack', '--level', '0', folder, dest]).code).toBe(2)
    expect(arc(['pack', '--level', '20', folder, dest]).code).toBe(2)
    expect(arc(['pack', '--threads', '0', folder, dest]).code).toBe(2)
  })

  test('prints a progress bar and no red ANSI on a real TTY for pack, unpack and extract', () => {
    if (Bun.which('python3') === null)
      return

    const { folder, dest, root } = project()
    const restored = join(root, 'restored')
    const extracted = join(root, 'extracted')

    mkdirSync(restored)
    mkdirSync(extracted)
    writeFileSync(join(folder, 'big.bin'), Buffer.alloc(256 * 1024, 0x41))

    const runPty = (args: string[]) => {
      const script = `import os, pty, select, subprocess, sys
master, slave = pty.openpty()
env = dict(os.environ)
env["KIT_MODE"] = "terminal"
env["TERM"] = "xterm-256color"
env.pop("NO_COLOR", None)
env.pop("NODE_DISABLE_COLORS", None)
env.pop("CLAUDECODE", None)
env.pop("AI_AGENT", None)
env.pop("ANTIGRAVITY_AGENT", None)
p = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, env=env)
os.close(slave)
chunks = []
while True:
    r, _, _ = select.select([master], [], [], 0.2)
    if r:
        try:
            data = os.read(master, 4096)
            if not data:
                break
            chunks.append(data)
        except OSError:
            break
    elif p.poll() is not None:
        break
p.wait()
os.close(master)
sys.stdout.buffer.write(b"".join(chunks))
sys.exit(p.returncode)`
      const res = Bun.spawnSync(['python3', '-c', script, process.execPath, CLI, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })

      return { code: res.exitCode, out: res.stdout.toString() }
    }

    const packed = runPty(['pack', folder, dest])

    expect(packed.code).toBe(0)
    expect(packed.out).not.toContain('\x1B[31m')
    expect(packed.out).toContain('━')
    expect(packed.out).toContain('✓')

    const unpacked = runPty(['unpack', join(dest, 'project.tar.zst'), restored])

    expect(unpacked.code).toBe(0)
    expect(unpacked.out).not.toContain('\x1B[31m')
    expect(unpacked.out).toContain('━')
    expect(unpacked.out).toContain('✓')

    const ext = runPty(['extract', join(dest, 'project.tar.zst'), extracted])

    expect(ext.code).toBe(0)
    expect(ext.out).not.toContain('\x1B[31m')
    expect(ext.out).toContain('━')
    expect(ext.out).toContain('✓')
  })
})

describe('progress formatting', () => {
  test('scales byte progress across B, KiB and MiB with percent and throughput', () => {
    expect(byteProgress(0, 0)).toEqual({})
    expect(byteProgress(0, undefined)).toEqual({})
    expect(byteProgress(256, 512)).toEqual({ done: 256, total: 512, unit: 'B (50%)' })
    expect(byteProgress(50 * 1024, 100 * 1024, 1000)).toEqual({ done: 50, total: 100, unit: 'KiB (50%, 50K/s)' })
    expect(byteProgress(25 * 1024 ** 2, 50 * 1024 ** 2, 1000)).toEqual({ done: 25, total: 50, unit: 'MiB (50%, 25M/s)' })
    // Clamps when tar header overhead pushes streamed bytes slightly past estimated total.
    expect(byteProgress(600, 512)).toEqual({ done: 512, total: 512, unit: 'B (100%)' })
    expect(ratioSummary(1024 * 1024, 512 * 1024)).toBe('1.0M -> 512K (50%)')
  })
})

describe.skipIf(!GNU)('arc unpack', () => {
  test('round-trips what pack made', () => {
    const { folder, dest, root } = project()
    const restored = join(root, 'restored')

    mkdirSync(restored)
    arc(['pack', folder, dest])

    const result = arc(['unpack', join(dest, 'project.tar.zst'), restored])

    expect(result.code).toBe(0)
    expect(result.err).toContain('every file matches')
    expect(readFileSync(join(restored, 'project/src/a.txt'), 'utf8')).toBe('alpha')
    expect(existsSync(join(dest, 'project.tar.zst'))).toBe(true)
  })

  test('refuses to overwrite a top-level entry', () => {
    const { folder, dest, root } = project()

    arc(['pack', folder, dest])

    const result = arc(['unpack', join(dest, 'project.tar.zst'), root])

    expect(result.code).toBe(1)
    expect(result.err).toContain('already exists')
  })

  test('refuses a file that is not an archive', () => {
    const { dest } = project()

    writeFileSync(join(dest, 'x.tar.zst'), 'not zstd')

    expect(arc(['unpack', join(dest, 'x.tar.zst'), dest]).err).toContain('fails its checksum')
  })
})

describe('arc extract', () => {
  test('extracts a tarbomb into a subfolder by default, and directly with --flat', () => {
    const { folder, dest } = project()

    Bun.spawnSync(['tar', 'czf', join(dest, 'p.tar.gz'), '-C', folder, '.'])

    const out = temp()

    expect(arc(['extract', join(dest, 'p.tar.gz')], out).code).toBe(0)
    expect(readFileSync(join(out, 'p/b.txt'), 'utf8')).toBe('beta')

    const flatOut = temp()

    expect(arc(['extract', '--flat', join(dest, 'p.tar.gz')], flatOut).code).toBe(0)
    expect(readFileSync(join(flatOut, 'b.txt'), 'utf8')).toBe('beta')
  })

  test('extracts a single-root tarball directly into the destination and supports --verify', () => {
    const { folder, dest } = project()

    Bun.spawnSync(['tar', 'czf', join(dest, 'wrapped.tar.gz'), '-C', join(folder, '..'), 'project'])

    const out = temp()
    const result = arc(['extract', '--verify', join(dest, 'wrapped.tar.gz'), out])

    expect(result.code).toBe(0)
    expect(readFileSync(join(out, 'project/src/a.txt'), 'utf8')).toBe('alpha')
  })

  test('keeps the source of a lone compressed file and matches the suffix in any case', () => {
    const out = temp()
    const source = join(out, 'note.txt.GZ')

    writeFileSync(source, Bun.gzipSync('hello'))

    expect(arc(['extract', source], out).code).toBe(0)
    expect(existsSync(source)).toBe(true)
    expect(readFileSync(join(out, 'note.txt'), 'utf8')).toBe('hello')
  })

  test('writes a lone compressed file into the current folder, wherever it sits', () => {
    const { dest } = project()
    const source = join(dest, 'note.txt.bz2')

    writeFileSync(source, Bun.spawnSync(['bzip2', '-c'], { stdin: Buffer.from('hello') }).stdout)

    const out = temp()

    expect(arc(['extract', source], out).code).toBe(0)
    expect(existsSync(source)).toBe(true)
    expect(readFileSync(join(out, 'note.txt'), 'utf8')).toBe('hello')
  })

  // Making one takes the xz binary, which busybox's tar calls and the CI image lacks.
  test.skipIf(Bun.which('xz') === null)('extracts a .txz', () => {
    const { folder, dest } = project()

    Bun.spawnSync(['tar', 'cJf', join(dest, 'p.TXZ'), '-C', folder, '.'])

    const out = temp()

    expect(arc(['extract', '--flat', join(dest, 'p.TXZ')], out).code).toBe(0)
    expect(readFileSync(join(out, 'b.txt'), 'utf8')).toBe('beta')
  })

  test('keeps a file already there unless --overwrite', () => {
    const { folder, dest } = project()

    Bun.spawnSync(['tar', 'czf', join(dest, 'p.tar.gz'), '-C', folder, '.'])

    const out = temp()

    writeFileSync(join(out, 'b.txt'), 'mine')

    expect(arc(['extract', '--flat', join(dest, 'p.tar.gz')], out).code).toBe(1)
    expect(readFileSync(join(out, 'b.txt'), 'utf8')).toBe('mine')
    expect(readFileSync(join(out, 'src/a.txt'), 'utf8')).toBe('alpha')
    expect(arc(['extract', '--flat', '--overwrite', join(dest, 'p.tar.gz')], out).code).toBe(0)
    expect(readFileSync(join(out, 'b.txt'), 'utf8')).toBe('beta')
  })

  test('refuses a lone compressed file whose output exists, and never removes it on a failed --overwrite', () => {
    const out = temp()

    writeFileSync(join(out, 'note.txt'), 'mine')
    writeFileSync(join(out, 'note.txt.gz'), Bun.gzipSync('hello'))

    const refused = arc(['extract', join(out, 'note.txt.gz')], out)

    expect(refused.code).toBe(1)
    expect(refused.err).toContain('already exists')
    expect(readFileSync(join(out, 'note.txt'), 'utf8')).toBe('mine')

    writeFileSync(join(out, 'note.txt.gz'), 'not gzip')

    expect(arc(['extract', '--overwrite', join(out, 'note.txt.gz')], out).code).toBe(1)
    expect(readFileSync(join(out, 'note.txt'), 'utf8')).toBe('mine')
    expect(existsSync(join(out, 'note.txt.arc-partial'))).toBe(false)
  })

  test('says so for an unknown extension', () => {
    const { dest } = project()

    writeFileSync(join(dest, 'x.weird'), '')

    expect(arc(['extract', join(dest, 'x.weird')]).err).toContain('unknown extension')
  })
})

describe.skipIf(!GNU)('arc ls, tree and cat', () => {
  function archived(): string {
    const { folder, dest } = project()

    symlinkSync('b.txt', join(folder, 'link'))
    arc(['pack', folder, dest])

    return join(dest, 'project.tar.zst')
  }

  test('ls lists the top level, a folder and everything with -r', () => {
    const file = archived()

    expect(arc(['ls', file]).out).toMatch(/project\/\n$/)
    expect(arc(['ls', file, 'project']).out).toContain(' b.txt\n')
    expect(arc(['ls', file, 'project']).out).toContain(' link -> b.txt\n')
    expect(arc(['ls', file, 'project']).out).not.toContain('a.txt')
    expect(arc(['ls', '-r', file]).out).toContain('project/src/a.txt')
  })

  test('ls --json gives the entries', () => {
    const entries = JSON.parse(arc(['ls', '-r', '--json', archived()]).out) as { path: string, kind: string, size: number }[]

    expect(entries.find(entry => entry.path === 'project/src/a.txt')).toMatchObject({ kind: 'file', size: 5 })
    expect(entries.find(entry => entry.path === 'project/src')?.kind).toBe('dir')
  })

  test('tree draws the paths and honours -L', () => {
    const file = archived()

    expect(arc(['tree', file]).out).toContain('a.txt')
    expect(arc(['tree', '-L', '1', file]).out).not.toContain('a.txt')
  })

  test('cat prints a file of the archive', () => {
    const file = archived()

    expect(arc(['cat', file, 'project/src/a.txt']).out).toBe('alpha')
    expect(arc(['cat', file, 'project/nope']).code).toBe(1)
    expect(arc(['cat', file, 'project/src']).err).toContain('folder')
  })

  test('reads a zip too', () => {
    const { folder, dest } = project()
    const zip = join(dest, 'p.zip')

    if (Bun.which('zip') === null)
      return

    Bun.spawnSync(['zip', '-qr', zip, '.'], { cwd: folder })

    expect(arc(['ls', '-r', zip]).out).toContain('src/a.txt')
    expect(arc(['cat', zip, 'src/a.txt']).out).toBe('alpha')
  })

  test('reads the backslashes of a zip made on Windows as folders', () => {
    const entries = parseZip('        5  2026-06-23 05:06   mod\\src\\a.lua\n        0  2026-06-23 05:06   mod\\src\\\n')

    expect(entries.map(entry => [entry.path, entry.kind, entry.raw])).toEqual([['mod/src/a.lua', 'file', 'mod\\src\\a.lua'], ['mod/src', 'dir', 'mod\\src\\']])
  })

  test('grep searches text inside an archive without extracting it', () => {
    const file = archived()
    const hit = arc(['grep', 'alp', file])

    expect(hit.code).toBe(0)
    expect(hit.out).toContain('project/src/a.txt:1: alpha')
    expect(arc(['grep', '-i', '-l', 'BETA', file]).out.trim()).toBe('project/b.txt')
    expect(JSON.parse(arc(['grep', '--json', 'alpha', file]).out)).toEqual([{ path: 'project/src/a.txt', line: 1, text: 'alpha' }])
    expect(arc(['grep', 'nonexistent', file]).code).toBe(1)
  })

  test('parses 7z and rar listings', () => {
    const seven = parse7z('----------\nPath = app/main.ts\nSize = 42\nModified = 2026-06-23 05:06:00\nAttributes = A\n\nPath = app\nFolder = +\nSize = 0\n')
    const rar = parseRar('Name: app/main.ts\nType: File\nSize: 42\nmtime: 2026-06-23 05:06:00\nAttributes: -rw-r--r--\n\nName: app\nType: Directory\nSize: 0\n')

    expect(seven.map(entry => [entry.path, entry.kind, entry.size])).toEqual([['app/main.ts', 'file', 42], ['app', 'dir', 0]])
    expect(rar.map(entry => [entry.path, entry.kind, entry.size])).toEqual([['app/main.ts', 'file', 42], ['app', 'dir', 0]])
  })

  test('refuses what is not an archive', () => {
    const { dest } = project()

    writeFileSync(join(dest, 'x.txt'), '')

    expect(arc(['ls', join(dest, 'x.txt')]).code).toBe(1)
  })
})
