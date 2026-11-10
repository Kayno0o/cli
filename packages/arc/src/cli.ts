#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { runCli } from '@kaynooo/cli-kit'

process.exitCode = await runCli({
  name: 'arc',
  about: 'packs a folder into a verified .tar.zst before deleting it, unpacks one without overwriting anything and checks it, and extracts any other archive',
  replaces: 'tar czf then rm -rf on trust, tar xf over existing files, and remembering which extractor an archive needs',
  examples: [['arc ls backup.tar.zst', 'what is in an archive'], ['arc cat backup.tar.zst project/package.json', 'one file out of it'], ['arc pack ~/old-project /mnt/backup', 'archive, verify, then delete the folder'], ['arc pack -k ./dist .', 'compress only: ./dist.tar.zst, the folder stays'], ['arc unpack /mnt/backup/old-project.tar.zst ~/restored', 'refuses to overwrite'], ['arc extract release.tar.gz', 'any common archive']],
  commands: {
    pack: { summary: 'pack a folder into a .tar.zst, verify it file by file, then delete the folder (-k keeps it)', run: async args => (await import('./pack')).pack(args) },
    unpack: { summary: 'unpack a .tar.zst without overwriting anything, then verify it', run: async args => (await import('./unpack')).unpack(args) },
    ls: { summary: 'list what an archive holds, without extracting it', run: async args => (await import('./browse')).ls(args) },
    tree: { summary: 'draw the files of an archive as a tree', run: async args => (await import('./browse')).treeCommand(args) },
    cat: { summary: 'print a file of an archive on stdout', run: async args => (await import('./browse')).cat(args) },
    extract: { summary: 'extract any common archive into the current folder', run: async args => (await import('./extract')).extract(args) },
  },
})
