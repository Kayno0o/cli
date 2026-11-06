import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname
const temp = tempDirs()
// GNU tar with ACL and xattr support, and util-linux's findmnt and mountpoint: a busybox image has none of them.
const GNU = Bun.which('zstd') !== null && Bun.which('findmnt') !== null && Bun.which('mountpoint') !== null && Bun.spawnSync(['tar', '--version']).stdout.toString().includes('GNU tar')

function arc(args: string[], cwd = process.cwd()) {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } })

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
  test('packs, verifies and deletes the folder', () => {
    const { folder, dest } = project()
    const result = arc(['pack', folder, dest])

    expect(result.code).toBe(0)
    expect(result.err).toContain('deleted')
    expect(existsSync(folder)).toBe(false)
    expect(existsSync(join(dest, 'project.tar.zst'))).toBe(true)
    expect(existsSync(join(dest, 'project.tar.zst.partial'))).toBe(false)
  })

  test('-k keeps the folder', () => {
    const { folder, dest } = project()

    expect(arc(['pack', '-k', folder, dest]).code).toBe(0)
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

  test('refuses a symlink, a missing destination and a destination inside the folder', () => {
    const { root, folder, dest } = project()

    symlinkSync(folder, join(root, 'link'))

    expect(arc(['pack', join(root, 'link'), dest]).err).toContain('not a folder')
    expect(arc(['pack', folder, join(root, 'nope')]).err).toContain('not a folder')

    mkdirSync(join(folder, 'inside'))

    expect(arc(['pack', folder, join(folder, 'inside')]).err).toContain('inside')
    expect(existsSync(folder)).toBe(true)
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

    arc(['pack', '-k', folder, dest])

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
  test('extracts a tarball into the current folder', () => {
    const { folder, dest } = project()

    Bun.spawnSync(['tar', 'czf', join(dest, 'p.tar.gz'), '-C', folder, '.'])

    const out = temp()

    expect(arc(['extract', join(dest, 'p.tar.gz')], out).code).toBe(0)
    expect(readFileSync(join(out, 'b.txt'), 'utf8')).toBe('beta')
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
    arc(['pack', '-k', folder, dest])

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

  test('refuses what is not an archive', () => {
    const { dest } = project()

    writeFileSync(join(dest, 'x.txt'), '')

    expect(arc(['ls', join(dest, 'x.txt')]).code).toBe(1)
  })
})
