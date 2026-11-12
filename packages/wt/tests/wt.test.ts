import type { ComposeConfig } from '../src/compose'
import type { Project, Route, Worktree } from '../src/project'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $ } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { overrideWarnings, proxyLabels, renderOverride } from '../src/compose'
import { resolveConfig } from '../src/config'
import { copyFromMain, expandEnvValue, rewriteHosts, setEnvValue, settle, whilePaused, writeEnvFiles } from '../src/files'
import { addWorktrees, currentBranch, isRegistered, unreachableCommits } from '../src/git'
import { changedFiles } from '../src/list'
import { worktreeHost, worktreeOf } from '../src/project'
import { inLine, liveTickets } from '../src/queue'
import { runPlan, testDatabase } from '../src/run'

const routes: Route[] = [
  { host: 'booki.localhost', to: 'client' },
  { host: 'api.booki.localhost', to: 'proxy-nginx:80' },
  { host: '*.client.localhost', to: 'nginx:443', passthrough: true },
]

const project: Project = { name: 'booki', root: '/w/booki-docker', repos: [], skip: ['booki-client'], routeHosts: ['client'], routes, settings: resolveConfig({ overrides: '/o', state: '/s' }) }

describe('worktreeHost', () => {
  test('prefixes the task, keeping a wildcard leftmost', () => {
    expect(worktreeHost('api.booki.localhost', 'planning')).toBe('planning.api.booki.localhost')
    expect(worktreeHost('*.client.localhost', 'planning')).toBe('*.planning.client.localhost')
  })
})

describe('rewriteHosts', () => {
  test('rewrites every main host once, the longest match first', () => {
    const env = 'ORIGIN=https://booki.localhost\nSERVER_URL=https://api.booki.localhost/booki\nCOOKIE_DOMAIN=.client.localhost\n'

    expect(rewriteHosts(env, routes, 'planning')).toBe('ORIGIN=https://planning.booki.localhost\nSERVER_URL=https://planning.api.booki.localhost/booki\nCOOKIE_DOMAIN=.planning.client.localhost\n')
  })

  test('is a no-op on a file it already rewrote', () => {
    const once = rewriteHosts('API=https://api.booki.localhost\nHOST=client.localhost\n', routes, 'planning')

    expect(rewriteHosts(once, routes, 'planning')).toBe(once)
  })

  test('leaves hosts that merely end like a main host alone', () => {
    expect(rewriteHosts('A=https://notbooki.localhost\nB=https://booki.localhost.example\n', routes, 'planning')).toBe('A=https://notbooki.localhost\nB=https://booki.localhost.example\n')
  })
})

describe('setEnvValue', () => {
  test('replaces an existing key in place', () => {
    expect(setEnvValue('A=1\nCOMPOSE_FILE=x.yml\nB=2\n', 'COMPOSE_FILE', 'x.yml:y.yml')).toBe('A=1\nCOMPOSE_FILE=x.yml:y.yml\nB=2\n')
  })

  test('appends a missing key on its own line', () => {
    expect(setEnvValue('A=1', 'B', '2')).toBe('A=1\nB=2\n')
    expect(setEnvValue('', 'B', '2')).toBe('B=2\n')
  })
})

describe('expandEnvValue', () => {
  test('fills in the task and the dev server port of the worktree', () => {
    const worktree = worktreeOf(project, 'planning')

    expect(expandEnvValue('{task}.booki.localhost:{port}', worktree)).toBe(`planning.booki.localhost:${worktree.clientPort}`)
  })
})

