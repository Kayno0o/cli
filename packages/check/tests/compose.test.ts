import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { capture } from '@kaynooo/cli-kit/test'
import { afterAll, describe, expect, test } from 'bun:test'
import { check } from '../src/check'
import { place } from '../src/compose'
import { errs } from '../src/errs'
import { fix } from '../src/fix'
import { discover, discoverProjects } from '../src/steps'

// Every temp folder of the file, removed once it ends.
const made: string[] = []

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))

  made.push(dir)

  return dir
}

afterAll(() => {
  for (const dir of made)
    rmSync(dir, { recursive: true, force: true })
})

process.env.XDG_RUNTIME_DIR = temp('compose-runtime-')

// place() needs a docker on the PATH to reach a service; the cases that call it have this stub, which does nothing.
const stub = temp('compose-stub-')

writeFileSync(join(stub, 'docker'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
process.env.PATH = `${stub}:${process.env.PATH}`

// A throwaway repository: a .git folder and the files given, parent folders created.
function project(files: Record<string, string>): string {
  const root = temp('compose-project-')

  mkdirSync(join(root, '.git'))

  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), content)
  }

  return root
}

const COMPOSE = 'services:\n  app:\n    image: oven/bun:1\n    volumes:\n      - .:/app\n'
const SCRIPTS = JSON.stringify({ scripts: { 'check': 'echo types ok', 'lint': 'echo lint ok', 'test': 'echo tests ok', 'lint:fix': 'echo fixed' } })

// A stand-in for the docker bin: `compose ps` prints the running services, `compose exec` runs the command in the host folder the container path maps to, and every call is logged.
interface FakeDocker { calls: () => Promise<string[]> }

async function withDocker(running: string[], map: Record<string, string>, run: (docker: FakeDocker) => Promise<void>): Promise<void> {
  const bin = temp('compose-docker-')
  const script = [
    '#!/bin/sh',
    `echo "$*" >> ${bin}/calls`,
    `if [ "$2" = ps ]; then cat ${bin}/running; exit 0; fi`,
    'if [ "$2" != exec ]; then exit 1; fi',
    'shift 2',
    'while true; do',
    '  case "$1" in',
    '    -T) shift;;',
    '    -w) W="$2"; shift 2;;',
    '    -e) shift 2;;',
    '    *) break;;',
    '  esac',
    'done',
    'shift',
    `while read -r container host; do [ "$container" = "$W" ] && cd "$host"; done < ${bin}/map`,
    'exec "$@"',
    '',
  ].join('\n')

  writeFileSync(join(bin, 'docker'), script)
  chmodSync(join(bin, 'docker'), 0o755)
  writeFileSync(join(bin, 'running'), running.map(name => `${name}\n`).join(''))
  writeFileSync(join(bin, 'map'), Object.entries(map).map(([container, host]) => `${container} ${host}\n`).join(''))
  writeFileSync(join(bin, 'calls'), '')

  const path = process.env.PATH

  try {
    process.env.PATH = `${bin}:${path}`

    await run({ calls: async () => (await Bun.file(join(bin, 'calls')).text()).trim().split('\n').filter(line => line !== '') })
  }
  finally {
    process.env.PATH = path
  }
}

async function failure(run: Promise<unknown>): Promise<string> {
  try {
    await run
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }

  return ''
}

