import type { Container } from './parse'
import { runCommand } from '@kaynooo/cli-kit'
import { parseDockerPs } from './parse'

const FORMAT = '{{.Names}}\t{{.Ports}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}'

// The running containers with their published ports and compose labels; none, quietly, when docker is missing or its daemon unreachable.
export async function dockerContainers(): Promise<Container[]> {
  if (Bun.which('docker') === null)
    return []

  try {
    const ran = await runCommand(['docker', 'ps', '--format', FORMAT], { timeoutMs: 4000 })

    return ran.code === 0 ? parseDockerPs(ran.text) : []
  }
  catch {
    return []
  }
}
