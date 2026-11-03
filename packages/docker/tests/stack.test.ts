import type { Service, Stack } from '../src/stack'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { target } from '../src/dc'
import { commandFor, containers, holdsStack, key, labelled, labelledStack } from '../src/stack'

const stack = (dir: string): Stack => ({ dir, run: dir === '.' ? ['docker', 'compose'] : ['env', '-C', dir, 'docker', 'compose'], list: { argv: [], cwd: dir, env: {} } })
const service = (name: string, dir = '.'): Service => ({ stack: stack(dir), project: 'app', name, state: 'running', status: '', ports: '', image: '' })

describe('containers', () => {
  test('reads one container per line, and the JSON array older versions printed', () => {
    expect(containers('{"Service":"php","State":"running","Status":"Up"}\n{"Service":"db","State":"exited","Status":"Exited"}').map(found => found.Service)).toEqual(['php', 'db'])
    expect(containers('[{"Service":"php","State":"running","Status":"Up"}]').map(found => found.Service)).toEqual(['php'])
    expect(containers('')).toEqual([])
  })
})

describe('holdsStack', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dx-'))

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('takes a .env setting COMPOSE_FILE for a stack, as compose does, and any other .env for none', () => {
    writeFileSync(join(dir, 'docker-compose.dev.yaml'), 'services: {}\n')
    writeFileSync(join(dir, '.env'), 'APP_PORT=3000\n')
    expect(holdsStack(dir)).toBe(false)

    writeFileSync(join(dir, '.env'), 'APP_PORT=3000\nCOMPOSE_FILE=docker-compose.dev.yaml\n')
    expect(holdsStack(dir)).toBe(true)
  })

  test('takes a compose file compose finds on its own', () => {
    rmSync(join(dir, '.env'))
    expect(holdsStack(dir)).toBe(false)

    writeFileSync(join(dir, 'compose.yaml'), 'services: {}\n')
    expect(holdsStack(dir)).toBe(true)
  })
})

describe('labelled', () => {
  test('keeps one entry per project, with its files, env files and folder', () => {
    const text = [
      'dash\t/w/dash/docker-compose.prod.yaml\t/w/dash/.env.prod\t/w/dash',
      'dash\t/w/dash/docker-compose.prod.yaml\t/w/dash/.env.prod\t/w/dash',
      'site\t/w/site/docker-compose.yml,/w/site/docker-compose.dev.yml\t\t/w/site',
      '\t\t\t',
    ].join('\n')

    expect(labelled(text)).toEqual([
      { project: 'dash', files: ['/w/dash/docker-compose.prod.yaml'], envFiles: ['/w/dash/.env.prod'], workdir: '/w/dash' },
      { project: 'site', files: ['/w/site/docker-compose.yml', '/w/site/docker-compose.dev.yml'], envFiles: [], workdir: '/w/site' },
    ])
  })

  test('runs a stack with the files it came up with, short from its folder, keyed by its project', async () => {
    const recorded = labelledStack('..', { project: 'dash', files: ['/w/dash/docker-compose.prod.yaml'], envFiles: ['/w/dash/.env.prod'], workdir: '/w/dash' })
    const app: Service = { stack: recorded, project: 'dash', name: 'app', state: 'running', status: '', ports: '', image: '' }

    expect(key(app)).toBe('../dash:app')
    expect(recorded.list.argv).toEqual(['docker', 'compose', '-p', 'dash', '-f', '/w/dash/docker-compose.prod.yaml', '--env-file', '/w/dash/.env.prod'])
    expect(await commandFor(app, 'logs')).toEqual(['env', '-C', '..', 'docker', 'compose', '-p', 'dash', '-f', 'docker-compose.prod.yaml', '--env-file', '.env.prod', 'logs', '-f', '--tail=200', 'app'])
  })
})

describe('commandFor', () => {
  test('runs from the folder of a child stack', async () => {
    expect(key(service('worker', 'api'))).toBe('api/worker')
    expect(await commandFor(service('worker', 'api'), 'logs')).toEqual(['env', '-C', 'api', 'docker', 'compose', 'logs', '-f', '--tail=200', 'worker'])
    expect(await commandFor(service('php'), 'build')).toEqual(['docker', 'compose', 'up', '-d', '--build', 'php'])
  })
})

describe('target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dc-'))
  const start = process.cwd()

  afterAll(() => {
    process.chdir(start)
    rmSync(dir, { recursive: true, force: true })
  })

  test('runs plain compose on the stack of the nearest folder holding one', async () => {
    mkdirSync(join(dir, '.git'))
    mkdirSync(join(dir, 'api'))
    writeFileSync(join(dir, 'compose.yaml'), 'services: {}\n')
    process.chdir(join(dir, 'api'))

    const found = await target(['ps', '-a'])

    expect(found.kind === 'stack' && [found.stack.dir, found.stack.list.argv, found.args, found.announce]).toEqual(['..', ['docker', 'compose'], ['ps', '-a'], false])
  })
})
