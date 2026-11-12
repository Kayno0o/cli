#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { GlobalOptions } from './commands'
import type { Jobs } from './jobs'
import type { Worktree } from './project'
import process from 'node:process'
import { badUsage, fail, isInteractive, jsonOption, parse, printError, runCli, warn } from '@kaynooo/cli-kit'
import { wtJobs } from './config'
import { failKnown, failureText, knownMessage } from './errors'
import { notifyRefused, slugOf } from './jobs'
import { assertWorktreeExists, listTasks, loadProjects, locate, locateWorktree, worktreeOf } from './project'

// Each command loads its modules when it runs, so `wt path`, `wt tasks` and Tab completion do not pay for the whole tool.
const commands = async () => import('./commands')
const printing = async () => import('./print')

const APP = 'wt'

const jobs = wtJobs

// A config that does not load fails like any other known error; `bg` names a `--bg` command, whose refusal is notified too.
async function guarded(action: () => Promise<number | void>, bg?: string): Promise<number> {
  let built: Jobs

  try {
    built = await jobs()
  }
  catch (error) {
    if (bg !== undefined)
      await notifyRefused(APP, bg, failureText(error))

    return failKnown(error)
  }

  return built.guarded(action, bg)
}

// The name a `--bg` command is notified under, none without `--bg`.
function bgName(values: { bg?: boolean }, ...words: (string | undefined)[]): string | undefined {
  return values.bg ? [APP, ...words.filter(word => word !== undefined)].join(' ') : undefined
}

async function projectNames(): Promise<string[]> {
  try {
    return (await loadProjects()).map(project => project.name)
  }
  catch {
    return []
  }
}

// The worktrees of the project the current directory belongs to, none outside one.
async function taskNames(): Promise<string[]> {
  try {
    return listTasks((await locate(process.cwd())).project)
  }
  catch {
    return []
  }
}

const TASK = { '[task]': taskNames, '<task>': taskNames }

// Every command that reads a manifest takes it, as the kit has no option before the command name.
const PROJECT_OPTION = { type: 'string', short: 'p', candidates: projectNames, description: 'manifest to use instead of the one the current directory belongs to' } as const

const BG_OPTION = { type: 'boolean', description: 'run it away from any terminal, its output in the worktree\'s job log, a notification saying how it went' } as const

// Every action on a worktree holds its stack's lock, so an up cannot race a removal, and --bg detaches it. Its caller checks the worktree first: a job claimed for one that cannot be acted on leaves a record behind, or a `--bg` one failing out of sight.
async function asWorktreeJob(verb: 'add' | 'add --up' | 'sync' | 'rm' | 'up' | 'down', { project, task }: Worktree, options: GlobalOptions & { bg?: boolean }, argv: string[], work: () => Promise<void>): Promise<number> {
  const ref = `${project.name}/${task}`
  const stack = { ref, slug: slugOf(ref) }
  const queue = await jobs()

  if (!options.bg) {
    const code = await queue.run(stack, verb, work)

    // A removed worktree leaves no job history for one made again under its name
    if (verb === 'rm' && code === 0)
      queue.forget(stack)

    return code
  }

  const job = queue.detach(stack, verb, [import.meta.path, ...argv, '-p', project.name])

  console.log(`wt: ${verb} ${ref} runs out of sight, its output in ${job.log}`)

  return 0
}

// Acts on each worktree in turn, one refused or failed not stopping the rest: 1 when any failed.
async function inTurn(command: string, worktrees: Worktree[], act: (worktree: Worktree) => Promise<number>): Promise<number> {
  let code = 0

  for (const worktree of worktrees) {
    try {
      code = Math.max(code, await act(worktree))
    }
    catch (error) {
      const message = knownMessage(error)

      if (message === undefined)
        throw error

      printError(`${APP} ${command}`, message)
      code = 1
    }
  }

  return code
}

async function eachWorktree(command: string, projectName: string | undefined, act: (worktree: Worktree) => Promise<number>): Promise<number> {
  const { project } = await locate(process.cwd(), projectName)
  const tasks = listTasks(project)

  if (!tasks.length)
    console.log(`wt: ${project.name} has no worktree`)

  return inTurn(command, tasks.map(task => worktreeOf(project, task)), act)
}