describe('renderOverride', () => {
  const config: ComposeConfig = {
    name: 'booki-docker--planning',
    services: {
      'proxy-nginx': { container_name: 'proxy_nginx', ports: [{}], networks: { default: null, proxy: { aliases: ['booki-proxy'] } } },
      'client': { networks: { default: null } },
      'booki-client': { container_name: 'booki-client', network_mode: 'host' },
      'api-php': { networks: { default: null } },
    },
  }
  const override = renderOverride(worktreeOf(project, 'planning'), config)

  test('drops container names and host ports, keeping old names as aliases inside the stack', () => {
    expect(override).toContain('  "proxy-nginx":\n    container_name: !reset null\n    ports: !reset []\n    labels:\n')
    expect(override).toContain('    networks:\n      "default":\n        aliases: ["proxy_nginx"]\n      proxy:\n        aliases: !reset []\n')
  })

  test('labels the routed service with the worktree hosts for devproxy', () => {
    expect(override).toContain('    labels:\n      "devproxy.wt0.host": "planning.booki.localhost"\n      "devproxy.wt0.to": "host:')
    expect(override).toContain('      "devproxy.wt1.host": "planning.api.booki.localhost"\n      "devproxy.wt1.port": "80"\n')
  })

  test('parks skipped services behind a profile and gives host-network ones no networks', () => {
    expect(override).toEndWith('  "booki-client":\n    profiles: ["wt-skip"]\n    container_name: !reset null\n')
  })

  test('points a routeHosts service at the proxy for the worktree hosts, wildcards aside', () => {
    expect(override).toContain('  "client":\n    extra_hosts:\n      - "planning.booki.localhost:host-gateway"\n      - "planning.api.booki.localhost:host-gateway"\n')
    expect(override).not.toContain('planning.client.localhost:host-gateway')
  })

  test('leaves a service with nothing to take away out of the file', () => {
    expect(override).not.toContain('api-php')
  })

  test('puts a routed service off the proxy network on it, keeping its own networks', () => {
    const mercure = renderOverride(worktreeOf({ ...project, routes: [{ host: 'mercure.booki.localhost', to: 'mercure:8000' }] }, 'planning'), { name: 'booki-docker--planning', services: { mercure: { networks: { default: null } } } })

    expect(mercure).toContain('  "mercure":\n    labels:\n      "devproxy.wt0.host": "planning.mercure.booki.localhost"\n      "devproxy.wt0.port": "8000"\n    networks:\n      "default": {}\n      proxy: {}\n')
    expect(mercure).toEndWith('networks:\n  proxy:\n    name: proxy\n    external: true\n')
    expect(override).not.toContain('external')
  })
})

describe('proxyLabels', () => {
  const services: ComposeConfig['services'] = {
    'booki-client': {},
    'nginx': { labels: { 'devproxy.web.host': 'booki.localhost, admin.booki.localhost', 'devproxy.web.port': '8080', 'other': 'x' } },
    'proxy-nginx': {},
  }
  const labels = (routes: Route[]) => Object.fromEntries(proxyLabels(worktreeOf({ ...project, routes }, 'planning'), { name: 'booki-docker--planning', services }))

  const port = worktreeOf(project, 'planning').clientPort

  test('routes each host on its service, the dev server on the first routed one, and moves the stack\'s own host labels to the worktree\'s hosts', () => {
    expect(labels(routes)).toEqual({
      'proxy-nginx': [
        ['devproxy.wt0.host', 'planning.booki.localhost'],
        ['devproxy.wt0.to', `host:${port}`],
        ['devproxy.wt1.host', 'planning.api.booki.localhost'],
        ['devproxy.wt1.port', '80'],
      ],
      'nginx': [
        ['devproxy.wt2.host', '*.planning.client.localhost'],
        ['devproxy.wt2.port', '443'],
        ['devproxy.wt2.passthrough', 'true'],
        ['devproxy.web.host', 'planning.booki.localhost,planning.admin.booki.localhost'],
      ],
    })
  })

  test('hangs the dev server on the first service not skipped when no route names one', () => {
    expect(labels([routes[0]!]).nginx).toEqual([['devproxy.wt0.host', 'planning.booki.localhost'], ['devproxy.wt0.to', `host:${port}`], ['devproxy.web.host', 'planning.booki.localhost,planning.admin.booki.localhost']])
  })
})

