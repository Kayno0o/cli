import type { Colors, ExitRow } from '@kaynooo/cli-kit'
import type { Arg, Row } from '@kaynooo/cli-kit/picker'
import { basename } from 'node:path'
import process from 'node:process'
import { closest, fail, isInteractive, jsonOption, paint, parse, printJson, takesControlCodes } from '@kaynooo/cli-kit'
import { emit, list, pick, table } from '@kaynooo/cli-kit/picker'

export interface Branch {
  // What git calls it, `feature` or `origin/feature`.
  name: string
  remote: boolean
  // The worktree it is checked out in, when that is not this one.
  worktree: string
  when: string
  subject: string
  // Unix seconds of its last commit.
  date: number
  upstream: string
  // How it stands against its upstream as git words it, `ahead 2, behind 1` or `gone`, empty when even.
  track: string
  // Merged into the base, which `git branch -d` takes as merged unless the branch has an upstream not holding it.
  merged: boolean
}

const usage = `gb [branch]
gb -
gb -c <name>
gb -d <branch>

Without a branch, picks one when a terminal is attached: the branches last checked out first, as the reflog has them, then the other local ones, then the remote ones with no local branch yet. The header says where HEAD stands, each row how its branch stands against its upstream and whether it is merged into the base. enter switches to it (a remote one gets its local tracking branch), ctrl-n creates a branch named after the query, ctrl-d deletes the highlighted local branch with \`git branch -d\`, which refuses one not merged yet, and ctrl-r fetches, prunes and lists again. Without a terminal it lists the branches instead.
\`gb <branch>\` switches without the picker, a bare name finding the remote branch it would create. \`gb -\` goes back to the previous branch, \`gb -c <name>\` creates one and switches to it, \`gb -d <branch>\` deletes a local one.
A branch checked out in another worktree cannot be switched to: gb prints that worktree's path on stdout and a hint on stderr, since a command cannot change its parent shell's folder.`

const EXITS: ExitRow[] = [[0, 'it switched, created, deleted or listed'], ['git', 'the code of the git command it ran, when that failed'], [1, 'there is no branch by that name or nothing was picked'], [2, 'outside a git repository or a usage error']]

const options = {
  create: { type: 'boolean', short: 'c', description: 'create the branch named by the rest of the line and switch to it' },
  delete: { type: 'boolean', short: 'd', description: 'delete the local branch with git branch -d' },
  json: jsonOption('[{ name, remote, worktree, when, subject, date, upstream, track, merged }]'),
} as const

const FIELDS = ['%(refname)', '%(refname:short)', '%(committerdate:unix)', '%(committerdate:relative)', '%(subject)', '%(worktreepath)', '%(upstream:short)', '%(upstream:track,nobracket)']
const CHECKOUT = /^checkout: moving from (\S+) to (\S+)$/
const KEYS = 'enter go, ctrl-n new from query, ctrl-d delete if merged, ctrl-r fetch'
const TRACK_TINTS: Record<string, 'green' | 'red' | 'yellow'> = { ahead: 'green', behind: 'red', gone: 'yellow' }
const TRACK_WORD = /^\w+/
const WHITESPACE = /\s+/

// The picker draws on stderr and previews through a pipe, so its rows and preview are painted whatever stdout is; `paint` still honours `NO_COLOR`.
const colors = paint({ isTTY: true })

function read(args: string[]): string {
  const proc = Bun.spawnSync(['git', ...args], { stderr: 'pipe' })

  return proc.success ? proc.stdout.toString().trim() : ''
}

// The branches in the order they were last checked out, from the newest move: where it went, then where it came from.
export function visited(reflog: string[]): string[] {
  const order = new Set<string>()

  for (const line of reflog) {
    const move = CHECKOUT.exec(line)

    if (move) {
      order.add(move[2]!)
      order.add(move[1]!)
    }
  }

  return [...order]
}