// Lists what removed worktrees left behind and, once confirmed, removes each as `wt rm --force` would, then git's stale registrations.
async function prune(options: GlobalOptions & { all?: boolean, yes?: boolean }): Promise<number> {
  const { describeLeftBehind, leftBehind, pruneRegistrations } = await import('./prune')
  const found = await leftBehind(options)

  if (!found.length) {
    console.log('wt: nothing left behind')

    return 0
  }

  console.log(describeLeftBehind(found).join('\n'))

  if (!options.yes) {
    if (!isInteractive()) {
      warn('nothing removed, `wt prune -y` removes it')

      return 0
    }

    const { confirm } = await import('@kaynooo/cli-kit/prompt')

    if (await confirm('Remove it all?', { default: false }) !== true)
      return 1
  }

  const { removeTask } = await commands()
  const code = await inTurn('prune', found.flatMap(each => each.orphans.map(orphan => orphan.worktree)), async worktree => asWorktreeJob('rm', worktree, { project: worktree.project.name }, [], async () => removeTask(worktree.task, { project: worktree.project.name, force: true })))

  for (const { project } of found)
    await pruneRegistrations(project)

  return code
}

const ALL_OPTION = { type: 'boolean', description: 'every worktree of the project, one after the other' } as const

const ADD_USAGE = `wt add <task> [branch] [--from <ref>] [--up] [-p <name>] [--bg]

Creates a worktree, copies its files and data from main, and routes its subdomains; --up starts its stack too. The task is a lowercase name, also the subdomain label; the branch defaults to wt/<task>. A branch that does not exist yet forks from main's current commit, or from --from, and the output says which.

Exits 0 once the worktree is ready (and up), 1 when it cannot be made, provisioned or started, 2 on a usage error.`

const SYNC_USAGE = `wt sync [task] [-p <name>]

Provisions a worktree again after a manifest change: missing copies and clones, compose override, certificates and routes. The task defaults to the worktree the current directory is in.

Exits 0 once it is provisioned, 1 when a step fails, 2 on a usage error.`

const RM_USAGE = `wt rm <task> [-f] [-p <name>] [--bg]

Stops a worktree stack and deletes its checkouts, volumes, certificates and routes, keeping its branches. Gitignored files go with the folder unchecked: edits to a copied .env.local, uploads and the like are lost, so save them first.

Exits 0 once it is gone, 1 when uncommitted changes or lost commits refuse it (unless --force) or a step fails, 2 on a usage error.`

const UP_USAGE = `wt up [task | --all] [-p <name>] [--bg]

Starts a worktree stack: \`docker compose up -d --build\` in the worktree then the manifest's setup the first time, or the config's runner.up. The task defaults to the worktree the current directory is in; --all starts every worktree of the project in turn.

Exits 0 once the stacks are up, 1 when a command fails, 2 on a usage error.`

const DOWN_USAGE = `wt down [task | --all] [-p <name>] [--bg]

Stops a worktree stack: \`docker compose down\` in the worktree, or the config's runner.down. The task defaults to the worktree the current directory is in; --all stops every worktree of the project in turn.

Exits 0 once the stacks are down, 1 when a command fails, 2 on a usage error.`

const LOGS_USAGE = `wt logs [task] [-f] [-p <name>]

Prints the log of the worktree's last --bg job, a job run in a terminal having printed there; -f follows its stack's compose logs instead, from their last 100 lines. The task defaults to the worktree the current directory is in.

Exits 0 once printed, 1 when no --bg job left a log, compose's code with -f, 2 on a usage error.`

const PRUNE_USAGE = `wt prune [-a] [-y] [-p <name>]

Lists what worktrees removed by hand, or an add that crashed, left behind: wt's files, job records, queues, containers and volumes, and git's registrations of folders gone. Once confirmed, removes each as \`wt rm --force\` would. The current project, or every project with -a.

Exits 0 once removed, or when nothing is left or nothing could be asked, 1 when a removal fails or is declined, 2 on a usage error.`

