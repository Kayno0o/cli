import { existsSync, readFileSync } from 'node:fs'
import { entries, parseDotenv } from '@kaynooo/cli-env/dotenv'

/** The variables of a .env file, without loading them into the environment; none when the file is missing. */
export function readEnvFile(path: string): Record<string, string> {
  return existsSync(path) ? Object.fromEntries(entries(parseDotenv(readFileSync(path, 'utf8')))) : {}
}
