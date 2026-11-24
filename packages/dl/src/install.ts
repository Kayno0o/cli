import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fail } from '@kaynooo/cli-kit'

const ELF = Buffer.from([0x7F, 0x45, 0x4C, 0x46])

export function binDir(override?: string): string {
  return override === undefined ? join(homedir(), '.local', 'bin') : resolve(override)
}

export function binDirOnPath(dir = binDir()): boolean {
  return (process.env.PATH ?? '').split(delimiter).includes(dir)
}

// The one executable an extracted archive holds, or the one named `wanted`; an archive with none or several fails, listing them.
export async function pickBinary(root: string, wanted: string | undefined): Promise<string> {
  const found: string[] = []

  for await (const file of new Bun.Glob('**/*').scan({ cwd: root, onlyFiles: true, dot: true }))
    found.push(join(root, file))

  const executables = found.filter(isExecutable).sort()
  const matching = wanted === undefined ? executables : executables.filter(file => basename(file) === wanted)
  const listed = executables.map(file => relative(root, file)).join(', ')

  if (matching.length === 1)
    return matching[0]!

  if (executables.length === 0)
    return fail(`the archive holds no executable`, 1)

  if (matching.length === 0)
    return fail(`the archive holds no executable named ${wanted}: ${listed}`, 1)

  return fail(`the archive holds several executables: ${listed}`, 1, 'name the one to install: --bin <name>')
}

// Copies `source` into `dir` as `name`, executable, renamed into place so a running copy is not written over; refuses an existing one unless `force`.
export function installBinary(source: string, name: string, force: boolean, dir = binDir()): string {
  const target = join(dir, name)

  if (existsSync(target) && !force)
    return fail(`'${target}' already exists`, 1, 'pass --force to replace it')

  mkdirSync(dir, { recursive: true })
  copyFileSync(source, `${target}.dl-tmp`)
  chmodSync(`${target}.dl-tmp`, 0o755)
  renameSync(`${target}.dl-tmp`, target)

  return target
}

function isExecutable(file: string): boolean {
  if ((statSync(file).mode & 0o111) !== 0)
    return true

  const start = Buffer.alloc(4)
  const fd = openSync(file, 'r')

  readSync(fd, start, 0, 4, 0)
  closeSync(fd)

  return start.equals(ELF)
}
