/** addTask, removeTask, cloneData and whilePaused against fake docker and mkcert on a PATH of their own and a HOME of their own, so nothing reaches the real stack. */

import type { Sandbox } from './sandbox'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { $ } from 'bun'
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { makeSandbox } from './sandbox'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
const DRIVER = join(import.meta.dir, 'sandbox_driver.ts')
const HEX_VOLUME = 'a'.repeat(64)
const IDENTITY = { GIT_AUTHOR_NAME: 'wt', GIT_AUTHOR_EMAIL: 'wt@test', GIT_COMMITTER_NAME: 'wt', GIT_COMMITTER_EMAIL: 'wt@test' }
const MAIN_CONFIG = { name: 'times', services: { 'api-php': { networks: { default: null } }, 'mailhog': { container_name: 'times-mailhog', ports: [{}] } }, volumes: { mailpit: {} } }
const WORKTREE_CONFIG = { ...MAIN_CONFIG, name: 'times--planning' }
const MANIFEST = {
  root: '~/Workspace/times',
  repos: [],
  copy: ['.env', '.docker/nginx/certs', 'api/.env.local', 'api/config/jwt', 'client/.env', 'client/.nuxtrc'],
  clone: ['mailpit'],
  certs: '.docker/nginx/certs',
  routes: [
    { host: 'times.localhost', to: 'client' },
    { host: 'api.times.localhost', to: 'api-php:443', passthrough: true },
    { host: 'mail.times.localhost', to: 'mailhog:8025' },
  ],
}

interface Run {
  code: number
  out: string
  err: string
}

async function spawn(argv: string[], cwd: string, sandbox: Sandbox): Promise<Run> {
  const child = Bun.spawn(argv, { cwd, env: { ...sandbox.env, ...IDENTITY }, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { code, out, err }
}

/** A sandbox holding the `times` checkout wt knows by its manifest, with a git history, and every wt path at its default under the sandbox's HOME. */
async function timesSandbox() {
  const sandbox = makeSandbox()
  const workspace = join(sandbox.home, 'Workspace')
  const root = join(workspace, 'times')
  const manifests = join(sandbox.home, '.config', 'wt', 'projects')

  mkdirSync(manifests, { recursive: true })
  writeFileSync(join(manifests, 'times.ts'), `export default ${JSON.stringify(MANIFEST)}\n`)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'compose.yml'), 'services: {}\n')
  writeFileSync(join(root, '.gitignore'), '.env*\n.nuxtrc\n.docker/\napi/config/jwt\n')
  writeFileSync(join(root, '.env'), 'APP_HOST=times.localhost\n')

  for (const file of ['api/.env.local', 'api/config/jwt/private.pem', 'client/.env', 'client/.nuxtrc', '.docker/nginx/certs/main.pem']) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), 'x')
  }

  await $`git init -q -b main && git add -A && git commit -q -m init`.cwd(root).env({ ...sandbox.env, ...IDENTITY })

  sandbox.seed('config.json', JSON.stringify(MAIN_CONFIG))
  sandbox.seed('config-planning.json', JSON.stringify(WORKTREE_CONFIG))
  sandbox.seed('config-other.json', JSON.stringify({ ...WORKTREE_CONFIG, name: 'times--other' }))

  return {
    sandbox,
    root,
    wt: async (...args: string[]) => spawn([process.execPath, '--no-env-file', CLI, ...args], root, sandbox),
    git: async (cwd: string, ...args: string[]) => (await $`git -C ${cwd} ${args}`.env({ ...sandbox.env, ...IDENTITY }).quiet().text()).trim(),
    dirOf: (task: string) => join(workspace, '.worktrees', 'times', task),
    override: (id: string) => join(sandbox.home, '.local', 'share', 'wt', 'overrides', `${id}.override.yml`),
    stop: () => sandbox.remove(),
  }
}

