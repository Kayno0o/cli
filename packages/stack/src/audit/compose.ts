import type { ComposeLoader, ComposeModel } from './types'
import { join } from 'node:path'
import process from 'node:process'

// Runs `docker compose config` on the files, without interpolation so unset variables do not fail it.
export const dockerCompose: ComposeLoader = async (root, files) => {
  const args = ['docker', 'compose', '--project-directory', root, ...files.flatMap(file => ['-f', join(root, file)]), 'config', '--no-interpolate', '--format', 'json']
  let run

  try {
    run = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, COMPOSE_FILE: '' } })
  }
  catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error))
  }

  const [out, err, code] = await Promise.all([run.stdout.text(), run.stderr.text(), run.exited])

  if (code !== 0)
    throw new Error(err.trim().split('\n').pop())

  return JSON.parse(out) as ComposeModel
}
