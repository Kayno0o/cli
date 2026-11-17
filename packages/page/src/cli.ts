#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { runCli } from '@kaynooo/cli-kit'

process.exitCode = await runCli({
  name: 'page',
  about: 'shoots HTML files or URLs at several widths in a local Chromium and reports their layout defects one line each, or diffs a built page against its mockup',
  replaces: 'reading screenshots by eye for overflow, squashed controls and fallback fonts, and one-off Playwright scripts shooting a page',
  examples: [['page check mockup.html', 'PNGs at 1440 and 400px, then one line per defect'], 'page check http://localhost:5173/ -w 1280,375', ['page diff mockup.html http://localhost:5173/', 'side-by-side and pixel-diff PNGs, differing regions boxed']],
  commands: {
    check: { summary: 'shoot each target at every width and report its layout defects', run: async args => (await import('./check')).check(args) },
    diff: { summary: 'shoot a mockup and the built page at every width and box where they differ', run: async args => (await import('./diff')).diff(args) },
  },
})