describe('overrideWarnings', () => {
  const warn = (services: ComposeConfig['services']) => overrideWarnings(worktreeOf(project, 'planning'), { name: 'booki-docker--planning', services })

  test('flags a proxy alias that is the service name, since the worktree claims it too', () => {
    expect(warn({ 'booki-app': { networks: { default: null, proxy: { aliases: ['booki-app'] } } } })).toEqual([
      'service booki-app has no alias of its own on the proxy network, so the worktree answers to booki-app there too and the shared proxy round-robins between them, give it one in the project override',
    ])
  })

  test('flags a service that joins the proxy network with no alias at all', () => {
    expect(warn({ mailhog: { networks: { proxy: {} } } })).toHaveLength(1)
    expect(warn({ mailhog: { networks: { proxy: null } } })).toHaveLength(1)
  })

  test('stays quiet on an alias main keeps to itself, and off the proxy network', () => {
    expect(warn({ 'proxy-nginx': { networks: { default: null, proxy: { aliases: ['booki-proxy'] } } } })).toEqual([])
    expect(warn({ 'api-php': { networks: { default: null } } })).toEqual([])
  })

  test('says nothing about a skipped service, which never runs', () => {
    expect(warn({ 'booki-client': { networks: { proxy: { aliases: ['booki-client'] } } } })).toEqual([])
  })
})

describe('testDatabase', () => {
  const api = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-api-'))

    for (const [name, text] of Object.entries(files))
      writeFileSync(join(dir, name), text)

    return dir
  }

  test('reads the test env over .env, never .env.local', () => {
    const dir = api({
      '.env': 'DATABASE_URL=postgresql://app:dev@db:5432/app\n',
      '.env.local': 'DATABASE_URL=postgresql://app:local@localhost:5432/app\n',
      '.env.test': 'DATABASE_URL="postgresql://booki:s%40cret@igesa-db:5433/booki?serverVersion=16"\n',
    })

    expect(testDatabase(dir)).toEqual({ host: 'igesa-db', port: 5433, user: 'booki', password: 's@cret' })
  })

  test('falls back to .env.dist and the default port', () => {
    expect(testDatabase(api({ '.env.dist': 'DATABASE_URL=postgres://u:p@db/app\n' }))).toEqual({ host: 'db', port: 5432, user: 'u', password: 'p' })
  })

  test('refuses another engine and a missing URL', () => {
    expect(() => testDatabase(api({ '.env': 'DATABASE_URL=mysql://u:p@db/app\n' }))).toThrow('only starts Postgres, and')
    expect(() => testDatabase(api({ '.env': 'APP_ENV=dev\n' }))).toThrow('no DATABASE_URL')
  })
})

describe('runPlan', () => {
  const config: ComposeConfig = {
    name: 'booki-docker',
    services: {
      'booki-php': { volumes: [{ type: 'volume', source: 'cache', target: '/cache' }, { type: 'bind', source: '/w/booki-docker/api', target: '/var/www/html' }] },
      'database': { image: 'postgres:16-alpine', networks: { default: { aliases: ['igesa-db'] } } },
    },
  }
  const run = { service: 'booki-php', dir: 'api', provision: [], env: { COMPOSER_HOME: '/tmp/composer', APP_ENV: 'test' } }
  const database = { host: 'igesa-db', port: 5432, user: 'booki', password: 'secret' }
  const worktree = worktreeOf(project, 'big-task')
  const plan = runPlan(worktree, run, config, database, { uid: 1000, gid: 1001 })

  test('starts a project-wide Postgres on a network of its own, answering to the test host, its password kept off the command line', () => {
    expect(plan.network).toBe('wt-booki-test')
    expect(plan.database).toEqual([
      'run',
      '-d',
      '--name',
      'wt-booki-test-db',
      '--network',
      'wt-booki-test',
      '--network-alias',
      'igesa-db',
      '--tmpfs',
      '/var/lib/postgresql/data',
      '-e',
      'POSTGRES_USER=booki',
      '-e',
      'POSTGRES_PASSWORD',
      '-e',
      'PGPORT=5432',
      'postgres:16-alpine',
    ])
    expect(plan.database.join(' ')).not.toContain('secret')
  })

  test('mounts the worktree where the service mounts main, as the user, with a test token of its own and no pull', () => {
    expect(plan.runner(['vendor/bin/phpunit', '--filter', 'Foo'])).toEqual([
      'run',
      '--rm',
      '-i',
      '--pull',
      'never',
      '--network',
      'wt-booki-test',
      '-u',
      '1000:1001',
      '-e',
      'HOME=/tmp',
      '-e',
      'COMPOSER_HOME=/tmp/composer',
      '-e',
      'APP_ENV=test',
      '-e',
      'TEST_TOKEN=big_task',
      '-v',
      `${worktree.dir}/api:/var/www/html`,
      '-w',
      '/var/www/html',
      'booki-docker-booki-php',
      'vendor/bin/phpunit',
      '--filter',
      'Foo',
    ])
  })

  test('gives the container the resolver the manifest names', () => {
    const runner = runPlan(worktree, { ...run, dns: '127.0.0.1' }, config, database, { uid: 1000, gid: 1001 }).runner(['true'])

    expect(runner.slice(runner.indexOf('--network'), runner.indexOf('-u'))).toEqual(['--network', 'wt-booki-test', '--dns', '127.0.0.1'])
  })

  test('refuses a service that does not mount the run dir, and a database host no service answers to', () => {
    expect(() => runPlan(worktree, { ...run, dir: 'client' }, config, database, { uid: 1, gid: 1 })).toThrow('does not bind-mount /w/booki-docker/client')
    expect(() => runPlan(worktree, run, config, { ...database, host: 'elsewhere' }, { uid: 1, gid: 1 })).toThrow('no service of booki-docker answers to elsewhere')
  })
})

