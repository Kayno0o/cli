import type { AuthorInfo, ChangelogOptions } from '../src/types'
import { join } from 'node:path'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { deleteRelease, deleteRemoteTag, getRelease, hasRemoteTag, hasTagOnGitea, resolveAuthorInfo, uploadAssets } from '../src/gitea'

const tempDir = tempDirs()

const options = { baseUrlApi: 'forge.example/api/v1', repo: 'owner/repo', token: 'secret' } as ChangelogOptions

function answer(routes: Record<string, unknown>) {
  const asked: string[] = []

  spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request) => {
    const url = String(input)

    asked.push(url)
    const path = Object.keys(routes).find(route => url.includes(route))

    return path === undefined ? new Response('not found', { status: 404 }) : Response.json(routes[path])
  }) as typeof fetch)

  return asked
}

function author(commits: string[]): AuthorInfo {
  return { name: 'Ada', email: 'Ada@Example.com', commits }
}

afterEach(() => {
  mock.restore()
})

it('takes the login from the author\'s first commit, without searching', async () => {
  const asked = answer({ '/repos/owner/repo/git/commits/abc': { author: { login: 'ada', avatar_url: 'https://forge.example/avatars/ada' } } })

  expect(await resolveAuthorInfo(options, author(['abc']))).toMatchObject({ login: 'ada', avatar: 'https://forge.example/avatars/ada' })
  expect(asked).toHaveLength(1)
})

it('searches a co-author by email on Forgejo\'s users/search, keeping only the exact email', async () => {
  const asked = answer({ '/users/search?q=Ada%40Example.com': { ok: true, data: [{ login: 'adam', email: 'adam@example.com' }, { login: 'ada', email: 'ada@example.com' }] } })

  expect((await resolveAuthorInfo(options, author([]))).login).toBe('ada')
  expect(asked).toEqual(['https://forge.example/api/v1/users/search?q=Ada%40Example.com'])
})

it('leaves the login unset when no account shows that email', async () => {
  answer({ '/users/search': { ok: true, data: [] } })

  expect((await resolveAuthorInfo(options, author([]))).login).toBeUndefined()
})

it('encodes the tag in the release and tag urls and bounds every request in time', async () => {
  const seen: { url: string, signal: AbortSignal | null | undefined }[] = []

  spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), signal: init?.signal })

    return Response.json({ id: 1, name: 'x', url: '', html_url: '' })
  }) as typeof fetch)

  const withRelease = { ...options, releaseRepo: 'owner/release' }

  await getRelease(withRelease, 'v1/a#b')
  await hasRemoteTag(withRelease, 'v1/a#b')
  await hasTagOnGitea('v1/a#b', options)
  await deleteRelease(withRelease, 1)
  await deleteRemoteTag(withRelease, 'v1/a#b')

  expect(seen.map(s => s.url)).toEqual([
    'https://forge.example/api/v1/repos/owner/release/releases/tags/v1%2Fa%23b',
    'https://forge.example/api/v1/repos/owner/release/tags/v1%2Fa%23b',
    'https://forge.example/api/v1/repos/owner/repo/tags/v1%2Fa%23b',
    'https://forge.example/api/v1/repos/owner/release/releases/1',
    'https://forge.example/api/v1/repos/owner/release/tags/v1%2Fa%23b',
  ])
  expect(seen.every(s => s.signal instanceof AbortSignal)).toBe(true)
})

it('counts the assets it could not upload', async () => {
  const dir = tempDir('changelog-assets-')
  const file = join(dir, 'a.txt')
  const withRelease = { ...options, releaseRepo: 'owner/repo', to: 'v1' }

  await Bun.write(file, 'a')
  answer({ '/releases/tags/v1': { id: 7 }, '/assets': { ok: true } })
  spyOn(console, 'log').mockImplementation(() => undefined)
  spyOn(console, 'error').mockImplementation(() => undefined)

  expect(await uploadAssets(withRelease, [file])).toBe(0)
  expect(await uploadAssets(withRelease, [file, join(dir, 'missing.txt')])).toBe(1)
})
