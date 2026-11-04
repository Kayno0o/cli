/* eslint-disable no-template-curly-in-string */
import type { ComposeLoader, ComposeModel } from '../src/audit/types'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { capture } from '@kaynooo/cli-kit/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { render } from '../src/audit/render'
import { loadConfig, audit as runAudit } from '../src/audit/run'
import { audit } from '../src/commands/audit'

const made: string[] = []

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'stack-audit-'))

  made.push(root)

  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), text)
  }

  return root
}

// Answers with the model recorded for the exact file list, so no docker is needed.
function models(table: Record<string, ComposeModel>): ComposeLoader {
  return async (_root, files) => {
    const model = table[files.join('+')]

    if (model === undefined)
      throw new Error('no such service')

    return model
  }
}

const COMPOSE = `# server layout: ./data/db
services:
  api:
    image: registry.example/team/api:\${API_VERSION}
    environment:
      DB_PASSWORD: \${DB_PASSWORD}
      MODE: \${MODE:-prod}
`

function CONFIG(extra = '') {
  return `export default {
  registry: 'registry.example/team',
  deploySyncFiles: ['./compose.yaml'],
  requiredServerEnv: ['DB_PASSWORD'],
  releases: [{ slug: 'api', image: 'api', versionEnv: 'API_VERSION', restartServices: ['api'] }],
  servers: [],
  ${extra}
}
`
}

const HEALTHY: ComposeModel = { services: { api: { image: 'registry.example/team/api:1', healthcheck: { test: ['CMD', 'true'] } } } }
const IGNORE = '.release-logs\n.release-worktrees\n'

async function run(files: Record<string, string>, table: Record<string, ComposeModel>, env: Record<string, string> = {}) {
  const root = project(files)
  const config = (await import(join(root, 'release.config.ts')) as { default: Parameters<typeof runAudit>[0] }).default

  return runAudit(config, { root, loadCompose: models(table), env, home: '/nonexistent-home' })
}

const messages = (result: Awaited<ReturnType<typeof run>>) => result.findings.map(finding => `${finding.level} ${finding.check}: ${finding.message}`)