// Local branches by last checkout, then by last commit; then the remote ones no local branch tracks by name, by last commit.
// The current branch is left out, there being nowhere to go.
export function ordered(branches: Branch[], recent: string[], current: string): Branch[] {
  const rank = new Map(recent.map((name, index) => [name, index]))
  const locals = branches.filter(branch => !branch.remote && branch.name !== current)
  const names = new Set(branches.filter(branch => !branch.remote).map(branch => branch.name))
  const remotes = branches.filter(branch => branch.remote && !names.has(localName(branch.name)))
  const byDate = (a: Branch, b: Branch) => b.date - a.date

  return [
    ...locals.filter(branch => rank.has(branch.name)).sort((a, b) => rank.get(a.name)! - rank.get(b.name)!),
    ...locals.filter(branch => !rank.has(branch.name)).sort(byDate),
    ...remotes.sort(byDate),
  ]
}

function localName(remote: string): string {
  return remote.slice(remote.indexOf('/') + 1)
}

// The base itself and its local counterpart are left unmarked, being what the others are merged into.
export function branches(against: string | undefined): Branch[] {
  const here = read(['rev-parse', '--show-toplevel'])
  const lines = read(['for-each-ref', `--format=${FIELDS.join('%00')}`, 'refs/heads', 'refs/remotes']).split('\n').filter(Boolean)
  const merged = new Set(against !== undefined ? read(['branch', '--merged', against, '--format=%(refname:short)']).split('\n') : [])

  // A remote's HEAD only points at its default branch, and goes by the remote's bare name.
  return lines.map(line => line.split('\0')).filter(([ref = '']) => !ref.endsWith('/HEAD')).map(([ref = '', name = '', date = '0', when = '', subject = '', worktree = '', upstream = '', track = '']) => {
    const remote = ref.startsWith('refs/remotes/')

    return {
      name,
      remote,
      worktree: worktree === here ? '' : worktree,
      when,
      subject,
      date: Number(date),
      upstream,
      track,
      merged: !remote && merged.has(name) && name !== against && name !== localName(against ?? ''),
    }
  })
}

// What the log is compared against: the remote's default branch, else a local main or master.
function base(): string | undefined {
  const remote = read(['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'])

  if (remote)
    return remote

  return ['main', 'master'].find(name => read(['rev-parse', '--verify', '-q', `refs/heads/${name}`]) !== '')
}

export function goTo(branch: Branch): Arg[] {
  if (branch.worktree)
    return ['cd', branch.worktree]

  return branch.remote ? ['git', 'switch', '--track', branch.name] : ['git', 'switch', branch.name]
}

// A remote branch is left to `git push --delete`, which this is too quick a key for.
export function remove(branch: Branch): string[] {
  if (branch.remote)
    fail(`${branch.name} is a remote branch, deleting it is left to git push --delete`, 1)

  return ['git', 'branch', '-d', branch.name]
}

// What is wrong with a new branch name, an empty text when git takes it.
export function invalid(name: string): string {
  if (!name)
    return 'Type the name of the new branch first'

  return Bun.spawnSync(['git', 'check-ref-format', '--branch', name], { stdout: 'ignore', stderr: 'ignore' }).success ? '' : `${name} is not a valid branch name`
}

// `ahead 2, behind 1` as `ahead 2 behind 1`, each part in its own color.
export function track(text: string, tint: Colors = colors): string {
  return text.split(', ').filter(Boolean).map(part => tint[TRACK_TINTS[TRACK_WORD.exec(part)?.[0] ?? ''] ?? 'dim'](part)).join(' ')
}

// Where it is checked out or that it is remote, how it stands against its upstream, and whether it is merged.
export function tags(branch: Branch, tint: Colors = colors): string {
  // The folder alone, a full path pushing the subject out of sight.
  const away = branch.remote ? tint.magenta('remote') : ''
  const where = branch.worktree === '' ? away : tint.green(`wt ${basename(branch.worktree)}`)

  return [where, track(branch.track, tint), branch.merged ? tint.cyan('merged') : ''].filter(Boolean).join(' ')
}

// The current branch, or the commit a detached HEAD is on, then its upstream and the tracked files a switch would carry along or refuse over.
export function status(current: Pick<Branch, 'name' | 'upstream' | 'track'> | undefined, head: string, changed: number): string {
  const parts = [current ? `on ${colors.bold(current.name)}` : `${colors.bold('HEAD')} detached at ${head}`]

  if (current?.upstream !== undefined && current.upstream !== '')
    parts.push(`${colors.dim(current.upstream)} ${track(current.track) || 'up to date'}`)

  if (changed)
    parts.push(colors.yellow(`${changed} uncommitted`))

  return parts.join(colors.dim(' | '))
}

