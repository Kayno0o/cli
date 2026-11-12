import type { ComposeConfig } from './compose'
import type { Project, Route } from './project'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { warn } from '@kaynooo/cli-kit'
import { composeConfig } from './compose'
import { wtConfig } from './config'
import { volumeExists } from './files'
import { git } from './git'
import { stringToPort } from './port'
import { WtError } from './project'
import { hasDevproxy, proxyHostList } from './proxy'

export type Draft = Omit<Project, 'link' | 'env' | 'setup' | 'settings'> & Required<Pick<Project, 'copy' | 'clone' | 'skip'>>

const CERT_PATH = /cert/i
// devproxy's upstreams: `http://<container>:<port>` or `host:<port>`, and `<container>:<port>` for a passthrough.
const HTTP_TARGET = /^(?:https?:\/\/)?([\w.-]+):(\d+)$/
const PASSTHROUGH_TARGET = /^([\w.-]+):(\d+)$/

// check-ignore prints the paths it matches and exits 1 when none does, so only its output is trusted.
async function ignoredPaths(repo: string, paths: string[]): Promise<string[]> {
  if (!paths.length)
    return []

  const matched = new Set((await git(repo, 'check-ignore', ...paths)).out.split('\n'))

  return paths.filter(path => matched.has(path))
}

// Host paths the stack mounts, whether as a bind or as a named volume bound to a device.
function mountedPaths(config: ComposeConfig): string[] {
  const binds = Object.values(config.services).flatMap(service => (service.volumes ?? []).filter(v => v.type === 'bind').map(v => v.source!))
  const devices = Object.values(config.volumes ?? {}).flatMap(volume => volume.driver_opts?.device ?? [])

  return [...new Set([...binds, ...devices])]
}

// Routes are read back from the hosts the shared proxy serves main on: those dialling one of its containers, and its dev server port on the host.
async function findRoutes(config: ComposeConfig, name: string, network: string): Promise<Route[]> {
  const serviceOf = (target: string) => Object.entries(config.services).find(([service, settings]) =>
    settings.container_name === target
    || `${config.name}-${service}-1` === target
    || settings.networks?.[network]?.aliases?.includes(target))?.[0]
  const routes: Route[] = []
  const hosts = await proxyHostList()

  for (const { host, group, to, passthrough } of hosts) {
    const [, target = '', port = ''] = (passthrough ? PASSTHROUGH_TARGET : HTTP_TARGET).exec(to) ?? []
    const service = serviceOf(target)

    if (target === 'host' && Number(port) === stringToPort(name))
      routes.push({ host, to: 'client' })
    else if (service !== undefined)
      routes.push({ host, to: `${service}:${Number(port)}`, ...passthrough ? { passthrough } : {} })
    // A label of main's own stack, so one of its hosts, yet the draft cannot tell which service it reaches
    else if (group === `docker-${config.name}`)
      warn(`devproxy serves ${host} from ${config.name}'s labels, to ${to}, which is no service of it: add its route by hand`)
  }

  if (!hasDevproxy())
    warn('devproxy is not installed or has no config, so the draft has no routes: write them by hand, or set devproxy up and run init again')
  else if (!hosts.length)
    warn('devproxy serves no hosts, so the draft has no routes: start main\'s stack for devproxy to read its labels and run init again, or write them by hand')
  else if (!routes.length)
    warn(`none of the hosts devproxy serves leads to ${config.name}, so the draft has no routes: start main's stack and run init again, or write them by hand`)

  return routes
}

// Ignored env files and JWT keys of the root and of each repo, in that order.
async function secretsToCopy(root: string, repos: string[]): Promise<string[]> {
  const perBase = await Promise.all(['.', ...repos].map(async (base) => {
    const envFiles = readdirSync(join(root, base)).filter(entry => (entry.startsWith('.env') || entry === '.nuxtrc') && statSync(join(root, base, entry)).isFile())
    const jwt = base !== '.' && existsSync(join(root, base, 'config', 'jwt')) ? [join(base, 'config', 'jwt')] : []

    return [...(await ignoredPaths(join(root, base), envFiles)).map(entry => join(base, entry)), ...jwt]
  }))

  return perBase.flat()
}