describe('audit', () => {
  test('agrees on a consistent project', async () => {
    const result = await run({ 'release.config.ts': CONFIG(), 'compose.yaml': COMPOSE, '.gitignore': IGNORE }, { 'compose.yaml': HEALTHY })

    expect(result.findings).toEqual([])
    expect(render(result)).toMatch(/^ok: stack-audit-\w+: compose compose\.yaml and release\.config\.ts agree\.$/)
  })

  test('lists at most the limit of errors and of warnings, the totals counting them all', () => {
    const finding = (level: 'error' | 'warn', message: string) => ({ level, check: 'x', message })
    const result = { root: '/p', composeFiles: [], findings: [finding('error', 'a'), finding('error', 'b'), finding('error', 'c'), finding('warn', 'd')] } as unknown as Parameters<typeof render>[0]

    expect(render(result, 2)).toBe('Errors\n  error: [x] a\n  error: [x] b\n  1 more, rerun with --full\n\nWarnings\n  warning: [x] d\n\n3 error(s), 1 warning(s)')
  })

  test('reports a missing sync file, build inputs and secrets', async () => {
    const config = `export default {
      registry: 'r',
      deploySyncFiles: ['./compose.yaml', './gone.yaml'],
      requiredServerEnv: ['DB_PASSWORD'],
      releases: [{ slug: 'api', sourceDir: 'nope', buildContext: 'ctx', dockerfile: 'Dockerfile.x', versionEnv: 'API_VERSION', buildSecrets: [{ id: 'npmrc', src: '~/.npmrc' }, { id: 'rel', src: 'rel.txt' }, { id: 'tok', env: 'TOKEN' }] }],
    }`
    const result = await run({ 'release.config.ts': config, 'compose.yaml': COMPOSE, '.gitignore': IGNORE }, { 'compose.yaml': HEALTHY })

    expect(messages(result).slice(0, 7)).toEqual([
      'error sync: deploySyncFiles entry does not exist: ./gone.yaml',
      'error build: api: sourceDir does not exist: nope',
      'error build: api: buildContext does not exist: ctx',
      'error build: api: dockerfile does not exist: Dockerfile.x',
      'error build: api: buildSecret "npmrc" src does not exist: ~/.npmrc',
      'error build: api: buildSecret "rel" src does not exist: rel.txt',
      'warn build: api: buildSecret "tok" reads $TOKEN, unset in this shell',
    ])
  })

  test('expands ~ against the given home and reads the shell env', async () => {
    const root = project({ 'release.config.ts': CONFIG(), 'compose.yaml': COMPOSE, '.gitignore': IGNORE, 'home/.npmrc': '' })
    const config = { registry: 'r', releases: [{ slug: 'a', buildSecrets: [{ id: 'n', src: '~/.npmrc' }, { id: 't', env: 'TOKEN' }] }] }
    const result = await runAudit(config, { root, loadCompose: models({}), env: { TOKEN: 'x' }, home: join(root, 'home') })

    expect(result.findings.filter(finding => finding.check === 'build')).toEqual([])
  })

  test('env references: bare, defaulted, version and listed-but-unused', async () => {
    const compose = COMPOSE.replace('MODE: ${MODE:-prod}', 'MODE: ${MODE}\n      OTHER: ${OTHER:?must be set}')
    const result = await run({ 'release.config.ts': CONFIG().replace('[\'DB_PASSWORD\']', '[\'DB_PASSWORD\', \'UNUSED\']'), 'compose.yaml': compose, '.gitignore': IGNORE }, { 'compose.yaml': HEALTHY })

    expect(messages(result)).toEqual([
      'error env: ${MODE} has no default in compose.yaml and is not in requiredServerEnv',
      'error env: ${OTHER} has no default in compose.yaml and is not in requiredServerEnv',
      'warn env: requiredServerEnv lists UNUSED, which no compose file references',
    ])
  })

  test('env references skip the $$ escape and comments, and read a bare $VAR', async () => {
    const compose = COMPOSE.replace('MODE: ${MODE:-prod}', () => 'MODE: ${MODE:-prod}\n      # OLD: ${COMMENTED}\n      CHECK: $${HEALTH_URL} # was ${TRAILING}\n      BARE: $BARE_VAR\n      HASH: "${QUOTED:-a # b}"')
    const result = await run({ 'release.config.ts': CONFIG(), 'compose.yaml': compose, '.gitignore': IGNORE }, { 'compose.yaml': HEALTHY })

    expect(messages(result)).toEqual(['error env: ${BARE_VAR} has no default in compose.yaml and is not in requiredServerEnv'])
  })

  test('without a compose file among deploySyncFiles it says every compose check was skipped', async () => {
    const result = await run({ 'release.config.ts': CONFIG().replace('./compose.yaml', './notes.txt'), '.gitignore': IGNORE }, {})

    expect(messages(result)).toContain('warn compose: no compose file among deploySyncFiles, so every check that reads the compose model was skipped')
  })

  test('a bare variable is a warning while requiredServerEnv is empty', async () => {
    const result = await run({ 'release.config.ts': CONFIG().replace('[\'DB_PASSWORD\']', '[]'), 'compose.yaml': COMPOSE, '.gitignore': IGNORE }, { 'compose.yaml': HEALTHY })

    expect(messages(result)).toEqual(['warn env: ${DB_PASSWORD} has no default in compose.yaml and is not in requiredServerEnv'])
  })

  test('version variables must match both ways', async () => {
    const config = CONFIG().replace('versionEnv: \'API_VERSION\'', 'versionEnv: \'WEB_VERSION\'')
    const result = await run({ 'release.config.ts': config, 'compose.yaml': COMPOSE, '.gitignore': IGNORE }, { 'compose.yaml': HEALTHY })

    expect(messages(result)).toEqual([
      'error version: versionEnv WEB_VERSION is never interpolated by a compose file',
      'error version: compose interpolates ${API_VERSION}, which no release declares as versionEnv',
    ])
  })

  test('services: images, restart names, post-deploy targets, healthchecks', async () => {
    const config = `export default {
      registry: 'registry.example/team',
      deploySyncFiles: ['./compose.yaml'],
      requiredServerEnv: ['DB_PASSWORD'],
      releases: [{ slug: 'api', image: 'api', versionEnv: 'API_VERSION', restartServices: ['api', 'ghost'], postDeployCommands: ['{compose} exec -T worker bin/migrate', '{compose} --profile init run --rm --no-deps init ls', 'echo hi'] }],
      servers: [{ name: 'prod', releaseOverrides: { api: { restartServices: ['phantom'] } } }],
    }`
    const model: ComposeModel = { services: { api: { image: 'registry.example/team/api:1' }, init: {}, stray: { image: 'registry.example/team/other:2' }, db: { image: 'postgres:18' } } }
    const result = await run({ 'release.config.ts': config, 'compose.yaml': COMPOSE, '.gitignore': IGNORE }, { 'compose.yaml': model })

    expect(messages(result)).toEqual([
      'warn image: service "stray" pulls registry.example/team/other, which no release in this config builds',
      'error restart: api: restartServices names "ghost", absent from compose.yaml',
      'error restart: server prod: releaseOverrides.api names service "phantom", absent from compose.yaml',
      'warn post-deploy: api: post-deploy command targets service "worker", absent from compose.yaml',
      'warn health: service "api" is restarted by a release but declares no healthcheck, so --wait will not gate it',
    ])
  })

  test('no registry leaves images alone, and a config without a default export fails', async () => {
    const model: ComposeModel = { services: { db: { image: 'postgres:18' } } }
    const result = await run({ 'release.config.ts': 'export default { deploySyncFiles: [\'./compose.yaml\'], releases: [] }', 'compose.yaml': COMPOSE, '.gitignore': IGNORE }, { 'compose.yaml': model })

    expect(messages(result).filter(line => line.includes('image'))).toEqual([])
    // eslint-disable-next-line ts/await-thenable -- bun types .rejects as void
    await expect(loadConfig(project({ 'release.config.ts': 'export const x = 1' }))).rejects.toThrow('release.config.ts has no default export')
  })

  test('routing belongs in overlays, and composeArgs would drop them', async () => {
    const config = CONFIG('composeArgs: [\'-f\', \'compose.yaml\']').replace('[\'./compose.yaml\']', '[\'./compose.yaml\', \'./compose.prod.yaml\']').replace('servers: []', 'servers: [{ name: \'qualif\', composeArgs: [\'-f\', \'x.yaml\'] }]')
    const base: ComposeModel = { services: { api: { ...HEALTHY.services?.api, ports: ['80:80'], labels: { 'traefik.enable': 'true' } } } }
    const result = await run({ 'release.config.ts': config, 'compose.yaml': COMPOSE, 'compose.prod.yaml': 'services: {}\n', '.gitignore': IGNORE }, { 'compose.yaml': base, 'compose.yaml+compose.prod.yaml': base })

    expect(messages(result)).toEqual([
      'error routing: service "api" publishes ports in compose.yaml; publishing belongs in an overlay',
      'error routing: service "api" carries traefik labels in compose.yaml; routing belongs in an overlay',
      'error routing: composeArgs is set (-f compose.yaml) while 1 overlay(s) exist: -f overrides each server\'s COMPOSE_FILE and drops them',
      'warn routing: server qualif sets composeArgs; prefer its own COMPOSE_FILE',
    ])
  })

  test('bind mounts need to appear in the header', async () => {
    const model: ComposeModel = { services: { api: { ...HEALTHY.services?.api, volumes: [{ source: './data/db' }, './secrets:/run/secrets', { source: 'named' }, './data/db:/x'] } } }
    const result = await run({ 'release.config.ts': CONFIG(), 'compose.yaml': COMPOSE, '.gitignore': IGNORE }, { 'compose.yaml': model })

    expect(messages(result)).toEqual(['warn layout: service "api" bind-mounts ./secrets, absent from the header\'s expected server layout'])
  })

  test('bind mounts resolved to absolute paths are checked against the header too', async () => {
    const root = project({ 'release.config.ts': CONFIG(), 'compose.yaml': COMPOSE, '.gitignore': IGNORE })
    const config = (await import(join(root, 'release.config.ts')) as { default: Parameters<typeof runAudit>[0] }).default
    const model: ComposeModel = { services: { api: { ...HEALTHY.services?.api, volumes: [{ source: join(root, 'data/db') }, { source: join(root, 'secrets') }, { source: '/etc/localtime' }] } } }
    const result = await runAudit(config, { root, loadCompose: models({ 'compose.yaml': model }), env: {}, home: '/nonexistent-home' })

    expect(messages(result)).toEqual(['warn layout: service "api" bind-mounts ./secrets, absent from the header\'s expected server layout'])
  })

  test('a failing docker compose config is an error and the checks carry on', async () => {
    const result = await run({ 'release.config.ts': CONFIG(), 'compose.yaml': COMPOSE }, {})

    expect(messages(result)).toEqual([
      'error compose: docker compose config failed for compose.yaml: no such service',
      'warn gitignore: .release-logs/ is not in .gitignore',
      'warn gitignore: .release-worktrees/ is not in .gitignore',
    ])
  })

  test('Nuxt: the resolved schema wins, nuxt.config.ts is only a warning', async () => {
    const config = `export default { registry: 'registry.example/team', deploySyncFiles: ['./compose.yaml'], requiredServerEnv: ['DB_PASSWORD'], releases: [{ slug: 'api', image: 'api', buildContext: 'web', versionEnv: 'API_VERSION', restartServices: ['api'] }] }`
    const model: ComposeModel = { services: { api: { ...HEALTHY.services?.api, environment: { NUXT_SECRET_KEY: 'x', NUXT_PUBLIC_API_BASE: 'y', NUXT_ROGUE: 'z', OTHER: '1' } } } }
    const schema = 'interface SharedRuntimeConfig { secretKey: string, nested: { deepKey: string } }\ninterface SharedPublicRuntimeConfig { apiBase: string }\n'
    const base = { 'release.config.ts': config, 'compose.yaml': COMPOSE, '.gitignore': IGNORE, 'web/nuxt.config.ts': 'export default defineNuxtConfig({ runtimeConfig: { secretKey: "", public: { apiBase: "" } } })' }

    const resolved = await run({ ...base, 'web/.nuxt/types/schema.d.ts': schema }, { 'compose.yaml': model })

    expect(messages(resolved)).toEqual(['error nuxt: service "api" sets NUXT_ROGUE, which matches no runtimeConfig key in web/.nuxt/types/schema.d.ts'])

    const parsed = await run(base, { 'compose.yaml': model })

    expect(messages(parsed)).toEqual(['warn nuxt: service "api" sets NUXT_ROGUE, which matches no runtimeConfig key in web/nuxt.config.ts (run `nuxt prepare` in web for the resolved config, modules included)'])
  })
})