describe('place', () => {
  test('a .:/app mount in compose.yml, the folder and a subfolder of it at the matching path', async () => {
    const root = project({ 'compose.yml': COMPOSE, 'api/.keep': '' })

    expect(await place(root, 'bun')).toEqual({ service: 'app', composeDir: root, workdir: '/app' })
    expect(await place(join(root, 'api'), 'bun')).toEqual({ service: 'app', composeDir: root, workdir: '/app/api' })
  })

  test('compose.yaml and docker-compose.yml are read too', async () => {
    for (const name of ['compose.yaml', 'docker-compose.yml']) {
      const root = project({ [name]: COMPOSE })

      expect(await place(root, 'bun')).toMatchObject({ service: 'app' })
    }
  })

  test('./api:/var/www/html puts api there, and the root above the mount stays on the host', async () => {
    const root = project({ 'compose.yml': 'services:\n  php:\n    image: php:8.3-fpm\n    volumes:\n      - ./api:/var/www/html:ro\n', 'api/.keep': '' })

    expect(await place(join(root, 'api'), 'composer')).toEqual({ service: 'php', composeDir: root, workdir: '/var/www/html' })
    expect(await place(root, 'composer')).toBeUndefined()
  })

  test('a mount of a parent folder, the long syntax, a PWD variable and named volumes ignored', async () => {
    const text = [
      'services:',
      '  web:',
      '    volumes:',
      '      - type: bind',
      '        source: ..',
      '        target: /workspace',
      '      - data:/var/lib/data',
      '  other:',
      '    volumes:',
      // eslint-disable-next-line no-template-curly-in-string
      '      - ${PWD:-.}/api:/srv',
      '',
    ].join('\n')
    const root = project({ 'tools/compose.yml': text, 'tools/api/.keep': '' })
    const dir = join(root, 'tools')

    expect(await place(dir, 'make', { service: 'web' })).toEqual({ service: 'web', composeDir: dir, workdir: '/workspace/tools' })
    expect(await place(join(dir, 'api'), 'make', { service: 'other' })).toMatchObject({ service: 'other', workdir: '/srv' })
  })

  test('the override file adds its mounts to the service', async () => {
    const root = project({ 'compose.yml': 'services:\n  app:\n    image: php:8.3\n', 'compose.override.yml': 'services:\n  app:\n    volumes:\n      - .:/app\n' })

    expect(await place(root, 'composer')).toMatchObject({ service: 'app', workdir: '/app' })
  })

  test('a compose file above the folder is found up to the repository root only', async () => {
    const root = project({ 'compose.yml': COMPOSE, 'api/.keep': '' })
    const outside = temp('compose-outside-')

    writeFileSync(join(outside, 'compose.yml'), COMPOSE)
    mkdirSync(join(outside, 'sub'))

    expect(await place(join(root, 'api'), 'bun')).toMatchObject({ workdir: '/app/api' })
    expect(await place(join(outside, 'sub'), 'bun')).toBeUndefined()
  })

  test('--host forces the host', async () => {
    expect(await place(project({ 'compose.yml': COMPOSE }), 'bun', { host: true })).toBeUndefined()
  })

  test('several services mounting it: the one whose image runs the tool, else --in is asked for', async () => {
    const text = [
      'services:',
      '  app:',
      '    image: php:8.3-fpm',
      '    volumes: [".:/app"]',
      '  worker:',
      '    image: php:8.3-cli',
      '    volumes: [".:/app"]',
      '  assets:',
      '    image: oven/bun:1',
      '    volumes: [".:/app"]',
      '',
    ].join('\n')
    const root = project({ 'compose.yml': text })

    expect(await place(root, 'bun')).toMatchObject({ service: 'assets' })

    const message = await failure(place(root, 'composer'))

    expect(message).toContain('app, worker, assets all mount')
    expect(message).toContain('--in <service>')
    expect(await failure(place(root, 'make'))).toContain('--in <service>')
    expect(await place(root, 'composer', { service: 'worker' })).toMatchObject({ service: 'worker' })
  })

  test('--in names a service that does not exist or does not mount the folder', async () => {
    const root = project({ 'compose.yml': `${COMPOSE}  db:\n    image: postgres:16\n` })

    expect(await failure(place(root, 'bun', { service: 'nope' }))).toContain('no such service, found app, db')
    expect(await failure(place(root, 'bun', { service: 'db' }))).toContain('the service does not mount')
  })
})