// `wt up` and `wt down`, of one worktree or with --all of each in turn.
async function startOrStop(verb: 'up' | 'down', args: string[]): Promise<number> {
  const { values, positionals: [task] } = parse(args, verb === 'up' ? UP_USAGE : DOWN_USAGE, { project: PROJECT_OPTION, all: ALL_OPTION, bg: BG_OPTION }, { positionals: ['[task]'], candidates: TASK })
  const act = async (worktree: Worktree) => asWorktreeJob(verb, worktree, values, [verb, worktree.task], async () => {
    const { downTask, upTask } = await commands()

    return verb === 'up' ? upTask(worktree) : downTask(worktree)
  })

  if (values.all && task !== undefined)
    badUsage(`wt ${verb} takes a task or --all, not both`)

  return guarded(async () => {
    if (values.all)
      return eachWorktree(verb, values.project, act)

    const worktree = await locateWorktree(process.cwd(), task, values.project)

    assertWorktreeExists(worktree)

    return act(worktree)
  }, bgName(values, verb, values.all ? '--all' : task))
}

const SHELL_USAGE = `wt shell <shell>

Prints the shell function that lets \`wt cd\` change directory and \`wt rm\` leave the folder it removes, with wt's completion. Save it where the shell reads it at start, so no process runs then, and again after upgrading wt: \`wt shell fish > ~/.config/fish/conf.d/wt.fish\`; for bash or zsh, a file sourced from ~/.bashrc, or from ~/.zshrc after compinit.

Exits 0 when it printed the wrapper, 1 for a shell it has none for (fish, bash and zsh have one), 2 on a usage error.`

const LS_USAGE = `wt ls [-a] [-p <name>] [--json]

Lists main and the worktrees of the current project, or of every project, with their changed files.

Exits 0 when it listed them, 1 when a manifest does not load, 2 on a usage error.`

const PATH_USAGE = `wt path [task] [-p <name>]

Prints the directory of a worktree, or of main when no task is given.

Exits 0 when it printed it, 1 when there is no such worktree or project, 2 on a usage error.`

const INIT_USAGE = `wt init [dir] [--name <name>] [--print]

Drafts a manifest for the project checked out in a directory, the current one by default, into the config's manifests folder.

Exits 0 once it is written or printed, 1 when the folder holds no compose project, 2 on a usage error.`

const DOCTOR_USAGE = `wt doctor

Lists each program wt runs: where it is on PATH, or how to get it, and what wt needs it for.

Exits 0 when every program the projects need is there, 1 when one is missing, 2 on a usage error.`

const RUN_USAGE = `wt run <task> [-p <name>] -- <command>...

Runs a command of a worktree in a throwaway container of its run service, against a test database of its own, provisioned on first use.

Exits with the command's code, 1 when the test database cannot be provisioned, 2 on a usage error.`

const HEAVY_USAGE = `wt heavy -- <command>...

Runs a heavy command (a full suite, e2e) once those queued before it, from any session, are done.

Exits with the command's code, 2 on a usage error.`

const OPEN_USAGE = `wt open [task] [-p <name>]

Opens the worktree's main URL in the browser ($BROWSER, else the system's opener). The task defaults to the checkout the current directory is in, \`main\` naming main's.

Exits 0 once the browser is started, 1 when there is no such worktree, no URL or no browser, 2 on a usage error.`

const CD_USAGE = `wt cd [task] [-p <name>]

Goes to a worktree's directory, or main's when no task is given. A program cannot change its shell's directory, so this runs in the shell function \`wt shell\` prints; run as a program, it says so.

Exits 0 once there, 1 when there is no such worktree or the shell function is missing, 2 on a usage error.`

const URL_USAGE = `wt url [task] [-p <name>]

Prints the URLs of a worktree.

Exits 0 when it printed it, 1 when there is no such worktree or project, 2 on a usage error.`

const TASKS_USAGE = `wt tasks [-p <name>]

Prints the worktree names of the project, one per line, nothing when it has none.

Exits 0 when it printed them, 1 when there is no such project or its manifest does not load, 2 on a usage error.`

