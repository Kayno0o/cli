import type { AuditOptions } from '../audit/types'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'
import { parse } from '@kaynooo/cli-kit'
import { dockerCompose } from '../audit/compose'
import { errorsOf, render } from '../audit/render'
import { CONFIG_FILE, hasConfig, loadConfig, audit as runAudit } from '../audit/run'

const usage = `stack audit [dir]

Cross-checks ${CONFIG_FILE} in dir (the current directory) against the compose files it syncs: sync files and build inputs exist, env variables are required or defaulted, versionEnv matches the compose interpolation, restart and post-deploy services exist, healthchecks, routing in overlays, bind mounts documented in the header, Nuxt runtimeConfig keys and .gitignore.
Needs docker for \`docker compose config\`. Exits 1 on errors, 0 otherwise, 2 when there is no ${CONFIG_FILE}.`

const options = {
  json: { type: 'boolean', description: 'print { root, composeFiles, findings } as JSON' },
} as const

// The compose loader is a parameter so a test audits without docker.
export async function audit(args: string[], overrides: Partial<AuditOptions> = {}): Promise<number> {
  const parsed = parse(args, usage, options)

  const root = resolve(parsed.positionals[0] ?? '.')

  if (!hasConfig(root)) {
    console.error(`no ${CONFIG_FILE} in ${root}`)

    return 2
  }

  const result = await runAudit(await loadConfig(root), { root, loadCompose: dockerCompose, env: process.env, home: homedir(), ...overrides })

  console.log(parsed.values.json === true ? JSON.stringify(result, undefined, 2) : render(result))

  return errorsOf(result).length > 0 ? 1 : 0
}
