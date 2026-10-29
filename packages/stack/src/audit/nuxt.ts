import type { ComposeModel, Finding, Release } from './types'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const CAMEL_BOUNDARY = /([a-z0-9])([A-Z])/g
const KEY = /([A-Z_]\w*)\s*(?:\?\s*)?:/gi
const OPENS_BRACE = /^\s*\{/

const envVarFor = (key: string) => key.replace(CAMEL_BOUNDARY, '$1_$2').toUpperCase()

function braceBody(text: string, from: number): { body: string, end: number } | undefined {
  const open = text.indexOf('{', from)

  if (open < 0)
    return undefined

  let depth = 0

  for (let i = open; i < text.length; i++) {
    if (text[i] === '{')
      depth++
    else if (text[i] === '}' && --depth === 0)
      return { body: text.slice(open + 1, i), end: i }
  }

  return undefined
}

function leafPaths(body: string, prefix: string[] = []): string[][] {
  const paths: string[][] = []
  const key = new RegExp(KEY)

  for (let match = key.exec(body); match !== null; match = key.exec(body)) {
    const name = match[1] as string
    const after = match.index + match[0].length

    if (OPENS_BRACE.test(body.slice(after))) {
      const inner = braceBody(body, after)

      if (inner === undefined)
        continue

      paths.push(...leafPaths(inner.body, [...prefix, name]))
      key.lastIndex = inner.end + 1
    }
    else {
      paths.push([...prefix, name])
    }
  }

  return paths
}

function schemaEnvNames(schema: string, iface: string, prefix: string): string[] {
  const at = schema.indexOf(`interface ${iface}`)
  const body = at < 0 ? undefined : braceBody(schema, at)

  return body === undefined ? [] : leafPaths(body.body).map(path => prefix + path.map(envVarFor).join('_'))
}

// `.nuxt/types/schema.d.ts` is the resolved config, module-registered keys included, where parsing nuxt.config.ts sees only the app's own block. Nuxt 3 emits schema.d.ts, nuxt 4 runtime-config.d.ts, with the same interface names.
export function nuxtFindings(root: string, releases: Release[], model: ComposeModel | undefined): Finding[] {
  const findings: Finding[] = []
  const dirs = [...new Set(releases.map(release => release.buildContext).filter((context): context is string => context !== undefined && context !== ''))]
    .map(dir => join(root, dir))
    .filter(dir => existsSync(join(dir, 'nuxt.config.ts')))

  for (const dir of dirs) {
    const schemaPath = [join(dir, '.nuxt/types/schema.d.ts'), join(dir, '.nuxt/types/runtime-config.d.ts')].find(path => existsSync(path))
    let allowed: Set<string>
    let level: Finding['level'] = 'error'
    let source: string

    if (schemaPath !== undefined) {
      const schema = readFileSync(schemaPath, 'utf8')

      allowed = new Set([
        ...schemaEnvNames(schema, 'SharedRuntimeConfig', 'NUXT_'),
        ...schemaEnvNames(schema, 'SharedPublicRuntimeConfig', 'NUXT_PUBLIC_'),
      ])
      source = `${basename(dir)}/${schemaPath.slice(dir.length + 1)}`
    }
    else {
      const config = readFileSync(join(dir, 'nuxt.config.ts'), 'utf8')
      const at = config.indexOf('runtimeConfig:')
      const block = at < 0 ? undefined : braceBody(config, at)

      if (block === undefined)
        continue

      allowed = new Set(leafPaths(block.body).map(path => (path[0] === 'public' ? `NUXT_PUBLIC_${path.slice(1).map(envVarFor).join('_')}` : `NUXT_${path.map(envVarFor).join('_')}`)))
      level = 'warn'
      source = `${basename(dir)}/nuxt.config.ts (run \`nuxt prepare\` in ${basename(dir)} for the resolved config, modules included)`
    }

    for (const [name, service] of Object.entries(model?.services ?? {})) {
      for (const key of Object.keys(service.environment ?? {})) {
        if (key.startsWith('NUXT_') && !allowed.has(key))
          findings.push({ level, check: 'nuxt', message: `service "${name}" sets ${key}, which matches no runtimeConfig key in ${source}` })
      }
    }
  }

  return findings
}