describe('place without docker, with COMPOSE_FILE, with a broken file', () => {
  test('no docker on the PATH: the step runs on the host and says so once', async () => {
    const root = project({ 'compose.yml': COMPOSE, 'package.json': SCRIPTS })
    const bin = temp('compose-nodocker-')

    symlinkSync(Bun.which('sh') ?? '/bin/sh', join(bin, 'sh'))
    symlinkSync(process.execPath, join(bin, 'bun'))

    const path = process.env.PATH

    try {
      process.env.PATH = bin

      const first = await capture(async () => check(['--only', 'check'], root))
      const second = await capture(async () => check(['--only', 'lint'], root))

      expect(first.result).toBe(0)
      expect(first.out).toContain('ok    check')
      expect(first.err).toContain('host, docker not found')
      expect(second.result).toBe(0)
      expect(second.err).toBe('')
      expect(await failure(place(root, 'bun', { service: 'app' }))).toContain('--in app: docker not found')
    }
    finally {
      process.env.PATH = path
    }
  })

  test('COMPOSE_FILE names the files, relative to the project folder, split by COMPOSE_PATH_SEPARATOR', async () => {
    const root = project({ 'stack/base.yml': 'services:\n  app:\n    image: oven/bun:1\n', 'stack/mounts.yml': 'services:\n  app:\n    volumes:\n      - .:/app\n' })
    const saved = { file: process.env.COMPOSE_FILE, separator: process.env.COMPOSE_PATH_SEPARATOR }

    try {
      process.env.COMPOSE_FILE = 'stack/base.yml:stack/mounts.yml'
      expect(await place(root, 'bun')).toEqual({ service: 'app', composeDir: root, workdir: '/app' })

      process.env.COMPOSE_FILE = 'stack/base.yml;stack/mounts.yml'
      process.env.COMPOSE_PATH_SEPARATOR = ';'
      expect(await place(root, 'bun')).toMatchObject({ service: 'app' })

      process.env.COMPOSE_FILE = 'stack/base.yml'
      expect(await place(root, 'bun')).toBeUndefined()

      delete process.env.COMPOSE_PATH_SEPARATOR
      process.env.COMPOSE_FILE = 'stack/base.yml:stack/gone.yml'
      expect(await failure(place(root, 'bun'))).toContain(`COMPOSE_FILE names ${join(root, 'stack/gone.yml')}, which does not exist`)
    }
    finally {
      for (const [name, value] of [['COMPOSE_FILE', saved.file], ['COMPOSE_PATH_SEPARATOR', saved.separator]] as const) {
        if (value === undefined)
          delete process.env[name]
        else
          process.env[name] = value
      }
    }
  })

  test('a compose file that does not parse fails naming it and pointing at --host', async () => {
    const root = project({ 'compose.yml': 'services:\n  app: [\n', 'package.json': SCRIPTS })
    const message = await failure(check(['--only', 'check'], root))

    expect(message).toContain(join(root, 'compose.yml'))
    expect(message).toMatch(/cannot read/)
    expect((await capture(async () => check(['--host', '--only', 'check'], root))).result).toBe(0)
    expect(await failure(errs(['--', 'true'], root))).toContain(join(root, 'compose.yml'))
  })
})

describe('steps from PHP config files', () => {
  test('phpstan.neon, .php-cs-fixer.dist.php and phpunit.xml.dist give typecheck, lint and test', async () => {
    const root = project({ 'phpstan.neon': '', '.php-cs-fixer.dist.php': '', 'phpunit.xml.dist': '' })
    const steps = await discover(root)

    expect(steps.map(step => [step.name, step.command, step.source])).toEqual([
      ['typecheck', 'vendor/bin/phpstan analyse --no-progress --memory-limit=1G', 'phpstan.neon'],
      ['lint', 'vendor/bin/php-cs-fixer fix --dry-run -v', '.php-cs-fixer.dist.php'],
      ['test', 'vendor/bin/phpunit', 'phpunit.xml.dist'],
    ])
  })

  test('a composer script of the same name wins', async () => {
    const root = project({ 'composer.json': JSON.stringify({ scripts: { test: 'phpunit --testdox' } }), 'phpstan.neon.dist': '', 'phpunit.xml': '' })
    const steps = await discover(root)

    expect(steps.map(step => [step.name, step.command])).toEqual([['typecheck', 'vendor/bin/phpstan analyse --no-progress --memory-limit=1G'], ['test', 'composer run test']])
  })
})

describe('discoverProjects', () => {
  test('a root without steps gives the steps of the subfolders that have some', async () => {
    const root = project({ 'api/composer.json': JSON.stringify({ scripts: { test: 'phpunit' } }), 'client/package.json': SCRIPTS, 'docs/readme.md': '', 'node_modules/x/package.json': SCRIPTS })
    const projects = await discoverProjects(root)

    expect(projects.map(entry => entry.name)).toEqual(['api', 'client'])
    expect(projects[0]?.dir).toBe(join(root, 'api'))
  })

  test('a root with its own steps is one project', async () => {
    const root = project({ 'package.json': SCRIPTS, 'client/package.json': SCRIPTS })

    expect((await discoverProjects(root)).map(entry => entry.name)).toEqual([undefined])
  })
})

