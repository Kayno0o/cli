import type { AuditOptions } from '../audit/types'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'
import { fail, jsonOption, limitOf, limitOptions, parse, printJson } from '@kaynooo/cli-kit'
import { dockerCompose } from '../audit/compose'
import { errorsOf, render } from '../audit/render'
import { CONFIG_FILE, hasConfig, loadConfig, audit as runAudit } from '../audit/run'

const usage = `stack audit [dir]

Cross-checks ${CONFIG_FILE} in dir (the current directory) against the compose files it syncs: sync files and build inputs exist, env variables are required or defaulted, versionEnv matches the compose interpolation, restart and post-deploy services exist, healthchecks, routing in overlays, bind mounts documented in the header, Nuxt runtimeConfig keys and .gitignore.
Lists at most 25 errors and 25 warnings, the count of the rest after them (--limit <n>, --full for all); --json is never cut.
Needs docker for \`docker compose config\`.\n\nExits 0 when it finds no error, 1 when it finds one, 2 when there is no ${CONFIG_FILE}.`

const AUDIT_LIMIT = 25

const options = {
  ...limitOptions(AUDIT_LIMIT),
  json: jsonOption('{ root, composeFiles, findings }'),
} as const

// The compose loader is a parameter so a test audits without docker.
export async function audit(args: string[], overrides: Partial<AuditOptions> = {}): Promise<number> {
  const parsed = parse(args, usage, options)

  const root = resolve(parsed.positionals[0] ?? '.')

  if (!hasConfig(root)) {
    fail(`no ${CONFIG_FILE} in ${root}`)
  }

  const result = await runAudit(await loadConfig(root), { root, loadCompose: dockerCompose, env: process.env, home: homedir(), ...overrides })

  if (parsed.values.json === true)
    printJson(result)
  else
    console.log(render(result, limitOf(parsed.values, AUDIT_LIMIT)))

  return errorsOf(result).length > 0 ? 1 : 0
}
