import type { ComposeLoader, ComposeModel } from './types'
import { join } from 'node:path'
import { compose, composeError } from '@kaynooo/cli-kit'

// Runs `docker compose config` on the files, without interpolation so unset variables do not fail it.
export const dockerCompose: ComposeLoader = async (root, files) => {
  const result = await compose(['config', '--no-interpolate', '--format', 'json'], { flags: ['--project-directory', root, ...files.flatMap(file => ['-f', join(root, file)])], env: { COMPOSE_FILE: '' } })

  if (result.code !== 0)
    throw new Error(composeError(result))

  return JSON.parse(result.stdout) as ComposeModel
}
