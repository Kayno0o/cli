import type { Key } from './signature'
import { readdirSync } from 'node:fs'
import process from 'node:process'
import { badUsage, fail, formatAge, warn } from '@kaynooo/cli-kit'

/** `gh:owner/repo` or `fj:owner/repo`, with `@tag` for one release rather than the latest. */
export interface ReleaseSpec {
  forge: 'gh' | 'fj'
  owner: string
  repo: string
  tag?: string
}

interface Asset { name: string, url: string, digest?: string }

interface Release { tag: string, published: string, assets: Asset[] }

/** The release picked, its asset for this machine and what checks it: a checksums file, else the sha256 the forge gives, and a signature beside either. */
export interface Resolved {
  spec: string
  tag: string
  published: string
  asset: Asset
  sums?: string
  sha256?: string
  sig?: string
}

/** The machine an asset is picked for. */
export interface Platform {
  os: NodeJS.Platform
  arch: string
  musl: boolean
}

const SPEC = /^(gh|fj):([\w.-]+)\/([\w.-]+)(?:@(\S+))?$/
// pkg's rule: a release younger than this may still be pulled for being malicious.
const MIN_AGE = 14 * 24 * 3600_000
const DIGEST = /^sha256:([0-9a-f]{64})$/
// Files a release ships beside its builds: checksums, signatures, certificates, SBOMs, provenance and system packages.
const NOT_A_BUILD = /\.(?:sha256(?:sum)?|sha512(?:sum)?|md5|asc|sig|minisig|pem|crt|cert|sbom|spdx|cdx|json|jsonl|txt|deb|rpm|apk|msi|dmg|pkg|sh)$|(?:checksums?|sums?)$/i
const SUMS = /(?:^|[-_.])(?:sha256sums?|checksums?)(?:\.txt)?$/i
const OS_WORDS: Record<string, RegExp> = {
  linux: /linux/i,
  darwin: /darwin|mac-?os|apple|osx/i,
  win32: /windows|(?<![a-z])win(?:32|64)?(?=[-_.]|$)/i,
}
const ARCH_WORDS: Record<string, RegExp> = {
  x64: /x86[-_]64|amd64|x64(?!\d)/i,
  arm64: /aarch64|arm64/i,
}
const ANY_ARCH = /universal/i
const GNU = /gnu|glibc/i
const MUSL = /musl/i
const FORMATS = [/\.(?:tar\.gz|tgz)$/i, /\.tar\.xz$/i, /\.tar\.(?:zst|bz2)$/i, /\.zip$/i]

export function parseSpec(arg: string): ReleaseSpec | undefined {
  const [, forge, owner = '', repo = '', tag] = SPEC.exec(arg) ?? []

  if (forge === undefined)
    return undefined

  return { forge: forge as ReleaseSpec['forge'], owner, repo, ...tag === undefined ? {} : { tag } }
}

/** The spec without its tag, as the ledger keeps it for `dl outdated` to ask for the latest. */
export function specName(spec: ReleaseSpec): string {
  return `${spec.forge}:${spec.owner}/${spec.repo}`
}

export function thisPlatform(): Platform {
  let musl = false

  try {
    musl = process.platform === 'linux' && readdirSync('/lib').some(file => file.startsWith('ld-musl-'))
  }
  catch {}

  return { os: process.platform, arch: process.arch, musl }
}

// GitHub's API, or the Forgejo instance's; both answer a release list of the same shape. A token in GITHUB_TOKEN or GH_TOKEN lifts GitHub's limit of 60 requests an hour.
function releasesUrl(spec: ReleaseSpec): { url: string, headers: Record<string, string> } {
  const path = `repos/${spec.owner}/${spec.repo}/releases`
  const tagged = spec.tag === undefined ? '' : `/tags/${encodeURIComponent(spec.tag)}`

  if (spec.forge === 'fj')
    return { url: `${process.env.DL_FORGEJO_URL ?? 'https://git.kaynooo.fr'}/api/v1/${path}${tagged || '?limit=30'}`, headers: { accept: 'application/json' } }

  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  const headers: Record<string, string> = { 'accept': 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }

  if (token !== undefined && token !== '')
    headers.authorization = `Bearer ${token}`

  return { url: `${process.env.DL_GITHUB_API ?? 'https://api.github.com'}/${path}${tagged || '?per_page=30'}`, headers }
}