describe('inLine', () => {
  test('runs tickets in arrival order, telling a waiter how many are ahead and what runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-queue-'))
    const order: string[] = []
    const heard: [number, string][] = []
    const { promise: held, resolve: finish } = Promise.withResolvers<void>()
    const first = inLine(dir, 'phpunit (in /w)', () => order.push('first waited'), async () => {
      order.push('first starts')
      await held
      order.push('first ends')
    })

    await Bun.sleep(5)

    const second = inLine(dir, 'e2e', (ahead, running) => heard.push([ahead, running]), async () => {
      order.push('second starts')
    })

    await Bun.sleep(50)
    finish()
    await Promise.all([first, second])

    expect(order).toEqual(['first starts', 'first ends', 'second starts'])
    expect(heard).toEqual([[1, 'phpunit (in /w)']])
    expect(liveTickets(dir)).toEqual([])
  })

  test('sweeps the ticket of a process that died waiting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-queue-'))
    const gone = Bun.spawn(['true'])

    await gone.exited
    writeFileSync(join(dir, `000000000000001-${gone.pid}`), 'killed')

    expect(liveTickets(dir)).toEqual([])
    expect(await inLine(dir, 'next', () => {
      throw new Error('should not wait')
    }, async () => 'ran')).toBe('ran')
  })

  test('sweeps a ticket taken before the machine booted, though its pid now names a live process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-queue-'))
    const live = `${String(Date.now()).padStart(15, '0')}-${process.pid}`

    writeFileSync(join(dir, `000000000000001-${process.pid}`), 'before boot')
    writeFileSync(join(dir, live), 'now')

    expect(liveTickets(dir)).toEqual([live])
  })
})

describe('wt ls --json', () => {
  test('lists nothing outside every project, leaving the other projects unswept', async () => {
    const out = await $`bun --no-env-file ${join(import.meta.dir, '..', 'src', 'cli.ts')} ls --json`.cwd(mkdtempSync(join(tmpdir(), 'wt-ls-'))).env({ ...process.env, WT_CONFIG: join(tmpdir(), 'wt-no-config', 'config.ts') }).quiet().text()

    expect(JSON.parse(out)).toEqual({ project: null, checkouts: [] })
  })
})

describe('changedFiles', () => {
  test('counts the files every repo lists', () => {
    expect(changedFiles([' M api/src/a.php\n?? api/new.php\n', '', 'M  client/b.ts'])).toBe(3)
  })

  test('is zero for clean repos', () => {
    expect(changedFiles(['', '\n'])).toBe(0)
  })
})

describe('copyFromMain', () => {
  test('redoes a copy cut short, which never took the target\'s name', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-main-'))
    const dir = mkdtempSync(join(tmpdir(), 'wt-task-'))

    mkdirSync(join(root, 'vendor', 'lib'), { recursive: true })
    writeFileSync(join(root, 'vendor', 'lib', 'a.php'), 'whole')
    mkdirSync(join(dir, 'vendor.wt-partial'))
    writeFileSync(join(dir, 'vendor.wt-partial', 'half.php'), 'cut short')

    await copyFromMain({ ...worktreeOf({ ...project, root, copy: ['vendor'] }, 'planning'), dir })

    expect(readFileSync(join(dir, 'vendor', 'lib', 'a.php'), 'utf8')).toBe('whole')
    expect(existsSync(join(dir, 'vendor', 'half.php'))).toBe(false)
    expect(existsSync(join(dir, 'vendor.wt-partial'))).toBe(false)
  })
})

