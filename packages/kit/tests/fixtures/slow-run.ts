import process from 'node:process'
import { runCli, runMain } from '../../src/cli'

// Each reading of the clock eleven seconds after the one before, so the run looks long enough to be notified of without waiting it out.
let now = 0

performance.now = () => (now += 11_000)

const code = process.argv[2] === 'cli'
  ? await runCli({ name: 'slowcli', about: 'a slow cli', usage: false, commands: { build: { summary: 'builds', run: async () => Promise.resolve(0) } } }, ['build'])
  : await runMain({ name: 'slowmain', usage: false, run: async () => Promise.resolve(3) }, [])

process.exit(code)