process.exitCode = await runCli({
  name: APP,
  about: 'git worktrees of a compose project, each with its own stack, data and <task>.<host> subdomains beside main',
  replaces: 'a second clone, port juggling and a shared database to try a branch',
  examples: [['wt add planning', 'a worktree on wt/planning with its own stack'], ['wt up planning', 'start it'], ['wt rm planning', 'stop and delete it, keeping its branches']],
  commands: {
    add: {
      summary: 'create a worktree, copy its files and data from main, and route its subdomains',
      run: async (args) => {
        const { values, positionals: [task, branch] } = parse(args, ADD_USAGE, {
          project: PROJECT_OPTION,
          up: { type: 'boolean', description: 'start its stack once it is ready, as `wt up` does' },
          from: { type: 'string', description: 'the commit, branch or tag a new branch forks from, main\'s current commit by default' },
          bg: BG_OPTION,
        }, { positionals: ['<task>', '[branch]'] })

        return guarded(async () => {
          const worktree = worktreeOf((await locate(process.cwd(), values.project)).project, task)

          return asWorktreeJob(values.up ? 'add --up' : 'add', worktree, values, ['add', task, ...(branch === undefined ? [] : [branch]), ...(values.from === undefined ? [] : ['--from', values.from]), ...(values.up ? ['--up'] : [])], async () => (await commands()).addTask(task, branch, values))
        }, bgName(values, values.up ? 'add --up' : 'add', task))
      },
    },
    sync: {
      summary: 'provision a worktree again after a manifest change',
      run: async (args) => {
        const { values, positionals: [task] } = parse(args, SYNC_USAGE, { project: PROJECT_OPTION }, { positionals: ['[task]'], candidates: TASK })

        return guarded(async () => {
          const worktree = await locateWorktree(process.cwd(), task, values.project)

          assertWorktreeExists(worktree)

          return asWorktreeJob('sync', worktree, values, ['sync', worktree.task], async () => (await commands()).syncTask(worktree.task, values))
        })
      },
    },
    rm: {
      summary: 'stop a worktree stack and delete its checkouts, volumes, certificates and routes, keeping its branches',
      run: async (args) => {
        const { values, positionals: [task] } = parse(args, RM_USAGE, {
          project: PROJECT_OPTION,
          force: { type: 'boolean', short: 'f', description: 'remove even with uncommitted changes or commits on no branch' },
          bg: BG_OPTION,
        }, { positionals: ['<task>'], candidates: TASK })

        return guarded(async () => {
          const { assertRemovable, removeTask } = await commands()
          const worktree = await assertRemovable(task, values)

          return asWorktreeJob('rm', worktree, values, ['rm', task, ...(values.force ? ['--force'] : [])], async () => removeTask(task, values))
        }, bgName(values, 'rm', task))
      },
    },
    up: {
      summary: 'start a worktree stack',
      run: async args => startOrStop('up', args),
    },
    down: {
      summary: 'stop a worktree stack',
      run: async args => startOrStop('down', args),
    },
    logs: {
      summary: 'print the log of a worktree\'s last --bg job, or follow its stack\'s compose logs',
      run: async (args) => {
        const { values, positionals: [task] } = parse(args, LOGS_USAGE, {
          project: PROJECT_OPTION,
          follow: { type: 'boolean', short: 'f', description: 'follow the stack\'s compose logs instead, from their last 100 lines' },
        }, { positionals: ['[task]'], candidates: TASK })

        return guarded(async () => {
          const worktree = await locateWorktree(process.cwd(), task, values.project)

          assertWorktreeExists(worktree)

          if (values.follow)
            return (await import('./stack')).followLogs(worktree)

          const { printJobLog } = await printing()

          await printJobLog(worktree, await jobs())

          return 0
        })
      },
    },
    prune: {
      summary: 'remove what worktrees removed by hand left behind',
      run: async (args) => {
        const { values } = parse(args, PRUNE_USAGE, {
          project: PROJECT_OPTION,
          all: { type: 'boolean', short: 'a', description: 'every project, even from inside one' },
          yes: { type: 'boolean', short: 'y', description: 'remove without asking' },
        }, { positionals: [] })

        return guarded(async () => prune(values))
      },
    },
    ls: {
      summary: 'list main and the worktrees of the current project, or of every project',
      run: async (args) => {
        const { values } = parse(args, LS_USAGE, {
          project: PROJECT_OPTION,
          all: { type: 'boolean', short: 'a', description: 'every project, even from inside one' },
          json: jsonOption('{ project, checkouts }, project being the one the directory is in, null outside every one'),
        }, { positionals: [] })

        return guarded(async () => (await import('./list')).listWorktrees(values))
      },
    },
    cd: {
      summary: 'go to a worktree, or main (through the shell function of `wt shell`)',
      run: async (args) => {
        const { values, positionals: [task] } = parse(args, CD_USAGE, { project: PROJECT_OPTION }, { positionals: ['[task]'], candidates: { '[task]': async () => [...await taskNames(), 'main'] } })

        return guarded(async () => {
          const { printPath } = await printing()

          // Checked first, so a task that does not exist says so rather than the wrapper's absence
          await printPath(task, values)
          fail('cd needs the shell function `wt shell <shell>` prints, as a program cannot change its shell\'s directory', 1, 'cd to the path above')
        })
      },
    },
    path: {
      summary: 'print the directory of a worktree, or of main',
      run: async (args) => {
        const { values, positionals: [task] } = parse(args, PATH_USAGE, { project: PROJECT_OPTION }, { positionals: ['[task]'], candidates: TASK })

        return guarded(async () => (await printing()).printPath(task, values))
      },
    },
    init: {
      summary: 'draft a manifest for the project checked out in a directory',
      run: async (args) => {
        const { values, positionals: [dir] } = parse(args, INIT_USAGE, {
          name: { type: 'string', description: 'the manifest\'s name, also hashed into the dev server port (the checkout\'s folder name)' },
          print: { type: 'boolean', description: 'print the draft instead of writing it' },
        }, { positionals: ['[dir]'] })

        return guarded(async () => (await import('./init')).initProject(dir ?? process.cwd(), values))
      },
    },
    doctor: {
      summary: 'list the programs wt runs, where each is or how to get it',
      run: async (args) => {
        parse(args, DOCTOR_USAGE, {})

        return guarded(async () => (await import('./tools')).doctor(await loadProjects()))
      },
    },
    run: {
      summary: 'run a command of a worktree in a throwaway container of its run service, against a test database of its own',
      run: async (args) => {
        const { values, positionals: [task], rest } = parse(args, RUN_USAGE, { project: PROJECT_OPTION }, {
          positionals: ['<task>'],
          candidates: TASK,
          rest: true,
          examples: [['wt run planning -- vendor/bin/phpunit --filter Foo', 'a test run in the planning worktree']],
        })

        if (rest === undefined || rest.length === 0)
          badUsage('give the command after --')

        return guarded(async () => (await import('./run')).runTask(task, rest, values.project))
      },
    },
    heavy: {
      summary: 'run a heavy command once those queued before it, from any session, are done',
      run: async (args) => {
        const { rest } = parse(args, HEAVY_USAGE, {}, {
          positionals: [],
          rest: true,
          examples: [['wt heavy -- wt run planning -- vendor/bin/phpunit', 'a full suite, queued']],
        })

        if (rest === undefined || rest.length === 0)
          badUsage('give the command after --')

        return guarded(async () => (await import('./run')).runHeavy(rest))
      },
    },
    shell: {
      summary: 'print the shell function letting `wt cd` change directory',
      run: async (args) => {
        const { positionals: [shell] } = parse(args, SHELL_USAGE, {}, { positionals: ['<shell>'], candidates: { '<shell>': async () => Promise.resolve(['fish', 'bash', 'zsh']) } })

        return guarded(async () => {
          console.log((await import('./shell')).shellWrapper(shell))
        })
      },
    },
    open: {
      summary: 'open a worktree\'s main URL in the browser',
      run: async (args) => {
        const { values, positionals: [task] } = parse(args, OPEN_USAGE, { project: PROJECT_OPTION }, { positionals: ['[task]'], candidates: TASK })

        return guarded(async () => (await printing()).openTask(task, values))
      },
    },
    url: {
      summary: 'print the URLs of a worktree',
      run: async (args) => {
        const { values, positionals: [task] } = parse(args, URL_USAGE, { project: PROJECT_OPTION }, { positionals: ['[task]'], candidates: TASK })

        return guarded(async () => (await printing()).printUrls(task, values))
      },
    },
    tasks: {
      summary: 'print the worktree names of the project',
      run: async (args) => {
        const { values } = parse(args, TASKS_USAGE, { project: PROJECT_OPTION }, { positionals: [] })

        return guarded(async () => (await printing()).printTasks(values))
      },
    },
  },
})
