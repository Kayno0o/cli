import { $ } from 'bun'
import { parse } from '../args'
import { git } from '../git'
import { canonicalRemote, parseSshRemote } from '../remote'

const usage = `ft remote [--fix]

Checks that origin's URLs name the Forgejo host itself: tea only finds the repository when origin's host is the login's ssh_host, never through an ssh alias such as \`forgejo\` or \`gitea\`.
--fix switches every alias URL to \`git@<host>:<owner>/<repo>.git\` and proves it with \`git ls-remote\`.`

const options = {
  host: { type: 'string', description: 'the Forgejo ssh host (git.kaynooo.fr)' },
  fix: { type: 'boolean', description: 'rewrite the alias URLs' },
} as const

const HOSTNAME = /^hostname (.+)$/m

async function resolveAlias(alias: string): Promise<string | undefined> {
  return HOSTNAME.exec(await $`ssh -G ${alias}`.quiet().nothrow().text())?.[1]
}

export async function remote(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options)

  if (parsed === undefined)
    return 0

  const { values } = parsed
  const host = values.host ?? 'git.kaynooo.fr'
  const fetchUrl = await git(['remote', 'get-url', 'origin'])
  const pushUrls = (await $`git config --get-all remote.origin.pushurl`.quiet().nothrow().text()).split('\n').filter(Boolean)
  const resolved = new Map<string, string | undefined>()

  for (const url of [fetchUrl, ...pushUrls]) {
    const alias = parseSshRemote(url)?.host

    if (alias !== undefined && !resolved.has(alias))
      resolved.set(alias, await resolveAlias(alias))
  }

  const resolve = (alias: string) => resolved.get(alias)
  const changes = [fetchUrl, ...pushUrls].map(url => [url, canonicalRemote(url, host, resolve)] as const).filter((change): change is readonly [string, string] => change[1] !== undefined)

  if (changes.length === 0) {
    console.log(`origin already names ${host}: ${fetchUrl}`)

    return 0
  }

  for (const [from, to] of changes)
    console.log(`${from} -> ${to}`)

  if (values.fix !== true) {
    console.log('run `ft remote --fix` to switch them')

    return 1
  }

  const fetchChange = changes.find(([from]) => from === fetchUrl)

  if (fetchChange !== undefined)
    await git(['remote', 'set-url', 'origin', fetchChange[1]])

  for (const [from, to] of changes) {
    if (pushUrls.includes(from))
      await git(['remote', 'set-url', '--push', 'origin', to, from])
  }

  await git(['ls-remote', 'origin', 'HEAD'])
  console.log('origin switched, and git ls-remote reaches it')

  return 0
}
