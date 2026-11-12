import process from 'node:process'
import { askpass } from '../../src/askpass'
import { runMain } from '../../src/cli'
import { progressLine } from '../../src/progress'

// Draws a progress line while git asks a server for credentials, as gf and gp do.
process.exitCode = await runMain({ name: 'askpass-git', usage: false, run: async ([url]) => {
  const progress = progressLine()

  progress.update({ step: 'fetching' })
  const prompts = askpass(progress.pause)

  try {
    const git = Bun.spawn(['git', 'ls-remote', url!], { env: { ...process.env, ...prompts?.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })

    await git.exited
  }
  finally {
    prompts?.close()
    progress.stop()
  }

  console.log(prompts === undefined ? 'no askpass' : 'git done')

  return 0
} })