describe('settle', () => {
  test('waits for every copy, a failed one first included, and returns the failures', async () => {
    const order: string[] = []
    const failures = await settle([
      async () => {
        throw new Error('disk full')
      },
      async () => {
        await Bun.sleep(30)
        order.push('slow copy done')
      },
    ])

    order.push('settled')

    expect(order).toEqual(['slow copy done', 'settled'])
    expect(failures.map(error => (error as Error).message)).toEqual(['disk full'])
  })
})

describe('whilePaused', () => {
  test('leaves no signal handler behind', async () => {
    const before = process.listenerCount('SIGTERM')

    expect(await whilePaused([], async () => {
      expect(process.listenerCount('SIGTERM')).toBe(before + 1)

      return 'copied'
    })).toBe('copied')
    expect(process.listenerCount('SIGTERM')).toBe(before)
  })
})

describe('worktree git', () => {
  // Run from the pre-commit hook, git's own GIT_DIR and GIT_INDEX_FILE would point every command at this repo
  const hookEnv = Object.entries(process.env).filter(([key]) => key.startsWith('GIT_'))
  const identity = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_AUTHOR_NAME: 'wt', GIT_AUTHOR_EMAIL: 'wt@test', GIT_COMMITTER_NAME: 'wt', GIT_COMMITTER_EMAIL: 'wt@test' }

  beforeAll(() => {
    for (const [key] of hookEnv)
      delete process.env[key]
  })

  afterAll(() => Object.assign(process.env, Object.fromEntries(hookEnv)))

  async function repoWithWorktree(): Promise<Worktree> {
    const root = mkdtempSync(join(tmpdir(), 'wt-git-'))

    await $`git init -q -b main && git commit -q --allow-empty -m init`.cwd(root).env(identity)

    const worktree = { ...worktreeOf({ ...project, root }, 'planning'), dir: join(mkdtempSync(join(tmpdir(), 'wt-trees-')), 'planning') }

    await addWorktrees(worktree, 'wt/planning')

    return worktree
  }

  test('a root with no nested repos checks out the branch', async () => {
    expect(await currentBranch((await repoWithWorktree()).dir)).toBe('wt/planning')
  })

  test('commits on no branch are found, those of a branch are not', async () => {
    const worktree = await repoWithWorktree()

    await $`git commit -q --allow-empty -m kept`.cwd(worktree.dir).env(identity)
    expect(await unreachableCommits(worktree)).toEqual([])

    await $`git switch -q --detach && git commit -q --allow-empty -m lost`.cwd(worktree.dir).env(identity)
    expect(await unreachableCommits(worktree)).toEqual(['root (1 commit)'])
  })

  test('a worktree git does not list is not registered', async () => {
    const worktree = await repoWithWorktree()

    expect(await isRegistered(worktree)).toBe(true)
    expect(await isRegistered({ ...worktree, dir: `${worktree.dir}-typo` })).toBe(false)
  })
})

describe('worktreeOf', () => {
  test('refuses a task whose hosts would be main\'s', () => {
    expect(() => worktreeOf(project, 'api')).toThrow('api.booki.localhost would be one of main\'s hosts')
  })

  test('refuses what is no DNS label', () => {
    for (const task of ['plan-', '-plan', 'Plan', 'a'.repeat(64), 'main', 'b--c'])
      expect(() => worktreeOf(project, task)).toThrow('invalid task name')

    expect(worktreeOf(project, 'plan-2').task).toBe('plan-2')
  })
})

describe('writeEnvFiles', () => {
  test('leaves an .env file whose text would not change untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-env-'))
    const worktree = { ...worktreeOf(project, 'planning'), dir }

    writeFileSync(join(dir, 'compose.yml'), 'services: {}\n')
    writeEnvFiles(worktree)
    utimesSync(join(dir, '.env'), 1, 1)
    writeEnvFiles(worktree)

    expect(statSync(join(dir, '.env')).mtimeMs).toBe(1000)
  })
})
