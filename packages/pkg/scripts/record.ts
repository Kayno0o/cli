// Records real npm registry responses into tests/fixtures, trimmed to the fields pkg reads and to a few versions so they stay small.
const REGISTRY = 'https://registry.npmjs.org'
const DOWNLOADS = 'https://api.npmjs.org/downloads/point/last-week'
const KEPT_VERSIONS = 4
const FIXTURES = new URL('../tests/fixtures/', import.meta.url)

interface Packument {
  'time': Record<string, string>
  'versions': Record<string, Record<string, unknown>>
  'dist-tags': Record<string, string>
  [key: string]: unknown
}

async function get(url: string): Promise<{ status: number, body: unknown }> {
  const response = await fetch(url)

  return { status: response.status, body: await response.json() }
}

async function recordPackument(name: string, file: string): Promise<void> {
  const { body } = await get(`${REGISTRY}/${name.replace('/', '%2f')}`)
  const packument = body as Packument
  const latest = packument['dist-tags'].latest ?? ''
  const newest = Object.keys(packument.versions).sort((a, b) => Date.parse(packument.time[b] ?? '') - Date.parse(packument.time[a] ?? ''))
  const kept = new Set([latest, ...newest.slice(0, KEPT_VERSIONS)])
  const versions: Record<string, Record<string, unknown>> = {}
  const time: Record<string, string> = { created: packument.time.created ?? '', modified: packument.time.modified ?? '' }

  for (const version of kept) {
    const full = packument.versions[version]

    if (full === undefined)
      continue

    versions[version] = { name: full.name, version: full.version, scripts: full.scripts, deprecated: full.deprecated, license: full.license }
    time[version] = packument.time[version] ?? ''
  }

  const { name: packageName, description, license, repository, homepage } = packument
  const trimmed = { 'name': packageName, description, 'dist-tags': packument['dist-tags'], time, versions, license, repository, homepage }

  await Bun.write(new URL(file, FIXTURES), `${JSON.stringify(trimmed, null, 2)}\n`)
}

async function recordRaw(url: string, file: string): Promise<void> {
  const { status, body } = await get(url)

  await Bun.write(new URL(file, FIXTURES), `${JSON.stringify({ status, body }, null, 2)}\n`)
}

await recordPackument('left-pad', 'left-pad.json')
await recordPackument('esbuild', 'esbuild.json')
await recordPackument('@types/node', 'types-node.json')
await recordRaw(`${DOWNLOADS}/left-pad`, 'downloads-left-pad.json')
await recordRaw(`${DOWNLOADS}/esbuild`, 'downloads-esbuild.json')
await recordRaw(`${REGISTRY}/definitely-not-a-pkg-zzq`, 'registry-missing.json')
await recordRaw(`${DOWNLOADS}/definitely-not-a-pkg-zzq`, 'downloads-missing.json')