interface ApiRelease {
  tag_name: string
  draft: boolean
  prerelease: boolean
  published_at: string | null
  assets: { name: string, browser_download_url: string, digest?: string | null }[]
}

async function releases(spec: ReleaseSpec): Promise<Release[]> {
  const { url, headers } = releasesUrl(spec)
  let response: Response

  try {
    response = await fetch(url, { headers })
  }
  catch (error) {
    return fail(`cannot reach ${url}: ${error instanceof Error ? error.message : String(error)}`, 1)
  }

  if (response.status === 404)
    fail(`${specName(spec)} has no release${spec.tag === undefined ? 's' : ` ${spec.tag}`}`, 1)

  if (!response.ok) {
    const limited = response.headers.get('x-ratelimit-remaining') === '0'

    fail(`${url} answered ${response.status} ${response.statusText}`.trimEnd(), 1, limited ? 'GitHub\'s hourly limit is reached: set GITHUB_TOKEN to a token to lift it' : undefined)
  }

  const body = await response.json() as ApiRelease | ApiRelease[]

  return (Array.isArray(body) ? body : [body])
    .filter(release => !release.draft && (spec.tag !== undefined || !release.prerelease) && release.published_at !== null)
    .map(release => ({
      tag: release.tag_name,
      published: release.published_at!,
      assets: release.assets.map(asset => ({ name: asset.name, url: asset.browser_download_url, ...typeof asset.digest === 'string' ? { digest: asset.digest } : {} })),
    }))
}

async function newestFirst(spec: ReleaseSpec): Promise<Release[]> {
  return (await releases(spec)).sort((a, b) => Date.parse(b.published) - Date.parse(a.published))
}

function oldEnough(release: Release, now: number): boolean {
  return now - Date.parse(release.published) >= MIN_AGE
}

/** The newest release at least two weeks old, the one `dl outdated` compares an install with. */
export async function latestRelease(spec: ReleaseSpec, now = Date.now()): Promise<Release | undefined> {
  return (await newestFirst(spec)).find(release => oldEnough(release, now))
}

/** The release to install: the one tagged, else the newest at least two weeks old, or the newest with `fresh`; a newer one skipped is said on stderr. */
export async function pickRelease(spec: ReleaseSpec, fresh: boolean, now = Date.now()): Promise<Release> {
  const found = await newestFirst(spec)
  const newest = found[0] ?? fail(`${specName(spec)} has no published release`, 1)

  if (spec.tag !== undefined || fresh)
    return newest

  const old = found.find(release => oldEnough(release, now))
  const skipped = found.slice(0, old === undefined ? found.length : found.indexOf(old))
  const said = skipped.map(release => `${release.tag} (${formatAge(release.published, now)})`).join(', ')

  if (old === undefined)
    return fail(`no release of ${specName(spec)} is two weeks old yet: ${said}`, 1, '--fresh takes the newest anyway')

  if (skipped.length > 0)
    warn(`${specName(spec)}: took ${old.tag}, skipped ${said} as under two weeks old; --fresh takes the newest`)

  return old
}

function rank<T>(items: T[], score: (item: T) => number): T[] {
  const best = Math.min(...items.map(score))

  return items.filter(item => score(item) === best)
}

// The build linked as the system is first, one naming no libc next.
function libcRank(name: string, musl: boolean): number {
  if (GNU.test(name))
    return 0

  if (MUSL.test(name))
    return musl ? 0 : 2

  return 1
}

