import type { Host, Result } from './check-tools'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { HOOKS_REQUIRES } from './catalog'
import { checkDlBins, checkTea, checkWakatime } from './check-forge'
import { checkCompletions, checkHooks, checkWorkspace, hooksWiring, MARKETPLACE } from './check-host'
import { binDir, checkBun, checkDeadBins, checkNeeds, checkTool, deadBins, firstLine, INFO_AT_ONCE, isInstalled, NETWORK_ERROR, ownBin, readJsonText, TOOLS } from './check-tools'

export { binDir, checkBun, checkCompletions, checkDeadBins, checkDlBins, checkHooks, checkNeeds, checkTea, checkTool, checkWakatime, checkWorkspace, deadBins, firstLine, hooksWiring, isInstalled, MARKETPLACE, ownBin, readJsonText, TOOLS }
export type { Host, Result }

const toolCheck = (name: string) => name.slice(name.indexOf('/') + 1)
const OTHER_CHECKS = ['tea', 'hooks', 'needs', 'bun', 'completions', 'dead-bins', 'workspace', 'wakatime', 'dl-bins']
const FORGEJO = '@kaynooo/cli-forgejo'
const DL = '@kaynooo/cli-dl'
const WORKSPACE = '@kaynooo/cli-workspace'

// Every name `runChecks` can be limited to.
export const CHECK_NAMES = [...Object.keys(TOOLS).map(toolCheck), ...OTHER_CHECKS]

// The checks named in `only`; with it empty, those of what is installed: a package left out is no failure.
export async function runChecks(host: Host, only: readonly string[] = [], { offline = false }: { offline?: boolean } = {}): Promise<Result[]> {
  const wanted = (check: string) => only.length === 0 || only.includes(check)
  const entries = Object.entries(TOOLS).filter(([name]) => only.length === 0 ? isInstalled(host, name) : wanted(toolCheck(name)))
  const { plugin, mod } = hooksWiring(host)
  const hooks = only.length > 0 || plugin || mod !== undefined || isInstalled(host, HOOKS_REQUIRES)
  const tools: Result[] = []
  let registryDown: string | undefined

  for (let at = 0; at < entries.length; at += INFO_AT_ONCE) {
    const batch = await Promise.all(entries.slice(at, at + INFO_AT_ONCE).map(async ([name, bins]) => checkTool(host, name, bins, { offline, ...(registryDown === undefined ? {} : { registryDown }) })))

    tools.push(...batch)

    if (!offline && registryDown === undefined) {
      const marker = 'the registry did not answer: '
      const failed = batch.find(result => result.detail.includes(marker) && NETWORK_ERROR.test(result.detail))

      if (failed !== undefined)
        registryDown = failed.detail.slice(failed.detail.indexOf(marker) + marker.length)
    }
  }

  return [
    ...tools,
    ...wanted('tea') && (only.length > 0 || isInstalled(host, FORGEJO)) ? [await checkTea(host)] : [],
    ...wanted('hooks') && hooks ? [checkHooks(host)] : [],
    ...wanted('needs') ? [checkNeeds(host)] : [],
    ...wanted('bun') ? [checkBun(host)] : [],
    ...wanted('completions') ? [checkCompletions(host)] : [],
    ...wanted('dead-bins') ? [checkDeadBins(host)] : [],
    ...wanted('workspace') && (only.length > 0 || isInstalled(host, WORKSPACE) || isInstalled(host, '@kaynooo/cli-pkg')) ? [checkWorkspace(host)] : [],
    ...wanted('wakatime') && !offline && existsSync(join(host.home, '.wakatime.cfg')) ? [await checkWakatime(host)] : [],
    ...wanted('dl-bins') && !offline && (only.length > 0 || isInstalled(host, DL)) ? [await checkDlBins(host)] : [],
  ]
}