describe('stack audit', () => {
  test('exits 2 without a release.config.ts', async () => {
    const root = project({ 'compose.yaml': COMPOSE })

    // eslint-disable-next-line ts/await-thenable -- bun types .rejects as void
    await expect(capture(async () => audit([root]))).rejects.toThrow(`no release.config.ts in ${root}`)
  })

  test('exits 1 on errors and prints them, 0 on warnings only', async () => {
    const root = project({ 'release.config.ts': CONFIG(), 'compose.yaml': COMPOSE.replace('${API_VERSION}', '1') })
    const failing = await capture(async () => audit([root], { loadCompose: models({ 'compose.yaml': HEALTHY }) }))

    expect(failing.result).toBe(1)
    expect(failing.out).toContain('Errors\n  error: [version] versionEnv API_VERSION is never interpolated by a compose file')
    expect(failing.out).toContain('Warnings\n  warning: [gitignore] .release-logs/ is not in .gitignore')
    expect(failing.out).toContain('1 error(s), 2 warning(s)')

    const quiet = project({ 'release.config.ts': CONFIG(), 'compose.yaml': COMPOSE, '.gitignore': '.release-logs\n' })
    const warned = await capture(async () => audit([quiet], { loadCompose: models({ 'compose.yaml': HEALTHY }) }))

    expect(warned.result).toBe(0)
    expect(warned.out).toContain('0 error(s), 1 warning(s)')
  })

  test('--json prints the result', async () => {
    const root = project({ 'release.config.ts': CONFIG(), 'compose.yaml': COMPOSE, '.gitignore': IGNORE })
    const { result, out } = await capture(async () => audit(['--json', root], { loadCompose: models({ 'compose.yaml': HEALTHY }) }))

    expect(result).toBe(0)
    expect(JSON.parse(out)).toEqual({ root, composeFiles: ['compose.yaml'], findings: [] })
  })
})
