import type { AuthorInfo, ChangelogOptions } from '../src/types'
import { afterEach, expect, it, spyOn } from 'bun:test'
import { resolveAuthorInfo } from '../src/gitea'

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
  ;(globalThis.fetch as unknown as { mockRestore: () => void }).mockRestore()
})

it('takes the login from the author\'s first commit, without searching', async () => {
  const asked = answer({ '/repos/owner/repo/commits/abc': { author: { login: 'ada' } } })

  expect((await resolveAuthorInfo(options, author(['abc']))).login).toBe('ada')
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