describe('check in a compose service', () => {
  test('--list says where each step runs, --host and --in change it', async () => {
    const root = project({ 'compose.yml': COMPOSE, 'package.json': SCRIPTS })
    const listed = await capture(async () => check(['--list'], root))

    expect(listed.out).toContain('check  bun run check  package.json  app')

    const host = await capture(async () => check(['--list', '--host'], root))

    expect(host.out).toContain('check  bun run check  package.json  host')

    const json = await capture(async () => check(['--list', '--json'], root))

    const [first]: unknown[] = JSON.parse(json.out)

    expect(first).toEqual({ name: 'check', command: 'bun run check', source: 'package.json', in: 'app' })
    expect(await failure(check(['--in', 'app', '--host'], root))).toContain('exclude each other')
  })

  test('a running service is exec\'d into at the matching path, with colours off', async () => {
    const root = project({ 'compose.yml': COMPOSE, 'package.json': SCRIPTS, 'api/.keep': '' })

    await withDocker(['db', 'app'], { '/app': root }, async (docker) => {
      const { result, out } = await capture(async () => check(['--only', 'check,lint'], root))

      expect(result).toBe(0)
      expect(out).toContain('ok    check')
      expect(await docker.calls()).toEqual([
        'compose ps --services --status running',
        'compose exec -T -w /app -e NO_COLOR=1 -e FORCE_COLOR=0 app sh -c bun run check',
        'compose exec -T -w /app -e NO_COLOR=1 -e FORCE_COLOR=0 app sh -c bun run lint',
      ])
    })
  })

  test('a service that is down is never started: the step fails naming it', async () => {
    const root = project({ 'compose.yml': COMPOSE, 'package.json': SCRIPTS })

    await withDocker(['db'], { '/app': root }, async (docker) => {
      const { result, out } = await capture(async () => check(['--only', 'check,test'], root))

      expect(result).toBe(1)
      expect(out).toContain('FAIL  check')
      expect(out).toContain('the app service is not running')
      expect(out).toContain('(in app)')
      expect(await docker.calls()).toEqual(['compose ps --services --status running'])
    })
  })

  test('--host runs on the host, docker never called', async () => {
    const root = project({ 'compose.yml': COMPOSE, 'package.json': SCRIPTS })

    await withDocker([], {}, async (docker) => {
      expect((await capture(async () => check(['--host', '--only', 'check'], root))).result).toBe(0)
      expect(await docker.calls()).toEqual([])
    })
  })

  test('--json names the service a step ran in', async () => {
    const root = project({ 'compose.yml': COMPOSE, 'package.json': SCRIPTS })

    await withDocker(['app'], { '/app': root }, async () => {
      const { out } = await capture(async () => check(['--json', '--only', 'check'], root))

      expect(JSON.parse(out)).toMatchObject([{ name: 'check', in: 'app', ok: true }])
    })
  })

  test('--slot queues the docker command, quoted whole', async () => {
    const root = project({ 'compose.yml': COMPOSE, 'package.json': SCRIPTS })
    const bin = temp('compose-slot-')
    const path = process.env.PATH

    writeFileSync(join(bin, 'slot'), `#!/bin/sh\necho "$*" >> ${bin}/calls\nshift\nexec "$@"\n`, { mode: 0o755 })

    await withDocker(['app'], { '/app': root }, async (docker) => {
      try {
        process.env.PATH = `${bin}:${process.env.PATH}`

        expect((await capture(async () => check(['--slot', '--only', 'check'], root))).result).toBe(0)
        expect((await Bun.file(join(bin, 'calls')).text())).toContain(`-- sh -c cd ${root} && docker compose exec -T -w /app -e NO_COLOR=1 -e FORCE_COLOR=0 app sh -c 'bun run check'`)
        expect((await docker.calls()).at(-1)).toContain('app sh -c bun run check')
      }
      finally {
        process.env.PATH = path
      }
    })
  })

  test('a root without steps runs each subfolder\'s, one line naming it, the one with a mount in its service', async () => {
    const root = project({
      'compose.yml': 'services:\n  php:\n    image: php:8.3\n    volumes:\n      - ./api:/var/www/html\n',
      'api/package.json': JSON.stringify({ scripts: { lint: 'echo api lint' } }),
      'client/package.json': JSON.stringify({ scripts: { lint: 'echo client lint', test: 'echo client test' } }),
    })

    await withDocker(['php'], { '/var/www/html': join(root, 'api') }, async (docker) => {
      const listed = await capture(async () => check(['--list'], root))

      expect(listed.out).toContain('api/lint     bun run lint  package.json  php')
      expect(listed.out).toContain('client/lint  bun run lint  package.json  host')

      const { result, out } = await capture(async () => check([], root))

      expect(result).toBe(0)
      expect(out).toContain('ok    api/lint')
      expect(out).toContain('ok    client/lint')
      expect(out).toContain('ok    client/test')
      expect(await docker.calls()).toEqual(['compose ps --services --status running', 'compose exec -T -w /var/www/html -e NO_COLOR=1 -e FORCE_COLOR=0 php sh -c bun run lint'])

      const only = await capture(async () => check(['--only', 'test'], root))

      expect(only.out).not.toContain('api/')
      expect(only.out).toContain('client/test')
    })
  })

  test('a step that fails in the service shows what failed', async () => {
    const root = project({ 'compose.yml': COMPOSE, 'package.json': JSON.stringify({ scripts: { lint: 'echo \'src/a.ts(1,7): error TS2322: bad\' && exit 1' } }) })

    await withDocker(['app'], { '/app': root }, async () => {
      const { result, out } = await capture(async () => check([], root))

      expect(result).toBe(1)
      expect(out).toContain('FAIL  lint')
      expect(out).toContain('src/a.ts(1,7): error TS2322: bad')
    })
  })
})

