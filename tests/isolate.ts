import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Points tea, glab and gh at an empty config, so a test whose stand-in is missed fails on no login instead of writing to the real forge.
const config = mkdtempSync(join(tmpdir(), 'agent-tools-config-'))

process.env.XDG_CONFIG_HOME = config
process.env.GLAB_CONFIG_DIR = join(config, 'glab-cli')
process.env.GH_CONFIG_DIR = join(config, 'gh')
