import { existsSync } from 'node:fs'
import { chmod, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { Exit } from '@kaynooo/cli-kit'

export interface FakeIssue { number: number, title: string, body: string, state: string, labels?: { name: string }[], milestone?: { id: number, title: string } | null | undefined }
export interface FakeMilestone { id: number, title: string, state: string, description?: string, due_on?: string | null }
// A call whose arguments contain `match` fails `times` times (always when unset): with tea's exit-0 error object, or with a non-zero `exit` and `message` on stderr.
export interface FakeFailure { match: string, message: string, times?: number, exit?: number }
// Calls whose arguments contain `match` (and `method`) wait until `parties` of them arrived, so two sessions reach that step together.
export interface FakeBarrier { match: string, method?: string, parties: number }
export interface FakeState { issues: FakeIssue[], milestones?: FakeMilestone[], comments?: Record<number, string[]>, runs?: Record<string, unknown>[], jobs?: Record<number, unknown[]>, logs?: Record<number, string>, calls?: string[][], labels?: string[], seen?: { token?: string, host?: string }[], clobber?: Record<number, string>, beforeComment?: Record<number, string[]>, afterComment?: Record<number, string[]>, failures?: FakeFailure[], barrier?: FakeBarrier }

// A stand-in for the `tea` binary keeping issues in a JSON file, refusing the flag tea 0.15 lacks.
const SCRIPT = `#!/usr/bin/env bun
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs'

const file = process.env.FAKE_TEA_STATE
const raw = process.argv.slice(2)
const gt = process.argv[1].endsWith('/gt')
// gt prints an error body and exits non-zero where tea exits 0.
const reject = body => { console.log(JSON.stringify(body)); if (gt) process.exit(1) }
const repoAt = raw.indexOf('--repo')
const barrier = JSON.parse(readFileSync(file, 'utf8')).barrier

// Matching calls wait here until \`parties\` of them arrived, so two sessions reach the same step together.
if (barrier !== undefined && raw.join(' ').includes(barrier.match) && (barrier.method === undefined || raw.includes(barrier.method))) {
  appendFileSync(file + '.barrier', 'x')

  for (let waited = 0; waited < 10000 && readFileSync(file + '.barrier', 'utf8').length < barrier.parties; waited += 5)
    await Bun.sleep(5)
}

// One call at a time reads and writes the state, as the server serialises its writes.
const lock = file + '.lock'

// Only a held lock is waited for, and not forever: a test that removed its temp dir meanwhile makes mkdirSync fail with ENOENT for good.
for (let waited = 0; ; waited += 5) {
  try {
    mkdirSync(lock)
    break
  }
  catch (error) {
    if (error.code !== 'EEXIST' || waited >= 20000) {
      console.error('fake tea: ' + error.message)
      process.exit(1)
    }

    await Bun.sleep(5)
  }
}

process.on('exit', () => {
  try {
    rmdirSync(lock)
  }
  catch {}
})

const state = JSON.parse(readFileSync(file, 'utf8'))
const RUN_JOBS = /^actions\\/runs\\/\\d+\\/jobs$/
const JOB_LOGS = /^actions\\/jobs\\/\\d+\\/logs$/
const VALUE_FLAGS = new Set(['-X', '-f', '-F', '-H', '--repo'])

// Like tea, an api call reads flags only before its path: one after it is taken for another argument.
function flagAfterPath() {
  let seenPath = false

  for (let at = 1; at < raw.length; at++) {
    if (raw[at].startsWith('-') && raw[at] !== '-') {
      if (seenPath)
        return raw[at]

      if (VALUE_FLAGS.has(raw[at]))
        at++
    }
    else
      seenPath = true
  }

  return undefined
}

// A page of a list as Forgejo serves it: at most 50 to a page.
function paged(list, query) {
  const size = Math.min(Number(query.get('limit') ?? 30), 50)
  const from = (Number(query.get('page') ?? 1) - 1) * size

  return list.slice(from, from + size)
}

// Like tea, a flag has to come before the positionals: one after a bare number is taken for another positional.
if (repoAt !== -1 && raw.slice(0, repoAt).some(arg => /^\\d+$/.test(arg))) {
  console.error('Error: --repo placed after a positional argument')
  process.exit(1)
}

const args = raw.filter((arg, at, all) => arg !== '--repo' && all[at - 1] !== '--repo')
const flag = name => { const at = args.indexOf(name); return at === -1 ? undefined : args[at + 1] }
const issue = number => state.issues.find(each => each.number === Number(number))
const milestoneNamed = name => state.milestones?.find(each => each.title === name)
const milestoneView = found => ({ description: '', due_on: null, ...found, open_issues: state.issues.filter(each => each.milestone?.id === found.id && each.state === 'open').length, closed_issues: state.issues.filter(each => each.milestone?.id === found.id && each.state === 'closed').length })
const view = found => ({ labels: [], comments: state.comments?.[found.number]?.length ?? 0, html_url: 'https://forge/issues/' + found.number, ...found })

state.calls = [...(state.calls ?? []), args]

if (gt) {
  state.seen = [...(state.seen ?? []), { token: process.env.GITEA_TOKEN, host: process.env.GITEA_CLI_HOST }]

  if (args[0] !== 'api') {
    console.error('gt: unknown command ' + args[0])
    process.exit(1)
  }
}

if (args.includes('--description-file')) {
  console.error('Error: flag provided but not defined: -description-file')
  process.exit(1)
}

const [command, sub, number] = args
const late = command === 'api' ? flagAfterPath() : undefined
const failing = (state.failures ?? []).find(each => args.join(' ').includes(each.match) && each.times !== 0)

if (late !== undefined) {
  console.error('Error: too many arguments, ' + late + ' came after the path')
  process.exit(1)
}

// A scripted failure: tea's exit-0 error object, or a real non-zero exit when \`exit\` is set.
if (failing !== undefined) {
  failing.times = failing.times === undefined ? undefined : failing.times - 1
  writeFileSync(file, JSON.stringify(state))

  if (failing.exit === undefined) {
    reject({ message: failing.message, url: 'https://forge/api/swagger' })
    process.exit(0)
  }

  console.error(failing.message)
  process.exit(failing.exit)
}

if (command === 'api') {
  const path = args.at(-1).replace('repos/{owner}/{repo}/', '')
  const method = flag('-X') ?? 'GET'
  const fields = Object.fromEntries(args.flatMap((arg, at) => arg === '-f' ? [args[at + 1].split(/=(.*)/s).slice(0, 2)] : arg === '-F' ? [[args[at + 1].split('=')[0], JSON.parse(args[at + 1].slice(args[at + 1].indexOf('=') + 1))]] : []))

  const milestone = /^milestones\\/(\\d+)$/.exec(path)
  const query = new URLSearchParams(path.split('?')[1] ?? '')
  const run = /^actions\\/runs\\/(\\d+)$/.exec(path)
  const one = /^issues\\/(\\d+)(\\/comments)?$/.exec(path)
  const labelsOf = /^issues\\/(\\d+)\\/labels(?:\\/(\\d+))?$/.exec(path)
  const found = one === null ? undefined : issue(one[1])
  const labelName = id => (state.labels ?? [])[Number(id) - 1]

  if (path === 'user')
    console.log(JSON.stringify({ login: 'kaynooo' }))
  else if (labelsOf !== null && method === 'POST') {
    const target = issue(labelsOf[1])

    target.labels = [...(target.labels ?? []), ...fields.labels.map(id => ({ name: labelName(id) }))]
    console.log(JSON.stringify(target.labels))
  }
  else if (labelsOf !== null && method === 'DELETE') {
    const target = issue(labelsOf[1])

    target.labels = (target.labels ?? []).filter(each => each.name !== labelName(labelsOf[2]))
  }
  else if (path === 'issues' && method === 'POST') {
    const created = { number: Math.max(0, ...state.issues.map(each => each.number)) + 1, title: fields.title, body: fields.body ?? '', state: 'open', labels: (fields.labels ?? []).map(id => ({ name: labelName(id) })), milestone: fields.milestone ? state.milestones.find(each => each.id === fields.milestone) : null }

    state.issues.push(created)
    console.log(JSON.stringify(view(created)))
  }
  else if (one !== null && one[2] === undefined && method === 'PATCH' && found !== undefined) {
    if (fields.title !== undefined) found.title = fields.title
    if (fields.body !== undefined) found.body = fields.body
    if (fields.state !== undefined) found.state = fields.state
    if (fields.milestone !== undefined) found.milestone = fields.milestone === 0 ? null : state.milestones.find(each => each.id === fields.milestone)
    console.log(JSON.stringify(view(found)))
  }
  else if (one !== null && one[2] !== undefined && method === 'POST') {
    // Other sessions' comments landing right before or after the first one posted here, once.
    state.comments = { ...state.comments, [one[1]]: [...(state.comments?.[one[1]] ?? []), ...(state.beforeComment?.[one[1]] ?? []), fields.body, ...(state.afterComment?.[one[1]] ?? [])] }
    delete state.beforeComment?.[one[1]]
    delete state.afterComment?.[one[1]]
    console.log(JSON.stringify({ id: 1, body: fields.body }))
  }
  else if (run !== null)
    { const found = state.runs?.find(each => each.id === Number(run[1])); if (found === undefined) reject({ message: 'not found', url: '' }); else console.log(JSON.stringify(found)) }
  else if (RUN_JOBS.test(path))
    console.log(JSON.stringify(state.jobs?.[path.split('/')[2]] ?? []))
  else if (JOB_LOGS.test(path) && state.logs?.[path.split('/')[2]] !== undefined)
    console.log(state.logs?.[path.split('/')[2]] ?? '')
  else if (path.startsWith('actions/runs?')) {
    const matching = (state.runs ?? []).filter(each => (!query.has('head_sha') || each.commit_sha === query.get('head_sha')) && (!query.has('workflow_id') || each.workflow_id === query.get('workflow_id')))

    console.log(JSON.stringify({ workflow_runs: paged(matching, query), total_count: matching.length }))
  }
  else if (path.startsWith('labels?'))
    console.log(JSON.stringify(paged((state.labels ?? []).map((name, at) => ({ id: at + 1, name })), query)))
  else if (path.startsWith('milestones?'))
    console.log(JSON.stringify(paged((state.milestones ?? []).filter(each => query.get('state') === 'all' || each.state === query.get('state')).map(milestoneView), query)))
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
  else if (path.startsWith('issues?')) {
    const matching = state.issues.filter(each => each.state === query.get('state') && (!query.has('milestones') || each.milestone?.id === Number(query.get('milestones')))).map(view)

    console.log(JSON.stringify(query.has('page') || query.has('limit') ? paged(matching, query) : matching))
  }
  else if (found === undefined)
    reject({ message: 'not found', url: '' })
  else if (one[2] === undefined)
    console.log(JSON.stringify(view(found)))
  else
    console.log(JSON.stringify((state.comments?.[found.number] ?? []).map(body => ({ body, created_at: '2026-10-23T10:00:00Z', user: { login: 'kaynooo' } }))))
}
else if (command === 'issues' && sub === 'edit') {
  const found = issue(number)

  found.body = flag('-d') ?? flag('--description') ?? found.body

  // Another writer's save landing right after this one, once, so the write is lost.
  if (flag('-d') !== undefined && state.clobber?.[number] !== undefined) {
    found.body = state.clobber[number]
    delete state.clobber[number]
  }

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
export async function withFakeTea(initial: FakeState, run: () => Promise<unknown>, binary = 'tea'): Promise<FakeState> {
  const dir = await mkdtemp(join(tmpdir(), 'ft-fake-tea-'))
  const state = join(dir, 'state.json')
  const bin = join(dir, binary)
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

// The same fake as the `gt` binary, which has no tea subcommands and fails on an error answer; tea is left out of the PATH it runs under.
// A folder holding a real tea (/usr/bin on a machine with tea installed) holds git too, which ft still runs: git comes back through a folder of its own.
export async function withFakeGt(initial: FakeState, run: () => Promise<unknown>): Promise<FakeState> {
  const saved = process.env.PATH
  const git = Bun.which('git')
  const gitDir = await mkdtemp(join(tmpdir(), 'ft-git-'))

  if (git !== null)
    await symlink(git, join(gitDir, 'git'))

  try {
    process.env.PATH = [...(saved ?? '').split(':').filter(dir => !existsSync(join(dir, 'tea'))), gitDir].join(':')

    return await withFakeTea(initial, run, 'gt')
  }
  finally {
    restore('PATH', saved)
    await rm(gitDir, { recursive: true, force: true })
  }
}