function row(branch: Branch): Row {
  // The remote dimmed, the branch it holds standing out as a local one does.
  const name = branch.remote ? `${colors.dim(branch.name.slice(0, branch.name.indexOf('/') + 1))}${colors.magenta(localName(branch.name))}` : branch.name

  return { hidden: [branch.name], cells: [name, colors.dim(branch.when), tags(branch), colors.dim(branch.subject)] }
}

// How far it is from the base, then its own commits, or its last ones when it has none of its own.
function preview(name: string): string {
  const against = base()
  const lines: string[] = []
  const compared = against !== undefined && against !== name

  if (compared) {
    const [behind = '0', ahead = '0'] = read(['rev-list', '--left-right', '--count', `${against}...${name}`]).split(WHITESPACE)

    lines.push(`${colors.green(`${ahead} ahead`)}, ${colors.red(`${behind} behind`)} ${colors.dim(against)}\n`)
  }

  const own = compared ? [`${against}..${name}`] : [name]
  const log = ['log', '--color=always', '--format=%C(auto)%h %s %C(dim)%cr, %an', '-30']

  lines.push(read([...log, ...own]) || read([...log, name]))

  return lines.join('\n')
}

// Every branch as git has it now, the current one apart, and the ones to pick among in order.
function load(): { found: Branch[], current: string, all: Branch[] } {
  const found = branches(base())
  const current = read(['branch', '--show-current'])

  return { found, current, all: ordered(found, visited(read(['reflog', '-n', '2000', '--format=%gs']).split('\n')), current) }
}

// The current branch or the remote one it is the local twin of, which `all` leaves out.
function isCurrent(named: string, current: string, found: Branch[]): boolean {
  return current !== '' && (named === current || found.some(branch => branch.remote && branch.name === named && localName(branch.name) === current))
}

// A branch with no commit yet, in a new repository, is not among the refs but is still the one HEAD is on.
function header(found: Branch[], current: string, failure = ''): string {
  const changed = read(['status', '--porcelain', '--untracked-files=no']).split('\n').filter(Boolean).length
  const here = found.find(branch => !branch.remote && branch.name === current) ?? (current ? { name: current, upstream: '', track: '' } : undefined)
  const line = status(here, here ? '' : read(['rev-parse', '--short', 'HEAD']), changed)

  return `${line}${failure ? colors.dim(' | ') + colors.red(failure) : ''}\n${KEYS}`
}

// Fetches and prunes every remote, then the header with where HEAD stands, saying when the fetch failed.
async function fetched(): Promise<string> {
  const proc = Bun.spawn(['git', 'fetch', '--all', '--prune', '--quiet'], { stdout: 'ignore', stderr: 'ignore' })
  const success = await proc.exited === 0

  return header(branches(base()), read(['branch', '--show-current']), success ? '' : 'fetch failed')
}

function listed(all: Branch[]): void {
  list([
    ...all.map(branch => ({
      label: branch.name,
      hint: [branch.track, branch.when, branch.subject].filter(Boolean).join(' · '),
      typed: branch.name,
      preview: ['--show', branch.name],
      actions: [
        ...branch.remote ? [] : [{ label: 'Delete', key: 'ctrl-d', typed: `-d ${branch.name}` }],
        { label: 'Fetch', key: 'ctrl-r', reload: ['--fetch'] },
      ],
    })),
    { label: 'New branch', hint: 'git switch -c', typed: '-c', asks: '' },
  ])
}

// The hidden flags term, tmux and the shell completions call, each printing and nothing more.
async function hidden(flag: string, rest: string[]): Promise<number | undefined> {
  if (flag === '--show') {
    console.log(preview(rest[0] ?? ''))

    return 0
  }

  if (read(['rev-parse', '--git-dir']) === '')
    fail('not a git repository', 2)

  // ctrl-r: the header once fetched.
  if (flag === '--fetch') {
    console.log(await fetched())

    return 0
  }

  if (flag === '--list') {
    listed(load().all)

    return 0
  }

  // With when it was last committed to as the description fish shows beside each name.
  if (flag === '--names') {
    console.log(load().all.map(branch => `${branch.name}\t${branch.when}, ${branch.subject}`).join('\n'))

    return 0
  }

  return undefined
}

