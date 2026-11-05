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
// Every tool's state too, such as out's stats, so no test adds to the real ones.
process.env.XDG_STATE_HOME = join(config, 'state')
// Tests of colour pass their own streams and expect colour on them, so a NO_COLOR or FORCE_COLOR of the shell running them, `check` sets the first, is not theirs to see.
delete process.env.NO_COLOR
delete process.env.FORCE_COLOR
