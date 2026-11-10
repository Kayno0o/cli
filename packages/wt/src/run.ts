import type { ComposeConfig } from './compose'
import type { RunConfig, Worktree } from './project'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { $ } from 'bun'
import { composeConfig } from './compose'
import { wtConfig } from './config'
import { readEnvFile } from './env_file'
import { assertWorktreeExists, locateWorktree, WtError } from './project'
import { inLine, queueDir } from './queue'

export interface TestDatabase {
  // The host the test env dials, which the throwaway database answers to on the private network.
  host: string
  port: number
  user: string
  password: string
}

export interface RunPlan {
  network: string
  container: string
  // `docker` arguments starting the database; its password comes from the environment, never the command line.
  database: string[]
  // `docker` arguments running a command of the worktree.
  runner: (command: string[]) => string[]
}

const POSTGRES = /^postgres(?:ql)?:$/
const DEFAULT_PORT = 5432
const READY_TRIES = 60

const testContainer = (worktree: Worktree) => `wt-${worktree.project.name}-test-db`

// Symfony's test env reads .env (.env.dist without one), .env.test and .env.test.local, never .env.local.
export function testDatabase(dir: string): TestDatabase {
  const base = existsSync(join(dir, '.env')) ? '.env' : '.env.dist'
  const env: Record<string, string> = Object.assign({}, ...[base, '.env.test', '.env.test.local'].map(file => readEnvFile(join(dir, file))))

  if (env.DATABASE_URL === undefined || env.DATABASE_URL === '')
    throw new WtError(`no DATABASE_URL in the test env files of ${dir}`)

  const url = new URL(env.DATABASE_URL)

  if (!POSTGRES.test(url.protocol))
    throw new WtError(`wt run only starts Postgres, and ${dir} tests against ${url.protocol.slice(0, -1)}`)

  return { host: url.hostname, port: Number(url.port || DEFAULT_PORT), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) }
}

// Doctrine's dbname_suffix (`_test%env(default::TEST_TOKEN)%`) gives each worktree a database of its own on the shared server.
export function testToken(task: string): string {
  return task.replaceAll('-', '_')
}

function databaseImage(config: ComposeConfig, host: string): string {
  const service = config.services[host] ?? Object.values(config.services).find(each => Object.values(each.networks ?? {}).some(network => network?.aliases?.includes(host)))

  if (service?.image === undefined || service.image === '')
    throw new WtError(`no service of ${config.name} answers to ${host}, the test database host, with an image to start`)

  return service.image
}

