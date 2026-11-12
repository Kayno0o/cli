/** The entry point sandboxed tests run in a child process of their own, with HOME and PATH pointing at a sandbox: wt reads its config from HOME, and a signal test must not take the test runner down with it. */

import type { ComposeConfig } from '../src/compose'
import type { Project } from '../src/project'

import { wtConfig } from '../src/config'
import { failureText } from '../src/errors'
import { cloneData, whilePaused } from '../src/files'
import { worktreeOf } from '../src/project'
import { writeStackCerts } from '../src/routes'
import { forgetTestDatabases } from '../src/run'

interface WorktreeInput {
  project: Omit<Project, 'settings'>
  task: string
}

interface CloneInput extends WorktreeInput {
  main: ComposeConfig
}

const worktree = async (input: WorktreeInput) => worktreeOf({ ...input.project, settings: await wtConfig() }, input.task)

const [scenario = '', arg = ''] = process.argv.slice(2)

if (scenario === 'clone') {
  const input = JSON.parse(arg) as CloneInput

  try {
    console.log(JSON.stringify(await cloneData(await worktree(input), input.main)))
  }
  catch (error) {
    console.log(JSON.stringify({ error: failureText(error) }))
    process.exitCode = 1
  }
}
else if (scenario === 'forget') {
  await forgetTestDatabases(await worktree(JSON.parse(arg) as WorktreeInput))
}
else if (scenario === 'stack-certs') {
  await writeStackCerts(await worktree(JSON.parse(arg) as WorktreeInput))
}
else if (scenario === 'paused-error') {
  const ids = arg ? arg.split(',') : []

  try {
    await whilePaused(ids, async () => {
      await Bun.sleep(0)

      throw new Error('copy failed')
    })
  }
  catch (error) {
    console.log(error instanceof Error ? error.message : String(error))
  }
}
else if (scenario === 'paused-record') {
  await whilePaused(['main-db', 'main-web'], async () => console.log((await Bun.file(arg).text()).trim().replace('\n', ',')), undefined, arg)
}
else if (scenario === 'paused-signal') {
  await whilePaused(['main-db', 'main-web'], async () => {
    process.kill(process.pid, arg)
    await Bun.sleep(5000)
  }, () => console.log('aborted'))
}
else {
  throw new Error(`unknown scenario ${scenario}`)
}
