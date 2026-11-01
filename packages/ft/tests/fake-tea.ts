import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { Exit } from '@kaynooo/cli-kit'

export interface FakeIssue { number: number, title: string, body: string, state: string, labels?: { name: string }[], milestone?: { id: number, title: string } | null | undefined }
export interface FakeMilestone { id: number, title: string, state: string, description?: string, due_on?: string | null }
export interface FakeState { issues: FakeIssue[], milestones?: FakeMilestone[], comments?: Record<number, string[]>, runs?: Record<string, unknown>[], calls?: string[][], labels?: string[] }

// A stand-in for the `tea` binary keeping issues in a JSON file, refusing the flag tea 0.15 lacks.
const SCRIPT = `#!/usr/bin/env bun
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

const file = process.env.FAKE_TEA_STATE
const state = JSON.parse(readFileSync(file, 'utf8'))
const args = process.argv.slice(2).filter((arg, at, all) => arg !== '--repo' && all[at - 1] !== '--repo')
const flag = name => { const at = args.indexOf(name); return at === -1 ? undefined : args[at + 1] }
const issue = number => state.issues.find(each => each.number === Number(number))
const milestoneNamed = name => state.milestones?.find(each => each.title === name)
const milestoneView = found => ({ description: '', due_on: null, ...found, open_issues: state.issues.filter(each => each.milestone?.id === found.id && each.state === 'open').length, closed_issues: state.issues.filter(each => each.milestone?.id === found.id && each.state === 'closed').length })
const view = found => ({ labels: [], comments: state.comments?.[found.number]?.length ?? 0, html_url: 'https://forge/issues/' + found.number, ...found })

state.calls = [...(state.calls ?? []), args]

if (args.includes('--description-file')) {
  console.error('Error: flag provided but not defined: -description-file')
  process.exit(1)
}

const [command, sub, number] = args

if (command === 'api') {
  const path = args.at(-1).replace('repos/{owner}/{repo}/', '')
  const method = flag('-X') ?? 'GET'
  const fields = Object.fromEntries(args.flatMap((arg, at) => arg === '-f' ? [args[at + 1].split(/=(.*)/s).slice(0, 2)] : []))
  const milestone = /^milestones\\/(\\d+)$/.exec(path)
  const query = new URLSearchParams(path.split('?')[1] ?? '')
  const run = /^actions\\/runs\\/(\\d+)$/.exec(path)
  const one = /^issues\\/(\\d+)(\\/comments)?$/.exec(path)
  const found = one === null ? undefined : issue(one[1])

  if (run !== null)
    console.log(JSON.stringify(state.runs?.find(each => each.id === Number(run[1])) ?? { message: 'not found', url: '' }))
  else if (/^actions\\/runs\\/\\d+\\/jobs$/.test(path))
    console.log('[]')
  else if (path.startsWith('actions/runs?'))
    console.log(JSON.stringify({ workflow_runs: state.runs ?? [] }))
  else if (path.startsWith('labels?'))
    console.log(JSON.stringify((state.labels ?? []).map(name => ({ name }))))
  else if (path.startsWith('milestones?'))
    console.log(JSON.stringify((state.milestones ?? []).filter(each => query.get('state') === 'all' || each.state === query.get('state')).map(milestoneView)))
  else if (path === 'milestones' && method === 'POST') {
    const created = { id: Math.max(0, ...(state.milestones ?? []).map(each => each.id)) + 1, state: 'open', description: '', due_on: null, ...fields }

    state.milestones = [...(state.milestones ?? []), created]
    console.log(JSON.stringify(milestoneView(created)))
  }
  else if (milestone !== null && method === 'PATCH') {
    const target = state.milestones.find(each => each.id === Number(milestone[1]))

    Object.assign(target, fields)
    console.log(JSON.stringify(milestoneView(target)))
  }
  else if (path.startsWith('issues?'))
    console.log(JSON.stringify(state.issues.filter(each => each.state === query.get('state') && (!query.has('milestones') || each.milestone?.id === Number(query.get('milestones')))).map(view)))
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
  const moved = flag('-m') ?? flag('--milestone')

  if (moved !== undefined)
    found.milestone = moved === '' ? null : milestoneNamed(moved)
  const removed = (flag('--remove-labels') ?? '').split(',')
  const added = (flag('--add-labels') ?? '').split(',').filter(Boolean)
  found.labels = [...(found.labels ?? []).filter(each => !removed.includes(each.name)), ...added.filter(name => !(found.labels ?? []).some(each => each.name === name)).map(name => ({ name }))]
}
else if (command === 'issues' && sub === 'create') {
  const created = { number: Math.max(0, ...state.issues.map(each => each.number)) + 1, title: flag('-t'), body: flag('-d') ?? '', state: 'open', labels: (flag('-L') ?? '').split(',').filter(Boolean).map(name => ({ name })), milestone: flag('-m') === undefined ? null : milestoneNamed(flag('-m')) }

  state.issues.push(created)
  console.log('#' + created.number + ' ' + created.title + '\\nhttps://forge/issues/' + created.number)
}
else if (command === 'issues' && sub === 'close') {
  issue(number).state = 'closed'
}
else if (command === 'issues' && sub === 'reopen') {
  issue(number).state = 'open'
}
else if (command === 'comment') {
  state.comments = { ...state.comments, [sub]: [...(state.comments?.[sub] ?? []), args[2]] }
}
else {
  console.error('fake tea: unhandled ' + args.join(' '))
  process.exit(1)
}

// Calls run in parallel, so a rename keeps a reader from seeing the file half written.
writeFileSync(file + process.pid, JSON.stringify(state))
renameSync(file + process.pid, file)
`

// What a rejected promise says, or an empty string when it resolved.
export async function refusal(pending: Promise<unknown>): Promise<string> {
  try {
    await pending

    return ''
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

// The hint a refusal carries, or an empty string when it resolved or had none.
export async function hintOf(pending: Promise<unknown>): Promise<string> {
  try {
    await pending

    return ''
  }
  catch (error) {
    return error instanceof Exit ? error.hint ?? '' : ''
  }
}

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
