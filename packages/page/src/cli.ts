#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { runCli } from '@kaynooo/cli-kit'

process.exitCode = await runCli({
  name: 'page',
  about: 'shoots HTML files or URLs at several widths in a local Chromium and reports their layout defects one line each, or diffs a built page against its mockup, by pixel or by what moved',
  replaces: 'reading screenshots by eye for overflow, squashed controls and fallback fonts, and one-off Playwright scripts shooting a page',
  examples: [['page check mockup.html', 'PNGs at 1440 and 400px, then the defects by width and kind'], 'page check http://localhost:5173/ -w 1280,375', ['page diff mockup.html http://localhost:5173/', 'side-by-side and pixel-diff PNGs, differing regions boxed'], ['page shift before.html after.html', 'what moved or resized, one line per cause']],
  commands: {
    check: { summary: 'shoot each target at every width and report its layout defects', run: async args => (await import('./check')).check(args) },
    diff: { summary: 'shoot a mockup and the built page at every width and box where they differ', run: async args => (await import('./diff')).diff(args) },
    shift: { summary: 'pair two pages\' elements at every width and report what moved or resized, by cause', run: async args => (await import('./shift')).shift(args) },
  },
})