// The worktree's `dir` goes where the service mounts main's, so the image finds it where it expects; the database is one container per project, on a network of its own, so neither touches the user's stack.
export function runPlan(worktree: Worktree, run: RunConfig, config: ComposeConfig, database: TestDatabase, ids: { uid: number, gid: number } = userInfo(), tty = false): RunPlan {
  const service = config.services[run.service]

  if (!service)
    throw new WtError(`${config.name} has no service ${run.service}`)

  const source = join(worktree.project.root, run.dir)
  const target = service.volumes?.find(volume => volume.type === 'bind' && volume.source === source)?.target

  if (target === undefined)
    throw new WtError(`${run.service} does not bind-mount ${source}, so wt cannot tell where the worktree's copy goes`)

  const network = `wt-${worktree.project.name}-test`
  const container = testContainer(worktree)

  return {
    network,
    container,
    database: [
      'run',
      '-d',
      '--name',
      container,
      '--network',
      network,
      '--network-alias',
      database.host,
      '--tmpfs',
      '/var/lib/postgresql/data',
      '-e',
      `POSTGRES_USER=${database.user}`,
      '-e',
      'POSTGRES_PASSWORD',
      '-e',
      `PGPORT=${database.port}`,
      databaseImage(config, database.host),
    ],
    runner: command => [
      'run',
      '--rm',
      '-i',
      ...tty ? ['-t'] : [],
      '--pull',
      'never',
      '--network',
      network,
      ...run.dns !== undefined ? ['--dns', run.dns] : [],
      '-u',
      `${ids.uid}:${ids.gid}`,
      '-e',
      'HOME=/tmp',
      ...Object.entries(run.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      '-e',
      `TEST_TOKEN=${testToken(worktree.task)}`,
      '-v',
      `${join(worktree.dir, run.dir)}:${target}`,
      '-w',
      target,
      service.image ?? `${config.name}-${run.service}`,
      ...command,
    ],
  }
}

async function runningId(container: string): Promise<string | undefined> {
  const result = await $`docker inspect --format ${'{{if .State.Running}}{{.Id}}{{end}}'} ${container}`.quiet().nothrow()

  return result.text().trim() || undefined
}

// Started once and shared by the project's worktrees until it is removed; its data lives in memory, so a restart means fresh databases.
async function ensureDatabase(plan: RunPlan, database: TestDatabase): Promise<string> {
  if ((await $`docker network inspect ${plan.network}`.quiet().nothrow()).exitCode !== 0)
    await $`docker network create ${plan.network}`.quiet().nothrow()

  let id = await runningId(plan.container)

  if (id === undefined) {
    await $`docker rm -f ${plan.container}`.quiet().nothrow()

    const started = await $`docker ${plan.database}`.env({ ...process.env, POSTGRES_PASSWORD: database.password }).quiet().nothrow()

    // Another `wt run` may have started it first, which leaves this one's name taken and the container running.
    id = await runningId(plan.container)

    if (id === undefined)
      throw new WtError(`${plan.container} did not start:\n${started.stderr.toString().trim()}`)
  }

  // Through TCP, since the image's first boot answers on its socket while it is still initialising.
  for (let tries = 0; tries < READY_TRIES; tries++) {
    if ((await $`docker exec ${plan.container} pg_isready -q -h 127.0.0.1 -U ${database.user}`.quiet().nothrow()).exitCode === 0)
      return id

    await Bun.sleep(1000)
  }

  throw new WtError(`${plan.container} is not accepting connections after ${READY_TRIES} s: docker logs ${plan.container}`)
}

// Forwards an interrupt to the child, a `docker run` passing it on to the container, and resolves with its exit code.
export async function runInherit(command: string[]): Promise<number> {
  const child = Bun.spawn(command, { stdio: ['inherit', 'inherit', 'inherit'] })
  const forward = (signal: NodeJS.Signals) => child.kill(signal)

  process.on('SIGINT', forward)
  process.on('SIGTERM', forward)

  try {
    return await child.exited
  }
  finally {
    process.off('SIGINT', forward)
    process.off('SIGTERM', forward)
  }
}

// What `wt rm` leaves behind: its databases on the project's shared test server, whose name ends in its TEST_TOKEN, and the markers saying they were provisioned.
export async function forgetTestDatabases(worktree: Worktree): Promise<void> {
  const container = testContainer(worktree)

  if (await runningId(container) !== undefined) {
    const listed = await $`docker exec ${container} sh -c ${'psql -U "$POSTGRES_USER" -d postgres -Atc "select datname from pg_database"'}`.quiet().nothrow()
    const ours = listed.text().split('\n').filter(name => name.endsWith(`_test${testToken(worktree.task)}`))

    for (const name of ours)
      await $`docker exec ${container} sh -c ${'dropdb -U "$POSTGRES_USER" --force "$0"'} ${name}`.quiet().nothrow()
  }

  const markers = worktree.project.settings.state

  if (!existsSync(markers))
    return

  for (const file of readdirSync(markers).filter(name => name.startsWith(`${worktree.id}.test-`)))
    rmSync(join(markers, file), { force: true })
}

// Once per worktree and database container, in line behind any other `wt run` of the same worktree doing it too.
async function provision(worktree: Worktree, run: RunConfig, plan: RunPlan, databaseId: string): Promise<void> {
  const markers = worktree.project.settings.state
  const marker = join(markers, `${worktree.id}.test-${databaseId.slice(0, 12)}`)

  if (existsSync(marker))
    return

  await inLine(queueDir(worktree.project.settings, `${worktree.id}.provision`), 'provisioning', () => console.error(`wt run: waiting for ${worktree.task}'s test database to be provisioned`), async () => {
    if (existsSync(marker))
      return

    console.error(`wt run: provisioning ${worktree.task}'s test database`)

    for (const step of run.provision) {
      if (await runInherit(['docker', ...plan.runner(['sh', '-c', step])]) !== 0)
        throw new WtError(`provisioning failed on \`${step}\`, run it again with \`wt run ${worktree.task} -- sh -c '${step}'\``)
    }

    mkdirSync(markers, { recursive: true })
    writeFileSync(marker, '')
  })
}

export async function runTask(task: string, command: string[], project?: string): Promise<number> {
  const worktree = await locateWorktree(process.cwd(), task, project)
  const { run, name, root } = worktree.project

  assertWorktreeExists(worktree)

  if (!run)
    throw new WtError(`${name} has no \`run\` in its manifest, so wt cannot tell which service runs its tests`)

  const database = testDatabase(join(worktree.dir, run.dir))
  const plan = runPlan(worktree, run, await composeConfig(root), database, userInfo(), Boolean(process.stdin.isTTY && process.stdout.isTTY))

  await provision(worktree, run, plan, await ensureDatabase(plan, database))

  return runInherit(['docker', ...plan.runner(command)])
}

// One heavy command at a time across every session on the machine, the rest waiting their turn in arrival order.
export async function runHeavy(command: string[]): Promise<number> {
  const label = `${command.join(' ')} (in ${process.cwd()})`

  return inLine(queueDir(await wtConfig(), 'heavy'), label, (ahead, running) => console.error(`wt heavy: ${ahead} ahead, running ${running}`), async () => runInherit(command))
}
