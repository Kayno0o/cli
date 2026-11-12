#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { GlobalOptions } from './commands'
import type { Worktree } from './project'
import process from 'node:process'
import { badUsage, parse, runCli } from '@kaynooo/cli-kit'
import { wtConfig } from './config'
import { failKnown, failureText, knownMessage } from './errors'
import { Jobs, notifyRefused } from './jobs'
import { assertWorktreeExists, listTasks, loadProjects, locate, locateWorktree, worktreeOf } from './project'

// Each command loads its modules when it runs, so `wt path`, `wt tasks` and Tab completion do not pay for the whole tool.
const commands = async () => import('./commands')
const printing = async () => import('./print')

const APP = 'wt'

async function jobs(): Promise<Jobs> {
  return new Jobs({ dir: (await wtConfig()).jobs, app: APP })
}

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
async function asWorktreeJob(verb: 'add' | 'sync' | 'rm' | 'up' | 'down', { project, task }: Worktree, options: GlobalOptions & { bg?: boolean }, argv: string[], work: () => Promise<void>): Promise<number> {
  const ref = `${project.name}/${task}`
  const { slugOf } = await import('./stack')
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

// Acts on each worktree of the project in turn, one refused or failed not stopping the rest: 1 when any failed.
async function eachWorktree(projectName: string | undefined, act: (worktree: Worktree) => Promise<number>): Promise<number> {
  const { project } = await locate(process.cwd(), projectName)
  const tasks = listTasks(project)

  if (!tasks.length)
    console.log(`wt: ${project.name} has no worktree`)

  let code = 0

  for (const task of tasks) {
    try {
      code = Math.max(code, await act(worktreeOf(project, task)))
    }
    catch (error) {
      const message = knownMessage(error)

      if (message === undefined)
        throw error

      console.error(`error: ${message}`)
      code = 1
    }
  }

  return code
}

const ALL_OPTION = { type: 'boolean', short: 'a', description: 'every worktree of the project, one after the other' } as const

const ADD_USAGE = `wt add <task> [branch] [--up] [-p <name>] [--bg]

Creates a worktree, copies its files and data from main, and routes its subdomains; --up starts its stack too. The task is a lowercase name, also the subdomain label; the branch defaults to wt/<task>.

Exits 0 once the worktree is ready (and up), 1 when it cannot be made, provisioned or started, 2 on a usage error.`

const SYNC_USAGE = `wt sync [task] [-p <name>]

Provisions a worktree again after a manifest change: missing copies and clones, compose override, certificates and routes. The task defaults to the worktree the current directory is in.

Exits 0 once it is provisioned, 1 when a step fails, 2 on a usage error.`

const RM_USAGE = `wt rm <task> [-f] [-p <name>] [--bg]

Stops a worktree stack and deletes its checkouts, volumes, certificates and routes, keeping its branches.

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

const SHELL_USAGE = `wt shell <shell>

Prints the shell function that lets \`wt cd\` change directory and \`wt rm\` leave the folder it removes: \`wt shell fish | source\` in config.fish.

Exits 0 when it printed the wrapper, 1 for a shell it has none for, 2 on a usage error.`

const LS_USAGE = `wt ls [-a] [-p <name>] [--json]

Lists main and the worktrees of the current project, or of every project, with their changed files.

Exits 0 when it listed them, 1 when a manifest does not load, 2 on a usage error.`

const PATH_USAGE = `wt path [task] [-p <name>]

Prints the directory of a worktree, or of main when no task is given.

Exits 0 when it printed it, 1 when there is no such worktree or project, 2 on a usage error.`

const INIT_USAGE = `wt init [dir] [--name <name>] [--print]

Drafts a manifest for the project checked out in a directory, the current one by default, into the config's manifests folder.

Exits 0 once it is written or printed, 1 when the folder holds no compose project, 2 on a usage error.`

const RUN_USAGE = `wt run <task> [-p <name>] -- <command>...

Runs a command of a worktree in a throwaway container of its run service, against a test database of its own, provisioned on first use.

Exits with the command's code, 1 when the test database cannot be provisioned, 2 on a usage error.`

const HEAVY_USAGE = `wt heavy -- <command>...

Runs a heavy command (a full suite, e2e) once those queued before it, from any session, are done.

Exits with the command's code, 2 on a usage error.`

const OPEN_USAGE = `wt open [task] [-p <name>]

Opens the worktree's main URL in the browser ($BROWSER, else the system's opener). The task defaults to the checkout the current directory is in, \`main\` naming main's.

Exits 0 once the browser is started, 1 when there is no such worktree, no URL or no browser, 2 on a usage error.`

const URL_USAGE = `wt url [task] [-p <name>]

Prints the URLs of a worktree.

Exits 0 when it printed it, 1 when there is no such worktree or project, 2 on a usage error.`

const TASKS_USAGE = `wt tasks [-p <name>]

Prints the worktree names of the project, one per line.

Exits 0 when it printed them, 1 when there is no such project, 2 on a usage error.`

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
          bg: BG_OPTION,
        }, { positionals: ['<task>', '[branch]'] })

        return guarded(async () => {
          const worktree = worktreeOf((await locate(process.cwd(), values.project)).project, task)

          return asWorktreeJob('add', worktree, values, ['add', task, ...(branch === undefined ? [] : [branch]), ...(values.up ? ['--up'] : [])], async () => (await commands()).addTask(task, branch, values))
        }, bgName(values, 'add', task))
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
      run: async (args) => {
        const { values, positionals: [task] } = parse(args, UP_USAGE, { project: PROJECT_OPTION, all: ALL_OPTION, bg: BG_OPTION }, { positionals: ['[task]'], candidates: TASK })
        const up = async (worktree: Worktree) => asWorktreeJob('up', worktree, values, ['up', worktree.task], async () => (await commands()).upTask(worktree))

        if (values.all && task !== undefined)
          badUsage('wt up takes a task or --all, not both')

        return guarded(async () => {
          if (values.all)
            return eachWorktree(values.project, up)

          const worktree = await locateWorktree(process.cwd(), task, values.project)

          assertWorktreeExists(worktree)

          return up(worktree)
        }, bgName(values, 'up', values.all ? '--all' : task))
      },
    },
    down: {
      summary: 'stop a worktree stack',
      run: async (args) => {
        const { values, positionals: [task] } = parse(args, DOWN_USAGE, { project: PROJECT_OPTION, all: ALL_OPTION, bg: BG_OPTION }, { positionals: ['[task]'], candidates: TASK })
        const down = async (worktree: Worktree) => asWorktreeJob('down', worktree, values, ['down', worktree.task], async () => (await commands()).downTask(worktree))

        if (values.all && task !== undefined)
          badUsage('wt down takes a task or --all, not both')

        return guarded(async () => {
          if (values.all)
            return eachWorktree(values.project, down)

          const worktree = await locateWorktree(process.cwd(), task, values.project)

          assertWorktreeExists(worktree)

          return down(worktree)
        }, bgName(values, 'down', values.all ? '--all' : task))
      },
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

          printJobLog(worktree, await jobs())

          return 0
        })
      },
    },
    ls: {
      summary: 'list main and the worktrees of the current project, or of every project',
      run: async (args) => {
        const { values } = parse(args, LS_USAGE, {
          project: PROJECT_OPTION,
          all: { type: 'boolean', short: 'a', description: 'every project, even from inside one' },
          json: { type: 'boolean', description: 'print { project, checkouts }, project being the one the directory is in, null outside every one' },
        }, { positionals: [] })

        return guarded(async () => (await import('./list')).listWorktrees(values))
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
        const { positionals: [shell] } = parse(args, SHELL_USAGE, {}, { positionals: ['<shell>'], candidates: { '<shell>': async () => Promise.resolve(['fish']) } })

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
      hidden: true,
      run: async (args) => {
        const { values, positionals: [task] } = parse(args, URL_USAGE, { project: PROJECT_OPTION }, { positionals: ['[task]'], candidates: TASK })

        return guarded(async () => (await printing()).printUrls(task, values))
      },
    },
    tasks: {
      summary: 'print the worktree names of the project',
      hidden: true,
      run: async (args) => {
        const { values } = parse(args, TASKS_USAGE, { project: PROJECT_OPTION }, { positionals: [] })

        return guarded(async () => (await printing()).printTasks(values))
      },
    },
  },
})
