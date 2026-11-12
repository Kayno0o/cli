#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { runCli } from '@kaynooo/cli-kit'

process.exitCode = await runCli({
  name: 'dl',
  about: 'downloads a file into a folder of its own, checks its sha256, then extracts it, installs it as a command or runs it as a script once it is pinned',
  replaces: 'curl -fsSL <url> | sh, curl -LO then sha256sum -c by hand, and unpacking a release to copy its binary into ~/.local/bin',
  examples: [['dl https://bun.sh/install', 'download a script to read it'], ['dl https://bun.sh/install --exec --sha256 <sha>', 'run the script that was read'], ['dl https://example.com/tool.tar.gz --sums https://example.com/SHA256SUMS --bin tool', 'a checked binary, installed'], ['dl ls', 'what dl installed or ran'], ['dl outdated', 'what changed at its source'], ['dl update', 'install it again']],
  defaultCommand: 'get',
  commands: {
    get: { summary: 'download a file, check it, then extract, install or run it as asked', run: async args => (await import('./get')).get(args) },
    ls: { summary: 'list the commands dl installed and the scripts it ran', run: async args => (await import('./ls')).ls(args) },
    outdated: { summary: 'list the commands and scripts whose source changed since', run: async args => (await import('./update')).outdated(args) },
    update: { summary: 'download, check and install or run again what changed', run: async args => (await import('./update')).update(args) },
  },
})