function create(name: string): string[] {
  const problem = invalid(name)

  if (problem)
    fail(problem, 1)

  return ['git', 'switch', '-c', name]
}

export async function gb(args: string[]): Promise<number> {
  const [flag = ''] = args

  if (['--show', '--fetch', '--list', '--names'].includes(flag))
    return await hidden(flag, args.slice(1)) ?? 0

  // The protocol the tmux picker and the fish wrapper read instead of the command being run: its mode, the words typed back, and the command's words.
  const emitting = flag === '--emit'
  const parsed = parse(emitting ? args.slice(1) : args, usage, options, { exits: EXITS, replaces: 'git switch, git branch -d and git checkout typed per branch', examples: ['gb', ['gb feature', 'switch to feature, or create it from origin/feature'], ['gb -', 'back to the previous branch'], ['gb -c fix/login', 'create a branch and switch to it'], ['gb -d old', 'delete a merged local branch']] })
  const [named] = parsed.positionals

  if (read(['rev-parse', '--git-dir']) === '')
    fail('not a git repository', 2)

  let typed: string
  let command: Arg[]

  if (parsed.values.create === true) {
    const name = parsed.positionals.join(' ')

    command = create(name)
    typed = `-c ${name}`
  }
  else if (named === '-' && parsed.values.delete !== true) {
    command = ['git', 'switch', '-']
    typed = '-'
  }
  else {
    const { found, current, all } = load()
    const deleting = parsed.values.delete === true
    let branch: Branch | undefined
    let key = ''

    if (named === undefined) {
      const interactive = isInteractive() && parsed.values.json !== true

      if (!interactive) {
        if (emitting)
          fail('the picker needs a terminal', 1)

        if (parsed.values.json === true)
          printJson(all)
        else
          console.log(table(all.map(row)).map(line => (takesControlCodes(process.stdout) ? line : Bun.stripANSI(line))).join('\n'))

        return 0
      }

      const picked = await pick(all.map(row), {
        prompt: 'gb> ',
        header: header(found, current),
        expect: ['ctrl-d', 'ctrl-n'],
        searched: 1,
        preview: fields => preview(fields[0]!),
        reload: { key: 'ctrl-r', run: async () => ({ header: await fetched(), rows: load().all.map(row) }) },
      })

      if (picked?.key === 'ctrl-n') {
        const name = picked.query.trim()

        return finish(create(name), `-c ${name}`, emitting)
      }

      // Read again, a ctrl-r having maybe brought a branch the first list did not hold.
      branch = picked && load().all.find(candidate => candidate.name === picked.hidden[0])

      if (!branch)
        return 1

      key = picked!.key
    }
    else if (deleting && named === '-') {
      return fail('-d takes a branch name, not -', 1)
    }
    else if (!deleting && isCurrent(named, current, found)) {
      console.error(`already on ${current}`)

      return 0
    }
    else {
      // A bare name finds the remote branch it would create, `gb feature` for origin/feature.
      branch = all.find(candidate => candidate.name === named) ?? all.find(candidate => candidate.remote && localName(candidate.name) === named)

      if (!branch) {
        const nearest = closest(named, all.map(candidate => candidate.name))

        return fail(`no branch named ${named}${nearest === undefined ? '' : `, did you mean ${nearest}?`}`, 1)
      }
    }

    if (deleting || key === 'ctrl-d') {
      command = remove(branch)
      typed = `-d ${branch.name}`
    }
    else {
      command = goTo(branch)
      typed = branch.name
    }
  }

  return finish(command, typed, emitting)
}

// Emits the command for the wrapper reading it, or runs it; a `cd` cannot be run from here, so the folder is printed for the shell to go to.
async function finish(command: Arg[], typed: string, emitting: boolean): Promise<number> {
  if (emitting) {
    emit('run', typed, '', command)

    return 0
  }

  const words = command as string[]

  if (words[0] === 'cd') {
    console.log(words[1])
    console.error(`checked out in another worktree: cd ${words[1]}`)

    return 0
  }

  return Bun.spawn(words, { stdio: ['inherit', 'inherit', 'inherit'] }).exited
}
