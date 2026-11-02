import type { Description } from '@kaynooo/cli-kit'
import type { Host } from './checks'
import { firstLine, ownBin, readJsonText, TOOLS } from './checks'

export interface Listed extends Partial<Description> {
  bin: string
  package: string
  installed: boolean
}

const USAGE_WORD = /^Usage:\s*/

// A bin as its own --help describes it under KIT_HELP=json; an install from before that prints its text help, whose first line is kept as the summary.
export async function describeBin(host: Host, bin: string, name: string): Promise<Listed> {
  if (host.which(bin) === null)
    return { bin, package: name, installed: false }

  const own = ownBin(host, name, bin)
  const ran = await host.run(own === undefined ? [bin, '--help'] : ['bun', own, '--help'], { KIT_HELP: 'json', NO_COLOR: '1' })
  const described = readJsonText<Description>(ran.stdout)

  if (described !== undefined)
    return { bin, package: name, installed: true, ...described }

  return { bin, package: name, installed: true, summary: firstLine(ran.stdout).replace(USAGE_WORD, '') }
}

export async function listBins(host: Host): Promise<Listed[]> {
  return Promise.all(Object.entries(TOOLS).flatMap(([name, bins]) => bins.map(async bin => describeBin(host, bin, name))))
}
