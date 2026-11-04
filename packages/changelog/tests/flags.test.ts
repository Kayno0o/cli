import { delimiter } from 'node:path'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { expect, it } from 'bun:test'
import { aliasFlags, shouldAskNote, withToken } from '../src/flags'

const tempDir = tempDirs()

it('never borrows the GitHub CLI token for Forgejo', async () => {
  const bin = tempDir('changelog-gh-')
  const gh = `${bin}/gh`
  const { GITHUB_TOKEN, PATH } = process.env

  await Bun.write(gh, '#!/bin/sh\necho ghp_secret\n')
  await Bun.$`chmod +x ${gh}`
  delete process.env.GITHUB_TOKEN
  process.env.PATH = `${bin}${delimiter}${PATH}`

  try {
    expect((withToken({})).token).toBeUndefined()
  }
  finally {
    process.env.PATH = PATH

    if (GITHUB_TOKEN !== undefined)
      process.env.GITHUB_TOKEN = GITHUB_TOKEN
  }
})

it('asks about the release note only when nothing answers or skips it', () => {
  const release = { name: 'v1' }

  expect(shouldAskNote({ release, note: false, yes: false, dry: false })).toBe(true)
  expect(shouldAskNote({ release, note: false, yes: false, dry: true })).toBe(false)
  expect(shouldAskNote({ release, note: false, yes: true, dry: false })).toBe(false)
  expect(shouldAskNote({ release: null, note: false, yes: false, dry: false })).toBe(false)
})

it('keeps the old flag names as aliases of the new ones', () => {
  expect(aliasFlags(['--dry', '--gitea', 'a/b', '--release-gitea=c/d', '--dry-run'])).toEqual(['--dry-run', '--repo', 'a/b', '--release-repo=c/d', '--dry-run'])
  expect(aliasFlags(['--', '--dry'])).toEqual(['--', '--dry'])
})