describe('addTask', () => {
  let env: Awaited<ReturnType<typeof timesSandbox>>

  beforeEach(async () => {
    env?.stop()
    env = await timesSandbox()
    env.sandbox.seed('running', 'main-db\nmain-web\n')
    env.sandbox.seed('volumes', 'times_mailpit\n')
  })

  afterAll(() => env?.stop())

  test('checks the worktree out on wt/<task> and writes its env, override with the proxy labels, and certificates', async () => {
    const { sandbox, wt, git, dirOf, override } = env
    const run = await wt('add', 'planning')

    expect(run.err).toBe('')
    expect(run.code).toBe(0)
    expect(run.out).toContain(`wt: created ${dirOf('planning')} on wt/planning`)
    expect(run.out).toContain('https://planning.times.localhost')
    expect(run.out).toContain('wt up planning')
    expect(await git(dirOf('planning'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('wt/planning')

    const dotenv = readFileSync(join(dirOf('planning'), '.env'), 'utf8')

    expect(dotenv).toContain('APP_HOST=planning.times.localhost')
    expect(dotenv).toContain('COMPOSE_PROJECT_NAME=times--planning')
    expect(dotenv).toContain(`COMPOSE_FILE=compose.yml:${override('times--planning')}`)

    const rendered = readFileSync(override('times--planning'), 'utf8')

    expect(rendered).toContain('"mailhog":')
    expect(rendered).toContain('container_name: !reset null')
    expect(rendered).toContain('ports: !reset []')

    expect(rendered).toContain('"devproxy.wt0.host": "planning.times.localhost"')
    expect(existsSync(join(dirOf('planning'), '.docker', 'nginx', 'certs', 'planning.times.localhost.pem'))).toBe(true)
    expect(sandbox.forbidden()).toEqual([])
  })

  test('reads main and the worktree through compose with the worktree\'s own project name, and the tidy env after', async () => {
    const { sandbox, wt, root, dirOf } = env

    await wt('add', 'planning')

    const configs = sandbox.dockerCalls().filter(call => call.args === 'compose config --format json')

    expect(configs.map(call => call.cwd)).toEqual([root, dirOf('planning'), dirOf('planning')])
    expect(configs[0]).toMatchObject({ composeFile: '', composeProject: '' })
    expect(configs[1]).toMatchObject({ composeFile: 'compose.yml', composeProject: 'times--planning' })
    expect(configs[2]).toMatchObject({ composeFile: '', composeProject: '' })
  })

  test('clones main\'s volume into the worktree\'s while main\'s containers are paused, and unpauses them', async () => {
    const { sandbox, wt } = env

    await wt('add', 'planning')

    const calls = sandbox.dockerCalls()
    const created = calls.find(call => call.args.startsWith('volume create'))
    const copy = calls.find(call => call.args.startsWith('run --rm'))

    expect(created?.args).toContain('com.docker.compose.project=times--planning')
    expect(created?.args).toEndWith('times--planning_mailpit')
    expect(copy?.args).toContain('times_mailpit:/from:ro')
    expect(copy?.args).toContain('times--planning_mailpit:/to')
    expect(copy?.paused).toEqual(['main-db', 'main-web'])
    expect(calls.find(call => call.args === 'unpause main-db main-web')).toBeDefined()
    expect(sandbox.read('paused')).toBe('')
    expect(sandbox.read('volumes')).toContain('times--planning_mailpit')
  })

  test('puts the worktree on the branch it is given', async () => {
    const { wt, git, dirOf } = env

    expect((await wt('add', 'planning', 'feature/x')).code).toBe(0)
    expect(await git(dirOf('planning'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/x')
  })

  test('refuses a task whose folder exists already, and a worktree whose compose files do not read, naming the way out', async () => {
    const { sandbox, wt, dirOf } = env

    expect((await wt('add', 'planning')).code).toBe(0)

    const again = await wt('add', 'planning')

    expect(again.code).toBe(1)
    expect(again.err).toContain(`${dirOf('planning')} already exists`)

    sandbox.seed('config-fails-other', '')

    const broken = await wt('add', 'other')

    expect(broken.code).toBe(1)
    expect(broken.err).toContain('the worktree is checked out but not ready: `wt sync other -p times` resumes it')
    expect(existsSync(dirOf('other'))).toBe(true)
  })
})

describe('removeTask', () => {
  let env: Awaited<ReturnType<typeof timesSandbox>>

  beforeEach(async () => {
    env?.stop()
    env = await timesSandbox()
    env.sandbox.seed('volumes', 'times_mailpit\n')
    expect((await env.wt('add', 'planning')).code).toBe(0)
  })

  afterAll(() => env?.stop())

  function removals(): string[] {
    return env.sandbox.dockerCalls().map(call => call.args).filter(args => args.startsWith('volume rm') || args.includes('down'))
  }

  test('refuses uncommitted changes, and removes nothing', async () => {
    const { wt, dirOf, override } = env

    writeFileSync(join(dirOf('planning'), 'notes.txt'), 'wip')

    const run = await wt('rm', 'planning')

    expect(run.code).toBe(1)
    expect(run.err).toContain('uncommitted changes in root, commit them or pass --force')
    expect(existsSync(dirOf('planning'))).toBe(true)
    expect(existsSync(override('times--planning'))).toBe(true)
    expect(removals()).toEqual([])
  })

  test('refuses commits on no branch, which removing would lose', async () => {
    const { wt, git, dirOf } = env

    await git(dirOf('planning'), 'switch', '-q', '--detach')
    await git(dirOf('planning'), 'commit', '-q', '--allow-empty', '-m', 'lost')

    const run = await wt('rm', 'planning')

    expect(run.code).toBe(1)
    expect(run.err).toContain('commits on no branch in root (1 commit) would be lost')
    expect(existsSync(dirOf('planning'))).toBe(true)
    expect(removals()).toEqual([])
  })

  test('stops the stack, then removes the worktree, its own volumes, files and routes, and keeps its branch', async () => {
    const { sandbox, wt, git, root, dirOf, override } = env

    sandbox.seed('containers', 'c1\n')
    sandbox.seed('mounts', `${HEX_VOLUME} times--planning_named \n`)
    sandbox.seed('volumes', 'times--planning_mailpit\ntimes--planning_data\ntimes_mailpit\nfixed_name_volume\n')

    const run = await wt('rm', 'planning')

    expect(run.err).toBe('')
    expect(run.code).toBe(0)
    expect(run.out).toContain('wt: removed times--planning, its branches are kept')

    const calls = sandbox.dockerCalls().map(call => `${call.cwd} ${call.args}`)
    const listed = calls.findIndex(call => call.includes('ps -aq --filter label=com.docker.compose.project=times--planning'))
    const down = calls.findIndex(call => call === `${dirOf('planning')} compose down --remove-orphans`)

    // The anonymous volumes are read before the containers go, as nothing ties them to the worktree afterwards
    expect(listed).toBeGreaterThanOrEqual(0)
    expect(down).toBeGreaterThan(listed)
    expect(sandbox.read('volumes').split('\n').filter(Boolean)).toEqual(['times_mailpit', 'fixed_name_volume'])
    expect(sandbox.dockerCalls().find(call => call.args.startsWith('volume rm'))?.args).toBe(`volume rm times--planning_mailpit times--planning_data ${HEX_VOLUME}`)

    expect(existsSync(dirOf('planning'))).toBe(false)
    expect(existsSync(override('times--planning'))).toBe(false)

    expect(await git(root, 'branch', '--list', 'wt/planning')).toContain('wt/planning')
    expect(await git(root, 'worktree', 'list')).not.toContain('planning')
    expect(sandbox.forbidden()).toEqual([])
  })

  test('removes it all with --force whatever the worktree holds', async () => {
    const { wt, git, dirOf } = env

    writeFileSync(join(dirOf('planning'), 'notes.txt'), 'wip')
    await git(dirOf('planning'), 'switch', '-q', '--detach')
    await git(dirOf('planning'), 'commit', '-q', '--allow-empty', '-m', 'lost')

    const run = await wt('rm', 'planning', '--force')

    expect(run.code).toBe(0)
    expect(existsSync(dirOf('planning'))).toBe(false)
  })

  test('leaves the files in place when its volumes cannot be removed', async () => {
    const { sandbox, wt, dirOf, override } = env

    sandbox.seed('volumes', 'times--planning_mailpit\n')
    sandbox.seed('volume-rm-fails', '')

    const run = await wt('rm', 'planning')

    expect(run.code).toBe(1)
    expect(run.err).toContain('could not remove the volumes of times--planning')
    expect(run.err).toContain('volume is in use')
    expect(existsSync(override('times--planning'))).toBe(true)
    expect(existsSync(dirOf('planning'))).toBe(true)
  })

  test('finishes a worktree whose folder is gone, without stopping a stack there is none of', async () => {
    const { sandbox, wt, git, root, dirOf, override } = env

    await $`rm -rf ${dirOf('planning')}`.quiet()

    const run = await wt('rm', 'planning')

    expect(run.code).toBe(0)
    expect(removals().filter(args => args.includes('down'))).toEqual([])
    expect(existsSync(override('times--planning'))).toBe(false)
    expect(await git(root, 'worktree', 'list')).not.toContain('planning')
    expect(sandbox.forbidden()).toEqual([])
  })

  test('stops the containers a worktree whose folder is gone left, by their compose project, before its volumes go', async () => {
    const { sandbox, wt, dirOf } = env

    await $`rm -rf ${dirOf('planning')}`.quiet()
    sandbox.seed('containers', 'abc123\n')

    const run = await wt('rm', 'planning')

    expect(run.code).toBe(0)
    expect(removals()[0]).toBe('compose -p times--planning down --remove-orphans')
    expect(removals().slice(1).every(args => args.startsWith('volume rm'))).toBe(true)
    expect(sandbox.forbidden()).toEqual([])
  })

  test('says so when there is nothing under that name', async () => {
    const run = await env.wt('rm', 'nothing')

    expect(run.code).toBe(1)
    expect(run.err).toContain('no worktree nothing of times, nothing removed')
    expect(existsSync(join(env.sandbox.home, '.cache', 'wt', 'jobs', 'times--nothing.json'))).toBe(false)
  })
})

describe('commands checking their target before any job', () => {
  let env: Awaited<ReturnType<typeof timesSandbox>>

  beforeEach(async () => {
    env?.stop()
    env = await timesSandbox()
  })

  afterAll(() => env?.stop())

  test('refuse two projects whose checkout folders compose names alike, as their worktrees would share stacks', async () => {
    writeFileSync(join(env.sandbox.home, '.config', 'wt', 'projects', 'other.ts'), `export default ${JSON.stringify({ ...MANIFEST, root: '~/Elsewhere/Times.' })}\n`)

    const run = await env.wt('up', 'planning')

    expect(run.code).toBe(1)
    expect(run.err).toContain('other.ts and times.ts both have a checkout compose names times')
  })

  test('refuse a checkout folder that leaves compose no stack name', async () => {
    writeFileSync(join(env.sandbox.home, '.config', 'wt', 'projects', 'other.ts'), `export default ${JSON.stringify({ ...MANIFEST, root: '~/Elsewhere/__' })}\n`)

    const run = await env.wt('up', 'planning')

    expect(run.code).toBe(1)
    expect(run.err).toContain('other.ts: the checkout folder __ holds no letter or digit')
  })

  test.each([
    [['up', 'nothing'], 'no worktree nothing'],
    [['down', 'nothing'], 'no worktree nothing'],
    [['sync', 'nothing'], 'no worktree nothing'],
    [['add', 'Bad_Name'], 'invalid task name "Bad_Name"'],
  ])('%p fails before claiming a job, leaving no job record', async (args, message) => {
    const jobs = join(env.sandbox.home, '.cache', 'wt', 'jobs')
    const run = await env.wt(...args)

    expect(run.code).toBe(1)
    expect(run.err).toContain(message)
    expect((existsSync(jobs) ? readdirSync(jobs) : []).filter(file => file.startsWith(`times--${args[1]}.`))).toEqual([])
  })

  test('notify a --bg refusal, as its caller may be a popup that closed meanwhile', async () => {
    const run = await env.wt('up', 'nothing', '--bg')
    const notified = env.sandbox.calls().filter(call => call.startsWith('notify-send'))

    expect(run.code).toBe(1)
    expect(notified).toHaveLength(1)
    expect(notified[0]).toContain('wt up nothing not started')
    expect(notified[0]).toContain('no worktree nothing')
  })
})

describe('whilePaused', () => {
  let sandbox: Sandbox

  beforeEach(() => {
    sandbox?.remove()
    sandbox = makeSandbox()
  })

  afterAll(() => sandbox?.remove())

  test('pauses the containers around the work and unpauses them when it fails', async () => {
    const run = await spawn([process.execPath, DRIVER, 'paused-error', 'main-db,main-web'], sandbox.home, sandbox)

    expect(run.out.trim()).toBe('copy failed')
    expect(sandbox.dockerCalls().map(call => call.args)).toEqual(['pause main-db main-web', 'unpause main-db main-web'])
    expect(sandbox.read('paused')).toBe('')
  })

  test('keeps the ids it paused in the record while the work runs, and removes it once they are unpaused', async () => {
    const record = join(sandbox.home, '.cache', 'wt', 'queues', 'times.paused')
    const run = await spawn([process.execPath, DRIVER, 'paused-record', record], sandbox.home, sandbox)

    expect(run.out.trim()).toBe('main-db,main-web')
    expect(existsSync(record)).toBe(false)
  })

  test('runs the docker commands only for containers there are', async () => {
    await spawn([process.execPath, DRIVER, 'paused-error', ''], sandbox.home, sandbox)

    expect(sandbox.dockerCalls()).toEqual([])
  })

  test.each(['SIGTERM', 'SIGINT', 'SIGHUP'])('aborts the copies, unpauses main and exits on %s', async (signal) => {
    const run = await spawn([process.execPath, DRIVER, 'paused-signal', signal], sandbox.home, sandbox)

    expect(run.out.trim()).toBe('aborted')
    expect(run.code).toBe(128 + { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[signal])
    expect(sandbox.dockerCalls().map(call => call.args)).toEqual(['pause main-db main-web', 'unpause main-db main-web'])
    expect(sandbox.read('paused')).toBe('')
  })
})

describe('cloneData', () => {
  let sandbox: Sandbox
  let root: string

  const project = (clone: string[]) => ({ name: 'times', root, repos: [], clone, routes: [] })
  const main = { name: 'times', services: {}, volumes: { mailpit: {}, shared: { name: 'fixed_shared' }, bound: { driver_opts: { device: '/srv/data' } } } }

  async function clone(entries: string[]): Promise<{ warnings?: string[], error?: string, code: number }> {
    const run = await spawn([process.execPath, DRIVER, 'clone', JSON.stringify({ project: project(entries), task: 'planning', main })], sandbox.home, sandbox)
    const parsed = JSON.parse(run.out.trim().split('\n').at(-1)!) as string[] | { error: string }

    return Array.isArray(parsed) ? { warnings: parsed, code: run.code } : { error: parsed.error, code: run.code }
  }

  const pending = () => join(sandbox.home, '.cache', 'wt', 'times--planning.clones-pending')

  beforeEach(() => {
    sandbox?.remove()
    sandbox = makeSandbox()
    root = join(sandbox.home, 'Workspace', 'times')
    mkdirSync(root, { recursive: true })
  })

  afterAll(() => sandbox?.remove())

  test('unpauses the main containers a clone cut short left paused, and says so, leaving one paused by hand', async () => {
    const record = join(sandbox.home, '.cache', 'wt', 'queues', 'times.paused')

    sandbox.seed('paused', 'left-1\nleft-2\nby-hand\n')
    mkdirSync(dirname(record), { recursive: true })
    writeFileSync(record, 'left-1\nleft-2\n')

    const { warnings } = await clone(['mailpit'])

    expect(warnings).toEqual(['clone: unpaused 2 of main\'s containers a clone cut short had left paused', 'clone: main has no volume times_mailpit yet, the worktree starts with an empty one'])
    expect(sandbox.dockerCalls().map(call => call.args)).toContain('unpause left-1 left-2')
    expect(sandbox.read('paused')).toBe('by-hand\n')
    expect(existsSync(record)).toBe(false)
  })

  test('copies a volume of main\'s with main paused, and records nothing pending once whole', async () => {
    sandbox.seed('volumes', 'times_mailpit\nfixed_shared\n')
    sandbox.seed('running', 'main-db\n')

    const { warnings } = await clone(['mailpit', 'shared'])

    expect(warnings).toEqual([])

    const copies = sandbox.dockerCalls().filter(call => call.args.startsWith('run --rm'))

    // The copies run side by side, so their order is not fixed
    expect(copies.map(call => call.args.match(/-v (\S+):\/from:ro/)?.[1]).sort()).toEqual(['fixed_shared', 'times_mailpit'])
    expect(copies.every(call => call.paused.join() === 'main-db')).toBe(true)
    expect(sandbox.read('volumes')).toContain('times--planning_shared')
    expect(existsSync(pending())).toBe(false)
    expect(sandbox.read('paused')).toBe('')
  })

  test('skips a target that exists already, copying nothing and pausing nothing', async () => {
    sandbox.seed('volumes', 'times_mailpit\ntimes--planning_mailpit\n')
    sandbox.seed('running', 'main-db\n')

    expect((await clone(['mailpit'])).warnings).toEqual([])
    expect(sandbox.dockerCalls().filter(call => (/^(?:pause|run|volume (?:create|rm))/).test(call.args))).toEqual([])
  })

  test('keeps a failed copy pending, unpausing main, and redoes it from an empty volume the next time', async () => {
    sandbox.seed('volumes', 'times_mailpit\n')
    sandbox.seed('running', 'main-db\n')
    sandbox.seed('run-fails', '')

    const failed = await clone(['mailpit'])

    expect(failed.code).toBe(1)
    expect(failed.error).toContain('clone failed, `wt sync planning` starts it again')
    expect(failed.error).toContain('no space left on device')
    expect(readFileSync(pending(), 'utf8')).toBe('times--planning_mailpit\n')
    expect(sandbox.read('paused')).toBe('')
    expect(sandbox.read('volumes')).toContain('times--planning_mailpit')

    rmSync(join(sandbox.state, 'run-fails'))

    const before = sandbox.dockerCalls().length
    const redone = await clone(['mailpit'])
    const calls = sandbox.dockerCalls().slice(before).map(call => call.args)

    expect(redone.warnings).toEqual([])
    expect(calls.findIndex(args => args === 'volume rm times--planning_mailpit')).toBeGreaterThanOrEqual(0)
    expect(calls.findIndex(args => args.startsWith('volume create'))).toBeGreaterThan(calls.indexOf('volume rm times--planning_mailpit'))
    expect(existsSync(pending())).toBe(false)
  })

  test('copies a path of main\'s through a container as root, under a partial name renamed once whole', async () => {
    mkdirSync(join(root, 'data'))

    await clone(['data'])

    const copy = sandbox.dockerCalls().find(call => call.args.startsWith('run --rm'))

    expect(copy?.args).toContain(`${join(root, 'data')}:/from:ro`)
    expect(copy?.args).toContain('cp -a /from/. \'/to/data.wt-partial/\' && mv \'/to/data.wt-partial\' \'/to/data\'')
  })

  test('warns about an entry that is neither a path nor a volume, and refuses a volume that is a bind', async () => {
    expect((await clone(['nothing'])).warnings).toEqual(['clone: nothing is neither a path in main nor a volume of its stack'])
    expect((await clone(['bound'])).error).toBe('clone: volume bound is a bind to /srv/data, list that path instead')
  })
})

describe('forgetTestDatabases', () => {
  let sandbox: Sandbox
  let root: string

  const markers = () => join(sandbox.home, '.cache', 'wt')
  const project = () => ({ name: 'times', root, repos: [], routes: [] })

  async function forget(task: string) {
    return spawn([process.execPath, DRIVER, 'forget', JSON.stringify({ project: project(), task })], sandbox.home, sandbox)
  }

  beforeEach(() => {
    sandbox?.remove()
    sandbox = makeSandbox()
    root = join(sandbox.home, 'Workspace', 'times')
    mkdirSync(markers(), { recursive: true })

    for (const marker of ['times--zz-forget.test-aaa', 'times--zz-forget.test-bbb', 'times--zz-forget.setup', 'times--other.test-aaa'])
      writeFileSync(join(markers(), marker), '')
  })

  afterAll(() => sandbox?.remove())

  test('drops the databases ending in the worktree\'s token from the project\'s test server, and its provisioning markers, and nothing else', async () => {
    sandbox.seed('test-db-id', 'abc123\n')
    sandbox.seed('databases', 'postgres\napp_test\napp_testzz_forget\nbilling_testzz_forget\napp_testother\napp_testforget\n')

    const run = await forget('zz-forget')

    expect(run.code).toBe(0)
    expect(sandbox.read('databases')).toBe('postgres\napp_test\napp_testother\napp_testforget\n')

    const drops = sandbox.dockerCalls().filter(call => call.args.includes('dropdb'))

    expect(drops.map(call => call.args.split(' ').at(-1)).sort()).toEqual(['app_testzz_forget', 'billing_testzz_forget'])
    expect(drops.every(call => call.args.startsWith('exec wt-times-test-db '))).toBe(true)
    expect(readdirSync(markers()).filter(name => name.endsWith('.test-aaa') || name.endsWith('.test-bbb') || name.endsWith('.setup')).sort()).toEqual(['times--other.test-aaa', 'times--zz-forget.setup'])
    expect(sandbox.forbidden()).toEqual([])
  })

  test('only removes the markers when the test server is not running', async () => {
    sandbox.seed('databases', 'app_testzz_forget\n')

    await forget('zz-forget')

    expect(sandbox.dockerCalls().some(call => call.args.startsWith('exec'))).toBe(false)
    expect(sandbox.read('databases')).toBe('app_testzz_forget\n')
    expect(existsSync(join(markers(), 'times--zz-forget.test-aaa'))).toBe(false)
    expect(existsSync(join(markers(), 'times--other.test-aaa'))).toBe(true)
  })
})

describe('writeStackCerts', () => {
  let sandbox: Sandbox

  const task = 'zzroutes'
  const workspace = () => join(sandbox.home, 'Workspace')
  const dir = () => join(workspace(), '.worktrees', 'times', task, '.docker', 'certs')
  const name = `${task}.times.localhost`
  const project = { name: 'times', repos: [], certs: '.docker/certs', routes: [{ host: 'times.localhost', to: 'api-nginx:443', passthrough: true }] }
  const certs = async () => spawn([process.execPath, DRIVER, 'stack-certs', JSON.stringify({ project: { ...project, root: join(workspace(), 'times') }, task })], sandbox.home, sandbox)
  const mkcerts = () => sandbox.calls().filter(call => call.startsWith('mkcert'))

  beforeEach(() => {
    sandbox?.remove()
    sandbox = makeSandbox()
    mkdirSync(dir(), { recursive: true })
    writeFileSync(join(dir(), `${name}.pem`), 'cert')
    writeFileSync(join(dir(), `${name}-key.pem`), 'key')
  })

  afterAll(() => sandbox?.remove())

  test('keeps a host\'s pair of the stack\'s own nginx when whole', async () => {
    expect((await certs()).code).toBe(0)
    expect(mkcerts()).toEqual([])
  })

  test.each([['the key', '-key'], ['the certificate', '']])('issues the pair again when %s alone is gone', async (_, gone) => {
    rmSync(join(dir(), `${name}${gone}.pem`))

    expect((await certs()).code).toBe(0)
    expect(mkcerts()).toHaveLength(1)
    expect(mkcerts()[0]).toContain(`-cert-file ${join(dir(), `${name}.pem`)} -key-file ${join(dir(), `${name}-key.pem`)} ${name}`)
    expect(readFileSync(join(dir(), `${name}.pem`), 'utf8')).toBe('cert\n')
    expect(readFileSync(join(dir(), `${name}-key.pem`), 'utf8')).toBe('key\n')
  })
})

describe('cloneData of two worktrees of one project', () => {
  let sandbox: Sandbox
  let root: string

  const clone = async (task: string) => spawn([process.execPath, DRIVER, 'clone', JSON.stringify({ project: { name: 'times', root, repos: [], clone: ['mailpit'], routes: [] }, task, main: { name: 'times', services: {}, volumes: { mailpit: {} } } })], sandbox.home, sandbox)

  beforeEach(() => {
    sandbox?.remove()
    sandbox = makeSandbox()
    root = join(sandbox.home, 'Workspace', 'times')
    mkdirSync(root, { recursive: true })
    sandbox.seed('volumes', 'times_mailpit\n')
    sandbox.seed('running', 'main-db\n')
    sandbox.seed('delay-run', '1.5')
  })

  afterAll(() => sandbox?.remove())

  test('never has main paused by one while the other copies: the pause and unpause pairs do not interleave', async () => {
    const first = clone('zzclonea')

    // The pause call is logged before the fake docker writes its state, so the state itself is what is waited for.
    for (let tries = 0; tries < 200 && sandbox.read('paused') !== 'main-db\n'; tries++)
      await Bun.sleep(50)

    // The first is mid-copy, main paused
    expect(sandbox.read('paused')).toBe('main-db\n')

    const second = clone('zzcloneb')
    const [one, two] = await Promise.all([first, second])

    expect(one.code).toBe(0)
    expect(two.code).toBe(0)
    expect(two.err).toContain('wt: times\'s main is busy cloning zzclonea, waiting')

    const pauses = sandbox.dockerCalls().filter(call => (/^(?:pause|unpause) /).test(call.args))

    expect(pauses.map(call => call.args)).toEqual(['pause main-db', 'unpause main-db', 'pause main-db', 'unpause main-db'])
    // Each pause found main running, so none was cut across the other's copy
    expect(pauses.filter(call => call.args.startsWith('pause ')).map(call => call.paused)).toEqual([[], []])

    const copies = sandbox.dockerCalls().filter(call => call.args.startsWith('run --rm'))

    expect(copies).toHaveLength(2)
    expect(copies.every(call => call.paused.join() === 'main-db')).toBe(true)
    expect(sandbox.read('volumes')).toContain('times--zzclonea_mailpit')
    expect(sandbox.read('volumes')).toContain('times--zzcloneb_mailpit')
    expect(sandbox.read('paused')).toBe('')
  }, 30_000)
})

describe('wt sync as a job', () => {
  let env: Awaited<ReturnType<typeof timesSandbox>>

  beforeEach(async () => {
    env?.stop()
    env = await timesSandbox()
    env.sandbox.seed('config-zzsync.json', JSON.stringify({ ...MAIN_CONFIG, name: 'times--zzsync' }))
  })

  afterAll(() => env?.stop())

  test('holds the worktree stack\'s lock while it runs, so a second sync is refused, and records how it ended', async () => {
    const { sandbox, wt } = env
    const jobs = join(sandbox.home, '.cache', 'wt', 'jobs')

    expect((await wt('add', 'zzsync')).code).toBe(0)
    expect(JSON.parse(readFileSync(join(jobs, 'times--zzsync.json'), 'utf8'))).toMatchObject({ ref: 'times/zzsync', verb: 'add', code: 0 })
    sandbox.seed('delay-config', '0.7')

    const first = wt('sync', 'zzsync')

    for (let tries = 0; tries < 100 && !existsSync(join(jobs, 'times--zzsync.lock')); tries++)
      await Bun.sleep(100)

    expect(existsSync(join(jobs, 'times--zzsync.lock'))).toBe(true)

    const refused = await wt('sync', 'zzsync')

    expect(refused.code).toBe(1)
    expect(refused.err).toContain('times/zzsync is already syncing')
    expect(refused.out).toBe('')

    const done = await first

    expect(done.code).toBe(0)
    expect(existsSync(join(jobs, 'times--zzsync.lock'))).toBe(false)
    expect(JSON.parse(readFileSync(join(jobs, 'times--zzsync.json'), 'utf8'))).toMatchObject({ ref: 'times/zzsync', verb: 'sync', code: 0 })

    expect(sandbox.forbidden()).toEqual([])
  }, 30_000)

  test('is refused while any action holds the stack, naming it', async () => {
    const { sandbox, wt } = env
    const jobs = join(sandbox.home, '.cache', 'wt', 'jobs')

    mkdirSync(env.dirOf('zzsync'), { recursive: true })
    mkdirSync(jobs, { recursive: true })
    writeFileSync(join(jobs, 'times--zzsync.lock'), String(process.pid))
    writeFileSync(join(jobs, 'times--zzsync.json'), JSON.stringify({ ref: 'times/zzsync', verb: 'up', pid: process.pid, startedAt: Date.now(), log: '' }))

    const refused = await wt('sync', 'zzsync')

    expect(refused.code).toBe(1)
    expect(refused.err).toContain('times/zzsync is already coming up')
    expect(sandbox.dockerCalls()).toEqual([])
  })
})

describe('a config runner', () => {
  let env: Awaited<ReturnType<typeof timesSandbox>>

  // Logs what it was asked and the locks it runs under; as `down`, it brings the stack up again through wt, as a runner calling back into wt would.
  function writeRunner(): string {
    const script = join(env.sandbox.state, 'runner')

    writeFileSync(script, `#!/bin/sh
echo "runner $* held=$WT_JOBS_HELD" >> "$FAKE_DIR/calls.log"
[ "$1" = down ] && exec "${process.execPath}" --no-env-file "${CLI}" up "$3"
exit 0
`, { mode: 0o755 })

    return script
  }

  beforeEach(async () => {
    env?.stop()
    env = await timesSandbox()

    const runner = writeRunner()
    const config = { runner: { up: [runner, 'up', '{project}/{task}'], down: [runner, 'down', '{project}/{task}', '{task}'], removed: [runner, 'removed', '{id}'] } }

    writeFileSync(join(env.sandbox.home, '.config', 'wt', 'config.ts'), `export default ${JSON.stringify(config)}\n`)
  })

  afterAll(() => env?.stop())

  test('runs the config\'s commands in place of compose, and a wt command they run works inside the job holding the stack', async () => {
    const { sandbox, wt } = env
    const lock = join(sandbox.home, '.cache', 'wt', 'jobs', 'times--planning.lock')

    expect((await wt('add', 'planning')).code).toBe(0)
    expect((await wt('up', 'planning')).code).toBe(0)

    const run = await wt('rm', 'planning')

    expect(run.err).toBe('')
    expect(run.code).toBe(0)
    // Each entry names its holder's pid, which differs between the up and the rm
    expect(sandbox.calls().filter(call => call.startsWith('runner')).map(call => call.replace(/held=\d+ /, 'held='))).toEqual([
      `runner up times/planning held=${lock}`,
      `runner down times/planning planning held=${lock}`,
      `runner up times/planning held=${lock}`,
      `runner removed times--planning held=${lock}`,
    ])
    expect(sandbox.dockerCalls().filter(call => call.args.startsWith('compose up') || call.args.startsWith('compose down'))).toEqual([])
    expect(sandbox.forbidden()).toEqual([])
  }, 30_000)
})

describe('a config runner naming no executable', () => {
  let env: Awaited<ReturnType<typeof timesSandbox>>

  beforeEach(async () => {
    env?.stop()
    env = await timesSandbox()
    writeFileSync(join(env.sandbox.home, '.config', 'wt', 'config.ts'), `export default ${JSON.stringify({ runner: { up: ['no-such-runner', 'up'] } })}\n`)
  })

  afterAll(() => env?.stop())

  test('fails naming the command and the config, with no stack trace', async () => {
    const { wt } = env

    expect((await wt('add', 'planning')).code).toBe(0)

    const run = await wt('up', 'planning')

    expect(run.code).toBe(1)
    expect(run.err).toBe(`error: \`no-such-runner\` is not on PATH: fix runner.up in ${join(env.sandbox.home, '.config', 'wt', 'config.ts')}\n`)
  }, 30_000)
})

describe('wt run', () => {
  let env: Awaited<ReturnType<typeof timesSandbox>>

  beforeEach(async () => {
    env?.stop()
    env = await timesSandbox()
  })

  afterAll(() => env?.stop())

  test('a repeat on an unchanged stack makes one docker call before the command', async () => {
    const { sandbox, wt, dirOf, root } = env
    const manifest = join(sandbox.home, '.config', 'wt', 'projects', 'times.ts')

    writeFileSync(manifest, `export default ${JSON.stringify({ ...MANIFEST, run: { service: 'api-php', dir: 'api', provision: ['true'] } })}\n`)
    expect((await wt('add', 'planning')).code).toBe(0)
    writeFileSync(join(dirOf('planning'), 'api', '.env.dist'), 'DATABASE_URL=postgresql://app:pw@db:5432/app\n')
    sandbox.seed('config-times.json', JSON.stringify({ ...MAIN_CONFIG, services: { ...MAIN_CONFIG.services, 'api-php': { volumes: [{ type: 'bind', source: join(root, 'api'), target: '/app' }] }, 'db': { image: 'postgres:16' } } }))
    sandbox.seed('test-db-id', 'abcdef1234567890')

    const commands = () => sandbox.dockerCalls().map(call => call.args).filter(args => !args.startsWith('run --rm') || args.endsWith(' check'))

    const added = commands().length

    expect((await wt('run', 'planning', '--', 'check')).code).toBe(0)

    const first = commands()

    expect(first.slice(added).filter(args => args.startsWith('compose config'))).toHaveLength(1)
    expect((await wt('run', 'planning', '--', 'check')).code).toBe(0)
    expect(commands().slice(first.length).map(args => args.split(' ').slice(0, 2).join(' '))).toEqual(['exec wt-times-test-db', 'run --rm'])
  }, 30_000)
})

describe('a wt config that does not load', () => {
  let env: Awaited<ReturnType<typeof timesSandbox>>

  beforeEach(async () => {
    env?.stop()
    env = await timesSandbox()
    writeFileSync(join(env.sandbox.home, '.config', 'wt', 'config.ts'), 'export default {\n')
  })

  afterAll(() => env?.stop())

  test('notifies a --bg command it refuses, like any other refusal', async () => {
    const run = await env.wt('up', 'planning', '--bg')
    const notified = env.sandbox.calls().filter(call => call.startsWith('notify-send'))

    expect(run.code).toBe(1)
    expect(run.err).toContain('config.ts does not load')
    expect(notified).toHaveLength(1)
    expect(notified[0]).toContain('wt up planning not started')
    expect(notified[0]).toContain('config.ts does not load')
  })
})

describe('up and down with no runner', () => {
  let env: Awaited<ReturnType<typeof timesSandbox>>

  beforeEach(async () => {
    env?.stop()
    env = await timesSandbox()
    writeFileSync(join(env.sandbox.home, '.config', 'wt', 'projects', 'times.ts'), `export default ${JSON.stringify({ ...MANIFEST, setup: ['echo ran >> setup.log'] })}\n`)
  })

  afterAll(() => env?.stop())

  test('bring the proxy up, then compose up in the worktree and its setup once; down is compose down there', async () => {
    const { sandbox, wt, dirOf } = env

    expect((await wt('add', 'planning')).code).toBe(0)
    expect((await wt('up', 'planning')).code).toBe(0)
    expect((await wt('up', 'planning')).code).toBe(0)
    expect((await wt('down', 'planning')).code).toBe(0)

    const stack = sandbox.dockerCalls().filter(call => call.args.startsWith('compose up') || call.args.startsWith('compose down'))

    expect(stack.map(call => `${call.cwd} ${call.args}`)).toEqual([
      `${dirOf('planning')} compose up -d --build`,
      `${dirOf('planning')} compose up -d --build`,
      `${dirOf('planning')} compose down --remove-orphans`,
    ])
    expect(sandbox.calls().filter(call => call.startsWith('devproxy'))).toEqual(['devproxy up', 'devproxy up'])
    expect(readFileSync(join(dirOf('planning'), 'setup.log'), 'utf8')).toBe('ran\n')
    expect(sandbox.forbidden()).toEqual([])
  }, 30_000)

  test('add --up starts the stack it made; up and down --all act on every worktree of the project in turn', async () => {
    const { sandbox, wt, dirOf } = env
    const stackCalls = () => sandbox.dockerCalls().filter(call => call.args.startsWith('compose up') || call.args.startsWith('compose down')).map(call => `${call.cwd} ${call.args}`)

    const added = await wt('add', 'planning', '--up')

    expect(added.code).toBe(0)
    expect(added.out).not.toContain('wt up planning')
    expect(stackCalls()).toEqual([`${dirOf('planning')} compose up -d --build`])

    expect((await wt('add', 'other')).code).toBe(0)
    expect((await wt('down', '--all')).code).toBe(0)
    expect((await wt('up', '--all')).code).toBe(0)
    expect(stackCalls().slice(1)).toEqual([
      `${dirOf('other')} compose down --remove-orphans`,
      `${dirOf('planning')} compose down --remove-orphans`,
      `${dirOf('other')} compose up -d --build`,
      `${dirOf('planning')} compose up -d --build`,
    ])

    // One that fails does not stop the others
    sandbox.seed('down-fails-other', '')

    const partly = await wt('down', '--all')

    expect(partly.code).toBe(1)
    expect(partly.err).toContain('down failed for other')
    expect(stackCalls().at(-1)).toBe(`${dirOf('planning')} compose down --remove-orphans`)

    const both = await wt('up', 'planning', '--all')

    expect(both.code).toBe(2)
    expect(both.err).toContain('wt up takes a task or --all, not both')
    expect(sandbox.forbidden()).toEqual([])
  }, 30_000)

  test('run up and rm with --bg as detached jobs, their output in the job log, a notification once up', async () => {
    const { sandbox, wt, dirOf } = env
    const jobs = join(sandbox.home, '.cache', 'wt', 'jobs')
    const job = join(jobs, 'times--planning.json')
    const lock = join(jobs, 'times--planning.lock')
    const settled = async (done: () => boolean) => {
      for (let tries = 0; tries < 100 && !done(); tries++)
        await Bun.sleep(100)
    }

    expect((await wt('add', 'planning')).code).toBe(0)

    const up = await wt('up', 'planning', '--bg')

    expect(up.code).toBe(0)
    expect(up.out).toContain(`wt: up times/planning runs out of sight, its output in ${join(jobs, 'times--planning.log')}`)
    // The job releases its lock before it notifies, so the wait is on both.
    await settled(() => !existsSync(lock) && sandbox.calls().some(call => call.startsWith('notify-send')))
    expect(JSON.parse(readFileSync(job, 'utf8'))).toMatchObject({ ref: 'times/planning', verb: 'up', code: 0 })
    expect(sandbox.dockerCalls().filter(call => call.args.startsWith('compose up')).map(call => call.cwd)).toEqual([dirOf('planning')])
    const notified = sandbox.calls().filter(call => call.startsWith('notify-send'))

    expect(notified).toHaveLength(1)
    expect(notified[0]).toContain('times/planning is up')

    // The setup's log left the tree dirty: refused before any job starts, rather than failing out of sight
    const refused = await wt('rm', 'planning', '--bg')

    expect(refused.code).toBe(1)
    expect(refused.err).toContain('uncommitted changes in root')
    expect(JSON.parse(readFileSync(job, 'utf8'))).toMatchObject({ verb: 'up' })

    expect((await wt('rm', 'planning', '--bg', '--force')).code).toBe(0)
    // The job releases its lock before the removal forgets its jobs, so the wait is on the job record.
    await settled(() => !existsSync(dirOf('planning')) && !existsSync(job))
    expect(existsSync(dirOf('planning'))).toBe(false)
    // A removal that worked forgets the worktree's jobs
    expect(existsSync(job)).toBe(false)
    expect(sandbox.dockerCalls().filter(call => call.args.startsWith('compose down'))).toHaveLength(1)
    expect(sandbox.forbidden()).toEqual([])
  }, 30_000)

  test('refuses, saying why, to start routed services on a proxy network nothing created', async () => {
    const { sandbox, wt } = env

    expect((await wt('add', 'planning')).code).toBe(0)
    rmSync(join(sandbox.home, '.config', 'devproxy', 'config.ts'))

    const run = await wt('up', 'planning')

    expect(run.code).toBe(1)
    expect(run.err).toContain('the routed services join the proxy network, which does not exist: install and configure devproxy, or set proxyNetwork in')
    expect(sandbox.dockerCalls().filter(call => call.args.startsWith('compose up'))).toEqual([])
  }, 30_000)
})

describe('wt init', () => {
  let env: Awaited<ReturnType<typeof timesSandbox>>

  beforeEach(async () => {
    env?.stop()
    env = await timesSandbox()
  })

  afterAll(() => env?.stop())

  test('drafts a manifest for a checkout no tool knows, named after its folder unless --name says otherwise', async () => {
    const { sandbox, wt, root } = env
    const printed = await wt('init', root, '--print', '--name', 'other')

    expect(printed.err).toBe('')
    expect(printed.code).toBe(0)
    expect(printed.out).toContain('import type { ProjectConfig } from \'@kaynooo/cli-wt\'')
    expect(printed.out).toContain('root: \'~/Workspace/times\'')
    expect(printed.out).toContain('} satisfies ProjectConfig')
    expect(existsSync(join(sandbox.home, '.config', 'wt', 'projects', 'other.ts'))).toBe(false)

    rmSync(join(sandbox.home, '.config', 'wt', 'projects'), { recursive: true })

    expect((await wt('init', root)).code).toBe(0)
    // The manifest's name is its file's, so the draft is the one printed, less the newline console.log adds
    expect(`${readFileSync(join(sandbox.home, '.config', 'wt', 'projects', 'times.ts'), 'utf8')}\n`).toBe(printed.out)
    expect(sandbox.forbidden()).toEqual([])
  }, 30_000)
})

describe('wt ls --json', () => {
  let env: Awaited<ReturnType<typeof timesSandbox>>

  beforeEach(async () => {
    env?.stop()
    env = await timesSandbox()
    env.sandbox.seed('volumes', 'times_mailpit\n')
  })

  afterAll(() => env?.stop())

  // The shape Herdr's Worktrees section parses
  test('lists main and each worktree of the project the directory is in, every key a reader relies on set', async () => {
    const { sandbox, wt, root, dirOf } = env

    expect((await wt('add', 'planning')).code).toBe(0)
    sandbox.seed('compose-ls.json', JSON.stringify([{ Name: 'times--planning', Status: 'running(2)' }]))

    const run = await wt('ls', '--json')

    expect(run.err).toBe('')
    expect(run.code).toBe(0)
    expect(JSON.parse(run.out)).toEqual({
      project: 'times',
      checkouts: [
        { project: 'times', task: 'main', dir: root, branch: 'main', url: 'https://times.localhost', running: false, dirty: 0, unbranched: 0, session: 'times' },
        { project: 'times', task: 'planning', dir: dirOf('planning'), branch: 'wt/planning', url: 'https://planning.times.localhost', running: true, dirty: 0, unbranched: 0, session: 'times--planning' },
      ],
    })
  }, 30_000)

  test('finds main running under the name compose gives a folder with capitals and dots', async () => {
    const { sandbox, wt } = env
    const caps = join(sandbox.home, 'Workspace', 'Caps.Dir')

    mkdirSync(caps)
    await $`git init -q -b main`.cwd(caps).env({ ...sandbox.env, ...IDENTITY })
    writeFileSync(join(sandbox.home, '.config', 'wt', 'projects', 'caps.ts'), `export default ${JSON.stringify({ ...MANIFEST, root: '~/Workspace/Caps.Dir' })}\n`)
    sandbox.seed('compose-ls.json', JSON.stringify([{ Name: 'capsdir', Status: 'running(1)' }]))

    const run = await wt('ls', '--json', '-p', 'caps')

    expect(run.code).toBe(0)
    expect((JSON.parse(run.out) as { checkouts: { task: string, running: boolean }[] }).checkouts).toMatchObject([{ task: 'main', running: true }])
  }, 30_000)
})
