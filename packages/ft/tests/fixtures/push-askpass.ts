import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { pushToOrigin } from '../../src/commands/release-checks'

// Pushes as ft release does, the child in its own session, then says how git ended.
process.exitCode = await runMain({ name: 'push-askpass', usage: false, run: async () => {
  const push = await pushToOrigin(['origin', 'HEAD:refs/heads/main'], () => undefined)

  console.log(`push ended ${push.code}`)

  return 0
} })