// `name` names the manifest and is hashed into the dev server port, the checkout's folder name by default.
async function draftFor(dir: string, given?: string): Promise<Draft> {
  const top = await git(dir, 'rev-parse', '--show-toplevel')

  if (!top.ok)
    throw new WtError(`${dir} is not inside a git repository`)

  const root = top.out
  const config = await composeConfig(root)
  const name = given ?? basename(root)
  const mounted = mountedPaths(config).filter(path => path.startsWith(`${root}/`)).map(path => relative(root, path))
  const repos = readdirSync(root).filter(entry => existsSync(join(root, entry, '.git')) && mounted.some(path => path === entry || path.startsWith(`${entry}/`)))
  const inRepo = (path: string) => repos.some(repo => path === repo || path.startsWith(`${repo}/`))
  const volumes = Object.entries(config.volumes ?? {}).filter(([, volume]) => (volume.driver_opts?.device ?? '') === '')

  const [secrets, ignoredMounts, volumesExist] = await Promise.all([
    secretsToCopy(root, repos),
    ignoredPaths(root, mounted.filter(path => !inRepo(path) && existsSync(join(root, path)))),
    Promise.all(volumes.map(async ([key, volume]) => volumeExists(volume.name ?? `${config.name}_${key}`))),
  ])
  const routes = await findRoutes(config, name, (await wtConfig()).proxyNetwork)
  const certs = routes.some(route => route.passthrough) ? mounted.find(path => CERT_PATH.test(path)) : undefined

  return {
    name,
    root: fromHome(root, homedir()),
    repos,
    copy: [...secrets, ...ignoredMounts.filter(path => CERT_PATH.test(path))],
    clone: [...ignoredMounts.filter(path => !CERT_PATH.test(path)), ...volumes.filter((_, index) => volumesExist[index]).map(([key]) => key)],
    skip: Object.entries(config.services).filter(([, service]) => service.network_mode === 'host').map(([service]) => service),
    ...certs !== undefined && { certs },
    routes,
  }
}

/** The path as `~/…` when it lies under home, as it is otherwise. */
export function fromHome(path: string, home: string): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

const QUOTED = /['\\\n\r]/g
const ESCAPES: Record<string, string> = { '\'': '\\\'', '\\': '\\\\', '\n': '\\n', '\r': '\\r' }

// A single-quoted TypeScript string, its quotes, backslashes and line breaks escaped.
const str = (value: string) => `'${value.replace(QUOTED, char => ESCAPES[char]!)}'`
const list = (values: string[]) => `[${values.map(str).join(', ')}]`

export function render(draft: Draft): string {
  const routes = draft.routes.map(route => `    { host: ${str(route.host)}, to: ${str(route.to)}${route.passthrough ? ', passthrough: true' : ''} },`)

  return [
    `import type { ProjectConfig } from '@kaynooo/cli-wt'`,
    '',
    '// Drafted by `wt init`: check every list against the stack before the first `wt add`.',
    'export default {',
    `  root: ${str(draft.root)},`,
    `  repos: ${list(draft.repos)},`,
    `  copy: ${list(draft.copy)},`,
    `  clone: ${list(draft.clone)},`,
    ...draft.skip.length ? [`  skip: ${list(draft.skip)},`] : [],
    ...draft.certs !== undefined ? [`  certs: ${str(draft.certs)},`] : [],
    '  setup: [],',
    '  routes: [',
    ...routes,
    '  ],',
    '} satisfies ProjectConfig',
    '',
  ].join('\n')
}

export async function initProject(dir: string, options: { print?: boolean, name?: string }): Promise<void> {
  const draft = await draftFor(dir, options.name)
  const content = render(draft)

  if (options.print)
    return console.log(content)

  const { manifests } = await wtConfig()
  const file = join(manifests, `${draft.name}.ts`)

  mkdirSync(manifests, { recursive: true })

  if (existsSync(file))
    throw new WtError(`${file} already exists, compare with \`wt init --print\``)

  writeFileSync(file, content)
  writeTsconfig(manifests)
  console.log(`wt: drafted ${file}, review it before \`wt add\``)
}

// wt's own folder, from src/ or the built dist/ alike; the package ships its sources.
const PACKAGE_ROOT = join(import.meta.dir, '..')

// Nothing resolves the manifests' `@kaynooo/cli-wt` import where they live, so a tsconfig beside them points it at the wt that wrote it, for an editor to type-check them. One already there is the user's and stays.
function writeTsconfig(manifests: string): void {
  const file = join(manifests, 'tsconfig.json')

  if (existsSync(file))
    return

  const compilerOptions = {
    target: 'ESNext',
    module: 'Preserve',
    moduleResolution: 'bundler',
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    paths: { '@kaynooo/cli-wt': [join(PACKAGE_ROOT, 'src', 'index.ts')] },
  }

  writeFileSync(file, `${JSON.stringify({ compilerOptions }, null, 2)}\n`)
}
