import { braceExpand } from '@kaynooo/cli-kit/shell'
import { ENV_FILE, TEMPLATE } from './files'

const REDIRECT = /^\d*[<>]+&?/
const ENVRC = '.envrc'
const PROC_ENVIRON = /^\/proc\/[^/]+\/environ$/
// Names a glob could stand for, to tell whether it reaches an env file.
const ENV_SAMPLES = ['.env', '.env.local', '.env.production', '.envrc']
const REGEX_SPECIALS = /[.+^${}()|\\[\]]/g
const NEGATED_CLASS = /^!/
const GLOB_CHAR = /[*?[]/

export const EXCLUDE_OPTIONS = new Set(['--exclude', '--exclude-dir', '-g', '--glob', '--iglob'])

// The name past the last `/`, or past the `:` of `HEAD~1:api/.env` as git spells a file at a revision; the `.env*` glob reaches one too.
export function isEnvFile(path: string): boolean {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf(':')) + 1)

  return (ENV_FILE.test(name) || name === '.env*' || name === ENVRC) && !TEMPLATE.test(name)
}

// The regex a shell glob stands for, `*` and `?` matching a name's characters and `[...]` a class.
function globRegex(glob: string): RegExp {
  let source = ''

  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] ?? ''
    const close = char === '[' ? glob.indexOf(']', i + 2) : -1

    if (char === '*') {
      source += '.*'
    }
    else if (char === '?') {
      source += '.'
    }
    else if (close === -1) {
      source += char.replace(REGEX_SPECIALS, String.raw`\$&`)
    }
    else {
      source += `[${glob.slice(i + 1, close).replace(NEGATED_CLASS, '^')}]`
      i = close
    }
  }

  return new RegExp(`^${source}$`)
}

// A dotted glob such as `.en?` or `.e*` reaching an env file; the shell never matches a leading dot with a wildcard, so the glob has to spell it.
function globReachesEnv(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)

  if (!name.startsWith('.') || !GLOB_CHAR.test(name))
    return false

  const regex = globRegex(name)

  return ENV_SAMPLES.some(sample => regex.test(sample))
}

// Whether the path or glob a file tool is given reaches an env file, `{a,b}` lists and wildcards included.
export function reachesEnvFile(path: string): boolean {
  return braceExpand(path).some(each => isEnvFile(each) || globReachesEnv(each))
}

// The path a word stands for, past any redirect and `--flag=` prefix.
function targetOf(word: string): string {
  const bare = word.replace(REDIRECT, '')

  return bare.includes('=') ? bare.slice(bare.indexOf('=') + 1) : bare
}

// A word naming an env file, past any redirect and `--flag=` prefix; an `--env-file` value only loads it, so it is let through.
export function namesEnvFile(word: string, previous: string | undefined, isGlob: boolean): boolean {
  if (previous === '--env-file' || word.startsWith('--env-file=') || word.startsWith('--exclude') || EXCLUDE_OPTIONS.has(previous ?? ''))
    return false

  const path = targetOf(word)

  return isEnvFile(path) || PROC_ENVIRON.test(path) || (isGlob && globReachesEnv(path))
}
