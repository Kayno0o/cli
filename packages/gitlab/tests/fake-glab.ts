import type { Job, Pipeline } from '../src/pipelines'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

export interface FakeState { pipelines: Pipeline[], jobs?: Record<number, Job[]>, traces?: Record<number, string>, calls?: string[] }

// A stand-in for the `glab` binary answering `glab api` from a JSON file, failing as glab does on a 404.
const SCRIPT = `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'

const file = process.env.FAKE_GLAB_STATE
const state = JSON.parse(readFileSync(file, 'utf8'))
const [command, endpoint] = process.argv.slice(2)

state.calls = [...(state.calls ?? []), endpoint]
writeFileSync(file, JSON.stringify(state))

if (command !== 'api') {
  console.error('fake glab: unhandled ' + process.argv.slice(2).join(' '))
  process.exit(1)
}

const [path, query = ''] = endpoint.replace(/^projects\\/[^/]+\\//, '').split('?')
const params = new URLSearchParams(query)
const one = /^pipelines\\/(\\d+)(\\/jobs)?$/.exec(path)
const trace = /^jobs\\/(\\d+)\\/trace$/.exec(path)
const pipeline = one === null ? undefined : state.pipelines.find(each => each.id === Number(one[1]))

if (path === 'pipelines')
  console.log(JSON.stringify(state.pipelines.filter(each => (!params.has('sha') || each.sha === params.get('sha')) && (!params.has('ref') || each.ref === params.get('ref'))).sort((a, b) => b.id - a.id).slice(0, Number(params.get('per_page') ?? 20))))
else if (pipeline !== undefined && one[2] === undefined)
  console.log(JSON.stringify(pipeline))
else if (pipeline !== undefined)
  console.log(JSON.stringify(state.jobs?.[pipeline.id] ?? []))
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
