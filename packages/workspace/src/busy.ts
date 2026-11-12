import { readdir, readFile, readlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { runCommand } from '@kaynooo/cli-kit'

// The programs a dev server, watcher or test run shows as, by /proc's comm; a shell or an editor sitting in a folder rebuilds nothing.
const DEV_PROGRAMS = new Set(['node', 'bun', 'deno', 'npm', 'npx', 'pnpm', 'yarn', 'bunx', 'vite', 'esbuild', 'ruby', 'java', 'cargo', 'go', 'php', 'php-fpm'])
const DEV_PREFIXES = ['python', 'php']
const DOCKER_MS = 5000
const PID = /^\d+$/
// After the comm field of /proc/<pid>/stat come the state, then the parent's pid.
const PARENT = /^ \S+ (\d+)/

export interface Place {
  path: string
  who: string
}

function isDevProgram(comm: string): boolean {
  return DEV_PROGRAMS.has(comm) || DEV_PREFIXES.some(prefix => comm.startsWith(prefix))
}

async function quietly<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read()
  }
  catch {
    return undefined
  }
}

// The pid and its parents, so the sweep run and whatever launched it never count as using the folder they were started from.
async function lineage(pid: number, root: string): Promise<Set<number>> {
  const seen = new Set<number>()

  for (let current = pid; current > 1 && !seen.has(current);) {
    seen.add(current)
    const stat = await quietly(async () => readFile(join(root, String(current), 'stat'), 'utf8'))
    // The comm field may hold spaces and parentheses, so the fields are read from the last ')'.
    const parent = Number(PARENT.exec(stat?.slice(stat.lastIndexOf(')') + 1) ?? '')?.[1])

    if (!Number.isInteger(parent))
      break

    current = parent
  }

  return seen
}

// The working folder and the absolute arguments of every dev process this user can read, as places in use.
export async function processPlaces(root = '/proc', self = process.pid): Promise<Place[]> {
  const own = await lineage(self, root)
  const pids = (await quietly(async () => readdir(root)) ?? []).filter(name => PID.test(name)).map(Number).filter(pid => !own.has(pid))
  const places: Place[] = []

  await Promise.all(pids.map(async (pid) => {
    const comm = (await quietly(async () => readFile(join(root, String(pid), 'comm'), 'utf8')))?.trim()

    if (comm === undefined || !isDevProgram(comm))
      return

    const cwd = await quietly(async () => readlink(join(root, String(pid), 'cwd')))
    const argv = (await quietly(async () => readFile(join(root, String(pid), 'cmdline'), 'utf8')))?.split('\0').filter(arg => arg.startsWith('/')) ?? []
    const who = `pid ${pid} ${comm}`

    for (const path of [cwd, ...argv.slice(1)]) {
      if (path !== undefined)
        places.push({ path, who })
    }
  }))

  return places
}

// The host folders bind-mounted into running containers; nothing when docker is missing, stopped or slow.
export async function containerPlaces(): Promise<Place[]> {
  const ids = await quietly(async () => runCommand(['docker', 'ps', '-q'], { timeoutMs: DOCKER_MS }))

  if (ids === undefined || ids.code !== 0 || ids.text.trim() === '')
    return []

  const inspected = await quietly(async () => runCommand(['docker', 'inspect', '--format', '{{.Name}}{{range .Mounts}}{{if eq .Type "bind"}}\t{{.Source}}{{end}}{{end}}', ...ids.text.trim().split('\n')], { timeoutMs: DOCKER_MS }))

  if (inspected === undefined || inspected.code !== 0)
    return []

  return inspected.text.trim().split('\n').flatMap((line) => {
    const [name = '', ...sources] = line.split('\t')

    return sources.map(path => ({ path, who: `container ${basename(name)}` }))
  })
}

const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`)

// Who uses `folder`: a dev process inside it, or a container mounting it, a part of it or a folder holding it.
export function userOf(folder: string, processes: Place[], containers: Place[]): string | undefined {
  return processes.find(place => within(place.path, folder))?.who ?? containers.find(place => within(place.path, folder) || within(folder, place.path))?.who
}