describe('fix in a compose service', () => {
  test('a lint:fix script and php-cs-fixer run in the service, listed with where', async () => {
    const root = project({ 'compose.yml': COMPOSE, 'package.json': SCRIPTS, '.php-cs-fixer.dist.php': '' })
    const listed = await capture(async () => fix(['--list'], root))

    expect(listed.out).toContain('lint:fix      bun run lint:fix             package.json            app')
    expect(listed.out).toContain('php-cs-fixer  vendor/bin/php-cs-fixer fix  .php-cs-fixer.dist.php  app')

    await withDocker(['app'], { '/app': root }, async (docker) => {
      const { result, out } = await capture(async () => fix(['--only', 'lint:fix'], root))

      expect(result).toBe(0)
      expect(out).toContain('ok    lint:fix')
      expect(await docker.calls()).toEqual(['compose ps --services --status running', 'compose exec -T -w /app -e NO_COLOR=1 -e FORCE_COLOR=0 -e AGENT_TOOLS_FIX=1 app sh -c bun run lint:fix'])
    })
  })

  test('php-cs-fixer is left to a composer fixer script, a down service fails the fixer naming it', async () => {
    const composer = project({ 'composer.json': JSON.stringify({ scripts: { 'lint:fix': 'php-cs-fixer fix' } }), '.php-cs-fixer.php': '' })

    expect((await capture(async () => fix(['--list', '--json'], composer))).out).not.toContain('"php-cs-fixer"')

    const root = project({ 'compose.yml': COMPOSE, 'package.json': SCRIPTS })

    await withDocker([], { '/app': root }, async () => {
      const { result, out } = await capture(async () => fix([], root))

      expect(result).toBe(1)
      expect(out).toContain('the app service is not running')
    })
  })
})

describe('errs -- in a compose service', () => {
  test('runs the command in the service and reads its output', async () => {
    const root = project({ 'compose.yml': COMPOSE })
    const script = join(root, 'tsgo')

    writeFileSync(script, '#!/bin/sh\necho \'a.ts(1,7): error TS2322: bad\'\nexit 2\n', { mode: 0o755 })

    await withDocker(['app'], { '/app': root }, async (docker) => {
      const { result, out } = await capture(async () => errs(['--json', '--', script], root))

      expect(result).toBe(1)
      const parsed: { errors: unknown[] } = JSON.parse(out)

      expect(parsed.errors).toHaveLength(1)
      expect(await docker.calls()).toEqual(['compose ps --services --status running', `compose exec -T -w /app -e NO_COLOR=1 -e FORCE_COLOR=0 app ${script}`])
    })
  })

  test('a service that is down fails the call naming it, --host runs on the host', async () => {
    const root = project({ 'compose.yml': COMPOSE })
    const script = join(root, 'tool')

    writeFileSync(script, '#!/bin/sh\necho ok\n', { mode: 0o755 })

    await withDocker([], { '/app': root }, async (docker) => {
      expect(await failure(errs(['--', script], root))).toContain('the app service is not running')
      expect((await capture(async () => errs(['--host', '--', script], root))).result).toBe(0)
      expect(await docker.calls()).toEqual(['compose ps --services --status running'])
    })
  })

  test('--in and --host only apply to a command', async () => {
    expect(await failure(errs(['--host', join(import.meta.dir, 'fixtures/errs/tsgo.txt')]))).toContain('apply to a command run after --')
  })
})
