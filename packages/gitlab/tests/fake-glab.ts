import type { Job, Pipeline } from '../src/pipelines'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

// A call whose endpoint contains `match` fails `times` times (always when unset) with `message`.
export interface FakeFailure { match: string, message: string, times?: number }
// Calls whose arguments contain `match` wait until `parties` of them arrived, so two sessions reach that step together.
export interface FakeBarrier { match: string, parties: number }
export interface FakeState { pipelines: Pipeline[], jobs?: Record<number, Job[]>, traces?: Record<number, string>, calls?: string[], failures?: FakeFailure[], barrier?: FakeBarrier }

// A stand-in for the `glab` binary answering `glab api` from a JSON file, failing as glab does on a 404.
const SCRIPT = `#!/usr/bin/env bun
import { appendFileSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs'

const file = process.env.FAKE_GLAB_STATE
const raw = process.argv.slice(2)
const method = raw[1] === '--method' ? raw[2] : 'GET'
const [command, endpoint] = raw[1] === '--method' ? [raw[0], raw[3]] : raw
const sleep = ms => new Promise(done => setTimeout(done, ms))
const barrier = JSON.parse(readFileSync(file, 'utf8')).barrier

// Matching calls wait here until \`parties\` of them arrived, so two sessions reach the same step together.
if (barrier !== undefined && raw.join(' ').includes(barrier.match)) {
  appendFileSync(file + '.barrier', 'x')

  for (let waited = 0; waited < 10000 && readFileSync(file + '.barrier', 'utf8').length < barrier.parties; waited += 5)
    await sleep(5)
}

// One call at a time reads and writes the state.
const lock = file + '.lock'

for (;;) {
  try {
    mkdirSync(lock)
    break
  }
  catch {
    await sleep(5)
  }
}

process.on('exit', () => {
  try {
    rmdirSync(lock)
  }
  catch {}
})

const state = JSON.parse(readFileSync(file, 'utf8'))

state.calls = [...(state.calls ?? []), method === 'GET' ? endpoint : method + ' ' + endpoint]
writeFileSync(file, JSON.stringify(state))

if (command !== 'api') {
  console.error('fake glab: unhandled ' + raw.join(' '))
  process.exit(1)
}

// Like glab, flags are read only before the endpoint: one after it is taken for a second endpoint.
if (raw.slice(method === 'GET' ? 2 : 4).some(arg => arg.startsWith('-') && arg !== '-')) {
  console.error('glab: only one endpoint is accepted, got ' + raw.slice(2).join(' '))
  process.exit(1)
}

const failing = (state.failures ?? []).find(each => endpoint.includes(each.match) && each.times !== 0)

// A scripted failure, as glab prints it: GitLab's error object on stdout and its summary on stderr.
if (failing !== undefined) {
  failing.times = failing.times === undefined ? undefined : failing.times - 1
  writeFileSync(file, JSON.stringify(state))
  console.log(JSON.stringify({ message: failing.message }))
  console.error('glab: ' + failing.message)
  process.exit(1)
}

// A page of a list as GitLab serves it: at most 100 to a page.
function paged(list, params) {
  const size = Math.min(Number(params.get('per_page') ?? 20), 100)
  const from = (Number(params.get('page') ?? 1) - 1) * size

  return list.slice(from, from + size)
}

const [path, query = ''] = endpoint.replace(/^projects\\/[^/]+\\//, '').split('?')
const params = new URLSearchParams(query)
const one = /^pipelines\\/(\\d+)(\\/jobs|\\/retry)?$/.exec(path)
const retried = /^jobs\\/(\\d+)\\/retry$/.exec(path)
const trace = /^jobs\\/(\\d+)\\/trace$/.exec(path)
const pipeline = one === null ? undefined : state.pipelines.find(each => each.id === Number(one[1]))

if (retried !== null || (one !== null && one[2] === '/retry')) {
  const target = retried === null ? pipeline : Object.values(state.jobs ?? {}).flat().find(each => each.id === Number(retried[1]))

  if (method !== 'POST' || target === undefined) {
    console.log('{"message":"404 Not found"}')
    console.error('glab: 404 Not found (HTTP 404)')
    process.exit(1)
  }

  console.log(JSON.stringify({ ...target, status: 'running' }))
}
else if (path === 'pipelines')
  console.log(JSON.stringify(paged(state.pipelines.filter(each => (!params.has('sha') || each.sha === params.get('sha')) && (!params.has('ref') || each.ref === params.get('ref'))).sort((a, b) => b.id - a.id), params)))
else if (pipeline !== undefined && one[2] === undefined)
  console.log(JSON.stringify(pipeline))
else if (pipeline !== undefined)
  console.log(JSON.stringify(paged(state.jobs?.[pipeline.id] ?? [], params)))
else if (trace !== null && state.traces?.[trace[1]] !== undefined)
  process.stdout.write(state.traces[trace[1]])
else {
  console.log('{"message":"404 Not found"}')
  console.error('glab: 404 Not found (HTTP 404)')
  process.exit(1)
}
`

function restore(name: string, value: string | undefined): void {
  if (value === undefined)
    Reflect.deleteProperty(process.env, name)
  else
    process.env[name] = value
}

export function pipeline(id: number, sha: string, status: string, ref = 'main'): Pipeline {
  return { id, iid: id, sha, ref, status, source: 'push', created_at: '2026-10-29T10:00:00Z', updated_at: '2026-10-29T10:02:05Z', web_url: `https://gitlab/p/${id}` }
}

export function job(id: number, name: string, status: string, settings: Partial<Job> = {}): Job {
  return { id, name, stage: 'test', status, allow_failure: false, tag_list: [], web_url: `https://gitlab/j/${id}`, ...settings }
}

export interface Captured { out: string[], err: string[] }

// Runs the callback with the fake `glab` first on the PATH and the console captured, then returns what it printed and the endpoints called.
export async function withFakeGlab(initial: FakeState, run: () => Promise<unknown>): Promise<Captured & { calls: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'gl-fake-glab-'))
  const state = join(dir, 'state.json')
  const bin = join(dir, 'glab')
  const saved = { path: process.env.PATH, state: process.env.FAKE_GLAB_STATE, log: console.log, error: console.error }
  const captured: Captured = { out: [], err: [] }

  try {
    await Bun.write(state, JSON.stringify(initial))
    await Bun.write(bin, SCRIPT)
    await chmod(bin, 0o755)
    process.env.PATH = `${dir}:${saved.path ?? ''}`
    process.env.FAKE_GLAB_STATE = state
    console.log = (line: string) => captured.out.push(line)
    console.error = (line: string) => captured.err.push(line)
    await run()

    return { ...captured, calls: (await Bun.file(state).json() as FakeState).calls ?? [] }
  }
  finally {
    console.log = saved.log
    console.error = saved.error
    restore('PATH', saved.path)
    restore('FAKE_GLAB_STATE', saved.state)
    await rm(dir, { recursive: true, force: true })
  }
}