/** The build of `assets` for `platform`: its OS and arch named, else the only ones naming none; libc and archive format break a tie, and a tie left fails listing them. */
export function pickAsset(assets: Asset[], platform: Platform, wanted?: string): Asset {
  const builds = assets.filter(asset => !NOT_A_BUILD.test(asset.name))
  const listed = (list: Asset[]) => list.map(asset => asset.name).join(', ')

  if (wanted !== undefined) {
    const glob = new Bun.Glob(wanted)
    const named = builds.filter(asset => wanted.includes('*') ? glob.match(asset.name) : asset.name.includes(wanted))

    if (named.length === 1)
      return named[0]!

    return fail(named.length === 0 ? `no asset matches --asset ${wanted}: ${listed(builds)}` : `several assets match --asset ${wanted}: ${listed(named)}`, 1)
  }

  const osWord = OS_WORDS[platform.os]
  const archWord = ARCH_WORDS[platform.arch]
  const namesOs = builds.filter(asset => Object.values(OS_WORDS).some(word => word.test(asset.name)))
  let fit = namesOs.length === 0 ? builds : builds.filter(asset => osWord?.test(asset.name) === true)
  const namesArch = fit.filter(asset => Object.values(ARCH_WORDS).some(word => word.test(asset.name)))

  fit = namesArch.length === 0 ? fit : fit.filter(asset => archWord?.test(asset.name) === true || ANY_ARCH.test(asset.name))

  // A glibc build does not run on musl; on glibc either does, the glibc one linked as the system is
  if (platform.musl)
    fit = fit.filter(asset => !GNU.test(asset.name))

  if (fit.length === 0)
    return fail(`no asset is built for ${platform.os} ${platform.arch}${platform.musl ? ' musl' : ''}: ${listed(builds)}`, 1, 'pick one with --asset <part of its name>')

  fit = rank(fit, asset => libcRank(asset.name, platform.musl))
  fit = rank(fit, asset => ARCH_WORDS[platform.arch]?.test(asset.name) === true ? 0 : 1)
  fit = rank(fit, (asset) => {
    const format = FORMATS.findIndex(each => each.test(asset.name))

    return format === -1 ? FORMATS.length : format
  })

  return fit.length === 1 ? fit[0]! : fail(`several assets fit ${platform.os} ${platform.arch}: ${listed(fit)}`, 1, 'pick one with --asset <part of its name>')
}

// The signature of `target` among the assets, by the suffixes the key's tool signs with.
function signatureOf(assets: Asset[], target: string, key: Key): Asset | undefined {
  const suffixes = { gpg: ['.asc', '.sig', '.gpg'], minisign: ['.minisig'], cosign: ['.sig'] }[key.tool]

  return suffixes.map(suffix => assets.find(asset => asset.name === `${target}${suffix}`)).find(asset => asset !== undefined)
}

/** Resolves a release spec to the asset to download and what checks it; with `key`, the release must ship a signature of the checksums file, or of the asset without one. */
export async function resolveRelease(spec: ReleaseSpec, options: { fresh: boolean, asset?: string | undefined, key?: Key | undefined, platform?: Platform }): Promise<Resolved> {
  const release = await pickRelease(spec, options.fresh)
  const asset = pickAsset(release.assets, options.platform ?? thisPlatform(), options.asset)
  const own = release.assets.find(each => each.name.startsWith(`${asset.name}.sha256`))
  const sums = own ?? release.assets.find(each => SUMS.test(each.name))
  const sha256 = sums === undefined ? DIGEST.exec(asset.digest ?? '')?.[1] : undefined
  const signature = options.key === undefined ? undefined : signatureOf(release.assets, (sums ?? asset).name, options.key)

  if (options.key !== undefined && signature === undefined)
    fail(`${specName(spec)} ${release.tag} ships no ${options.key.tool} signature of ${(sums ?? asset).name}`, 1)

  return {
    spec: specName(spec),
    tag: release.tag,
    published: release.published,
    asset,
    ...sums === undefined ? {} : { sums: sums.url },
    ...sha256 === undefined ? {} : { sha256 },
    ...signature === undefined ? {} : { sig: signature.url },
  }
}

/** Refuses the options a release spec decides by itself, and the release options on a URL. */
export function assertReleaseOptions(isRelease: boolean, values: { fresh?: boolean, asset?: string }): void {
  if (!isRelease && (values.fresh === true || values.asset !== undefined))
    badUsage('--fresh and --asset go with a release, gh:owner/repo or fj:owner/repo')
}
