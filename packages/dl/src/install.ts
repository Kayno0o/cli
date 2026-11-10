import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, join, relative } from 'node:path'
import process from 'node:process'
import { fail } from '@kaynooo/cli-kit'

const ELF = Buffer.from([0x7F, 0x45, 0x4C, 0x46])

export function binDir(): string {
  return join(homedir(), '.local', 'bin')
}

export function binDirOnPath(): boolean {
  return (process.env.PATH ?? '').split(delimiter).includes(binDir())
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

// Copies `source` into the bin folder as `name`, executable, renamed into place so a running copy is not written over; refuses an existing one unless `force`.
export function installBinary(source: string, name: string, force: boolean): string {
  const target = join(binDir(), name)

  if (existsSync(target) && !force)
    return fail(`'${target}' already exists`, 1, 'pass --force to replace it')

  mkdirSync(binDir(), { recursive: true })
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
