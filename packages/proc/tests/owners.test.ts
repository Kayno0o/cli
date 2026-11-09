import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { socketOwners } from '../src/read'

async function fakeProc(procs: Record<number, { ppid: number, inodes: number[] }>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'owners-'))

  for (const [pid, { ppid, inodes }] of Object.entries(procs)) {
    await mkdir(join(root, pid, 'fd'), { recursive: true })
    await writeFile(join(root, pid, 'stat'), `${pid} (nginx) S ${ppid} 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100 0 0`)

    for (const [index, inode] of inodes.entries())
      await symlink(`socket:[${inode}]`, join(root, pid, 'fd', String(index)))
  }

  return root
}

test('a listen socket shared with forked workers belongs to the master', async () => {
  const root = await fakeProc({
    500: { ppid: 1, inodes: [9] },
    501: { ppid: 500, inodes: [9, 11] },
    502: { ppid: 500, inodes: [9] },
    300: { ppid: 500, inodes: [9] },
    700: { ppid: 500, inodes: [9] },
    100: { ppid: 500, inodes: [9] },
  })
  const owners = await socketOwners(root)

  expect(owners.get(9)).toBe(500)
  expect(owners.get(11)).toBe(501)
})
