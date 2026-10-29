import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

export interface FakeIssue { number: number, title: string, body: string, state: string, labels?: { name: string }[] }
export interface FakeState { issues: FakeIssue[], comments?: Record<number, string[]>, runs?: Record<string, unknown>[], calls?: string[][] }

// A stand-in for the `tea` binary keeping issues in a JSON file, refusing the flag tea 0.15 lacks.
const SCRIPT = `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'

const file = process.env.FAKE_TEA_STATE
const state = JSON.parse(readFileSync(file, 'utf8'))
const args = process.argv.slice(2).filter((arg, at, all) => arg !== '--repo' && all[at - 1] !== '--repo')
const flag = name => { const at = args.indexOf(name); return at === -1 ? undefined : args[at + 1] }
const issue = number => state.issues.find(each => each.number === Number(number))
const view = found => ({ labels: [], comments: state.comments?.[found.number]?.length ?? 0, html_url: 'https://forge/issues/' + found.number, ...found })

state.calls = [...(state.calls ?? []), args]

if (args.includes('--description-file')) {
  console.error('Error: flag provided but not defined: -description-file')
  process.exit(1)
}

const [command, sub, number] = args

if (command === 'api') {
  const path = sub.replace('repos/{owner}/{repo}/', '')
  const run = /^actions\\/runs\\/(\\d+)$/.exec(path)
  const one = /^issues\\/(\\d+)(\\/comments)?$/.exec(path)
  const found = one === null ? undefined : issue(one[1])

  if (run !== null)
    console.log(JSON.stringify(state.runs?.find(each => each.id === Number(run[1])) ?? { message: 'not found', url: '' }))
  else if (path.startsWith('issues?'))
    console.log(JSON.stringify(state.issues.filter(each => each.state === 'open').map(view)))
  else if (found === undefined)
    console.log(JSON.stringify({ message: 'not found', url: '' }))
  else if (one[2] === undefined)
    console.log(JSON.stringify(view(found)))
  else
    console.log(JSON.stringify((state.comments?.[found.number] ?? []).map(body => ({ body, created_at: '2026-10-23T10:00:00Z', user: { login: 'kaynooo' } }))))
}
else if (command === 'issues' && sub === 'edit') {
  const found = issue(number)

  found.body = flag('-d') ?? flag('--description') ?? found.body
  found.title = flag('-t') ?? flag('--title') ?? found.title
}
else if (command === 'issues' && sub === 'create') {
  const created = { number: Math.max(0, ...state.issues.map(each => each.number)) + 1, title: flag('-t'), body: flag('-d') ?? '', state: 'open', labels: (flag('-L') ?? '').split(',').filter(Boolean).map(name => ({ name })) }

  state.issues.push(created)
  console.log('#' + created.number + ' ' + created.title + '\\nhttps://forge/issues/' + created.number)
}
else if (command === 'issues' && sub === 'close') {
  issue(number).state = 'closed'
}
else if (command === 'comment') {
  state.comments = { ...state.comments, [number]: [...(state.comments?.[number] ?? []), args[2]] }
}
else {
  console.error('fake tea: unhandled ' + args.join(' '))
  process.exit(1)
}

writeFileSync(file, JSON.stringify(state))
`

function restore(name: string, value: string | undefined): void {
  if (value === undefined)
    Reflect.deleteProperty(process.env, name)
  else
    process.env[name] = value
}

// Runs the callback with the fake `tea` first on the PATH, then returns the state it left.
export async function withFakeTea(initial: FakeState, run: () => Promise<void>): Promise<FakeState> {
  const dir = await mkdtemp(join(tmpdir(), 'ft-fake-tea-'))
  const state = join(dir, 'state.json')
  const bin = join(dir, 'tea')
  const saved = { path: process.env.PATH, state: process.env.FAKE_TEA_STATE }

  try {
    await Bun.write(state, JSON.stringify(initial))
    await Bun.write(bin, SCRIPT)
    await chmod(bin, 0o755)
    process.env.PATH = `${dir}:${saved.path ?? ''}`
    process.env.FAKE_TEA_STATE = state
    await run()

    return await Bun.file(state).json() as FakeState
  }
  finally {
    restore('PATH', saved.path)
    restore('FAKE_TEA_STATE', saved.state)
    await rm(dir, { recursive: true, force: true })
  }
}
