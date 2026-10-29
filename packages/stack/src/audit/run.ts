import type { AuditOptions, AuditResult, ComposeModel, Finding, ReleaseConfig } from './types'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildFindings, composeLayout, envFindings, envRefs, gatedServices, gitignoreFindings, healthFindings, imageFindings, layoutFindings, postDeployFindings, restartFindings, routingFindings, syncFindings, versionFindings } from './checks'
import { nuxtFindings } from './nuxt'

export const CONFIG_FILE = 'release.config.ts'

const DEFINE_CONFIG_IMPORT = /import\s*\{[^}]*\bdefineConfig\b[^}]*\}\s*from\s*['"]([^'"]+)['"]/

function installed(specifier: string, root: string): boolean {
  try {
    Bun.resolveSync(specifier, root)

    return true
  }
  catch {
    return false
  }
}

// The config imports `defineConfig` from the release tool's package, often private and not installed where the audit runs, and Bun would then try to download it. It only returns its argument, so a stand-in replaces it when it cannot be resolved.
export async function loadConfig(root: string): Promise<ReleaseConfig> {
  const specifier = DEFINE_CONFIG_IMPORT.exec(await Bun.file(join(root, CONFIG_FILE)).text())?.[1]

  if (specifier !== undefined && !installed(specifier, root)) {
    Bun.plugin({
      name: 'release-stand-in',
      setup(build) {
        build.module(specifier, () => ({ exports: { defineConfig: (config: ReleaseConfig) => config }, loader: 'object' }))
      },
    })
  }

  return ((await import(join(root, CONFIG_FILE))) as { default?: ReleaseConfig }).default ?? {}
}

// The base alone, then the base with each overlay, because an overlay is only meaningful merged. Only the base model feeds the checks.
async function composeModels(options: AuditOptions, base: string | undefined, overlays: string[]): Promise<{ model: ComposeModel | undefined, findings: Finding[] }> {
  const findings: Finding[] = []
  const load = async (files: string[]) => {
    try {
      return await options.loadCompose(options.root, files)
    }
    catch (error) {
      findings.push({ level: 'error', check: 'compose', message: `docker compose config failed for ${files.join(' + ')}: ${error instanceof Error ? error.message : String(error)}` })

      return undefined
    }
  }

  if (base === undefined)
    return { model: undefined, findings }

  const model = await load([base])

  for (const overlay of overlays)
    await load([base, overlay])

  return { model, findings }
}

export async function audit(config: ReleaseConfig, options: AuditOptions): Promise<AuditResult> {
  const { root } = options
  const releases = config.releases ?? []
  const required = config.requiredServerEnv ?? []
  const { composeFiles, base, overlays } = composeLayout(root, config)
  const compose = await composeModels(options, base, overlays)
  const refs = envRefs(root, composeFiles)
  const gated = gatedServices(releases)

  const findings = [
    ...syncFindings(root, config),
    ...buildFindings(root, releases, options.env, options.home),
    ...compose.findings,
    ...envFindings(refs, required),
    ...versionFindings(refs, releases),
    ...imageFindings(config, releases, compose.model),
    ...restartFindings(config, releases, compose.model, base),
    ...postDeployFindings(releases, compose.model, base),
    ...healthFindings(gated, compose.model),
    ...routingFindings(config, gated, compose.model, base, overlays),
    ...layoutFindings(root, base, compose.model),
    ...nuxtFindings(root, releases, compose.model),
    ...gitignoreFindings(root),
  ]

  return { root, composeFiles, findings }
}

export const hasConfig = (root: string) => existsSync(join(root, CONFIG_FILE))
