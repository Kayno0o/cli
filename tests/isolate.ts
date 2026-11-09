import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'bun:test'

// Points tea, glab and gh at an empty config, so a test whose stand-in is missed fails on no login instead of writing to the real forge.
const config = mkdtempSync(join(tmpdir(), 'kaynooo-cli-config-'))

// Under --parallel the preload runs again for every file, and its afterAll after that file's tests.
afterAll(() => rmSync(config, { recursive: true, force: true }))

process.env.XDG_CONFIG_HOME = config
process.env.GLAB_CONFIG_DIR = join(config, 'glab-cli')
process.env.GH_CONFIG_DIR = join(config, 'gh')
// check queues its steps in slot by default: a test's runs take the slots of an empty queue, not the real ones of the sessions on this machine.
process.env.SLOT_DIR = join(config, 'slots')
// Nor do they hold the one check runs them in: slot hands its child SLOT_HOLDING, and a slot started under it skips the queue the tests wait on.
delete process.env.SLOT_HOLDING
// Every tool's state too, such as out's stats, so no test adds to the real ones.
process.env.XDG_STATE_HOME = join(config, 'state')
// Tests of colour pass their own streams and expect colour on them, so a NO_COLOR or FORCE_COLOR of the shell running them, `check` sets the first, is not theirs to see.
delete process.env.NO_COLOR
delete process.env.FORCE_COLOR
// The mode of the shell running the tests, an agent's or CI's, is not theirs either: each test that wants one passes its own env.
delete process.env.CLAUDECODE
delete process.env.AI_AGENT
delete process.env.CI
delete process.env.KIT_MODE

// A test that times out keeps running while the next one starts, so its `finally` can chdir back here under the next test's feet and that test's git then runs in this checkout. No git a test starts through `$` or node:child_process may push to this checkout's remotes: each push URL is rewritten to a path that does not exist, after the entries the shell already passes. Bun.spawn without an env sees none of this.
const WHITESPACE = /\s+/
const remotes = Bun.spawnSync(['git', '-C', new URL('..', import.meta.url).pathname, 'remote', '-v'], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString()
const pushUrls = new Set(remotes.split('\n').filter(line => line.endsWith('(push)')).map(line => line.split(WHITESPACE)[1] ?? '').filter(url => url !== ''))
let configs = Number(process.env.GIT_CONFIG_COUNT ?? 0)

for (const url of pushUrls) {
  process.env[`GIT_CONFIG_KEY_${configs}`] = 'url./nonexistent/push-refused-in-tests/.pushInsteadOf'
  process.env[`GIT_CONFIG_VALUE_${configs}`] = url
  configs += 1
}

process.env.GIT_CONFIG_COUNT = String(configs)
