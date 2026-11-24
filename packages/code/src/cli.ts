#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { runCli } from '@kaynooo/cli-kit'
import { coupling } from './coupling'
import { deps } from './deps'
import { hotspots } from './hotspots'
import { aroundCmd, defCmd, outlineCmd, peek, refsCmd } from './peek'
import { todoScan } from './todo-scan'

process.exitCode = await runCli({
  name: 'src',
  about: 'reads, outlines, graphs and ranks source code: spans, definitions, references, deps, coupling, TODOs and hotspots',
  replaces: 'sed -n N,Mp, grep -n chains and grep -rn TODO',
  examples: ['src peek src/cli.ts:10-40', 'src def parseArgs src', 'src outline src/cli.ts', 'src deps src/cli.ts', ['src hotspots -n 10', 'the ten files both complex and often edited']],
  commands: {
    'peek': { summary: 'files or line spans with their line numbers, several in one call', run: peek },
    'def': { summary: 'whole declaration of a symbol (with leading comments)', run: defCmd },
    'refs': { summary: 'lines naming a symbol outside strings and comments', run: refsCmd },
    'outline': { summary: 'top-level declarations (including arrow functions), class members and Markdown headings', run: outlineCmd },
    'around': { summary: 'lines around each regex match, overlapping spans merged', run: aroundCmd },
    'deps': { summary: 'imports, importers, circular dependencies and unused exports of a file', run: deps },
    'coupling': { summary: 'pairs of files that frequently change together in git history', run: coupling },
    'todo-scan': { summary: 'the TODO, FIXME, #N and owner/repo#N comments under the paths', run: todoScan },
    'hotspots': { summary: 'the source files ranked by complexity times git churn', run: hotspots },
  },
})
