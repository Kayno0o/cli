import { chmod, chown, lstat, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isInlineSecret } from './audit'
import { entries, parseDotenv, serializeDotenv, setLine } from './dotenv'
import { writeAtomic } from './files'

export interface Left {
  key: string
  why: string
}

export interface ComposeFix {
  path: string
  env: string
  moved: string[]
  left: Left[]
  // The compose file or .env another account owns, so its mode could not be changed.
  open: string[]
  // How `docker compose config` compared before and after: undefined when nothing moved.
  check?: 'same' | 'rolled back' | 'no docker' | 'fails before'
}

// One environment entry of a compose line: its value as compose reads it, and the line with the value swapped for a reference, or why it cannot be swapped.
type Entry = { key: string, value: string } & ({ swap: (ref: string) => string } | { unmovable: string })

const MAP_ENTRY = /^(\s*)(["']?)([A-Z0-9_]+)\2(\s*:)(.*)$/
const LIST_ENTRY = /^(\s*-[ \t]*)(["']?)([A-Z0-9_]+)=(.*)$/
const TRAILING = /^\s*(?:#.*)?$/
const PLAIN_COMMENT = /\s+#.*$/
const NOT_PLAIN = /^[|>&*![{]/
const ENV_PLAIN = /^[^\s#"'\\$`]*$/

// The inside of a YAML quoted scalar starting after its opening quote: double quotes take only \\ and \" escapes here.
function quoted(text: string, quote: string): { value: string, after: string } | undefined {
  let value = ''

  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? ''
    const next = text[index + 1]

    if (quote === '\'' && char === '\'' && next === '\'') {
      value += '\''
      index++
    }
    else if (quote === '"' && char === '\\') {
      if (next !== '\\' && next !== '"')
        return undefined

      value += next
      index++
    }
    else if (char === quote) {
      return { value, after: text.slice(index + 1) }
    }
    else {
      value += char
    }
  }

  return undefined
}

function plain(text: string): { value: string, after: string } {
  const value = text.replace(PLAIN_COMMENT, '').trimEnd()

  return { value, after: text.slice(value.length) }
}

export function composeEntry(line: string): Entry | undefined {
  const map = MAP_ENTRY.exec(line)

  if (map !== null) {
    const [, indent = '', keyQuote = '', key = '', colon = '', spaced = ''] = map
    const rest = spaced.trimStart()
    const separator = colon + spaced.slice(0, spaced.length - rest.length)
    const quote = rest[0] === '"' || rest[0] === '\'' ? rest[0] : ''
    const scalar = quote === '' ? plain(rest) : quoted(rest.slice(1), quote)

    if (scalar === undefined || !TRAILING.test(scalar.after))
      return { key, value: rest, unmovable: 'its value is written in a form ev does not rewrite' }

    if (quote === '' && NOT_PLAIN.test(scalar.value))
      return { key, value: scalar.value, unmovable: 'its value is a block, anchor, alias, tag or collection' }

    return { key, value: scalar.value, swap: ref => `${indent}${keyQuote}${key}${keyQuote}${separator}${quote}${ref}${quote}${scalar.after}` }
  }

  const list = LIST_ENTRY.exec(line)

  if (list === null)
    return undefined

  const [, dash = '', quote = '', key = '', rest = ''] = list
  const scalar = quote === '' ? plain(rest) : quoted(rest, quote)

  if (scalar === undefined || !TRAILING.test(scalar.after))
    return { key, value: rest, unmovable: 'its value is written in a form ev does not rewrite' }

  return { key, value: scalar.value, swap: ref => `${dash}${quote}${key}=${ref}${quote}${scalar.after}` }
}

// The .env line holding a value compose and Bun both read literally: plain when nothing needs quoting, single-quoted otherwise, double-quoted with each `$` escaped when it holds one since Bun expands it even in single quotes.
export function envLine(key: string, value: string): string | undefined {
  if (ENV_PLAIN.test(value))
    return `${key}=${value}`

  if (value.includes('$'))
    return value.includes('\n') ? undefined : `${key}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$')}"`

  return value.includes('\'') || value.includes('\n') ? undefined : `${key}='${value}'`
}

// A link, dangling or not: writing through it would change a file elsewhere.
async function isLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink()
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return false

    throw error
  }
}

// What `docker compose config` resolves the file to, never printed; undefined when it fails.
async function resolved(path: string): Promise<string | undefined> {
  const run = Bun.spawn(['docker', 'compose', '-f', path, 'config', '--format', 'json'], { cwd: dirname(path), stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
  const [out, code] = await Promise.all([new Response(run.stdout).text(), run.exited])

  return code === 0 ? out : undefined
}

interface Resolved {
  services?: Record<string, { environment?: Record<string, unknown> }>
}

// The services a key reached only once moved: they load the .env through env_file.
function gainedBy(before: string, after: string, key: string): string[] {
  const services = (config: string) => Object.entries((JSON.parse(config) as Resolved).services ?? {})
  const had = new Set(services(before).filter(([, service]) => service.environment?.[key] !== undefined).map(([name]) => name))

  return services(after).filter(([name, service]) => service.environment?.[key] !== undefined && !had.has(name)).map(([name]) => name)
}

// Takes others, and the group too when `group`, out of the file's mode. False when another account owns the file, so only it or root can change its mode.
export async function shutOthersOut(path: string, group = false): Promise<boolean> {
  try {
    await chmod(path, (await stat(path)).mode & (group ? 0o700 : 0o770))

    return true
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM')
      return false

    throw error
  }
}

// Moves each inline secret of a compose file into the .env beside it, swapping the value for `${KEY}`, then shuts others out of both. A key the .env sets to another value stays put, and a move `docker compose config` resolves differently is put back.
export async function fixCompose(path: string, group = false): Promise<ComposeFix> {
  const env = join(dirname(path), '.env')
  const compose = await Bun.file(path).text()
  const envBefore = await Bun.file(env).exists() ? await Bun.file(env).text() : undefined
  const dotenv = parseDotenv(envBefore ?? '')
  const known = entries(dotenv)
  const fix: ComposeFix = { path, env, moved: [], left: [], open: [] }
  const linked = await isLink(env)

  const lines = compose.split('\n').map((line) => {
    const entry = composeEntry(line)

    if (entry === undefined || !isInlineSecret(entry.key, entry.value))
      return line

    const { key } = entry

    if ('unmovable' in entry) {
      fix.left.push({ key, why: entry.unmovable })

      return line
    }

    if (linked) {
      fix.left.push({ key, why: 'its .env is a symbolic link' })

      return line
    }

    if (entry.value.replaceAll('$$', '').includes('$')) {
      fix.left.push({ key, why: 'its value reads another variable' })

      return line
    }

    const value = entry.value.replaceAll('$$', '$')
    const existing = known.get(key)

    if (existing === undefined) {
      const raw = envLine(key, value)

      if (raw === undefined) {
        fix.left.push({ key, why: 'its value holds a quote or line break a .env cannot keep literal' })

        return line
      }

      setLine(dotenv, key, value, raw)
      known.set(key, value)
    }
    else if (existing !== value) {
      fix.left.push({ key, why: `${env.slice(env.lastIndexOf('/') + 1)} already sets it to another value` })

      return line
    }

    if (!fix.moved.includes(key))
      fix.moved.push(key)

    return entry.swap(`\${${key}}`)
  })

  if (fix.moved.length > 0)
    await move(fix, compose, lines.join('\n'), envBefore, serializeDotenv(dotenv))

  for (const file of [path, env]) {
    if (!(file === env && linked) && await Bun.file(file).exists() && !await shutOthersOut(file, group))
      fix.open.push(file)
  }

  return fix
}

async function move(fix: ComposeFix, compose: string, composeAfter: string, envBefore: string | undefined, envAfter: string): Promise<void> {
  const { path, env } = fix
  const docker = Bun.which('docker') !== null
  const before = docker ? await resolved(path) : undefined

  if (envBefore === undefined) {
    await writeAtomic(env, envAfter)

    // A root run gives the .env to whoever owns the compose file; anyone else already owns what they write.
    const { uid, gid } = await stat(path)

    try {
      await chown(env, uid, gid)
    }
    catch {}
  }
  else {
    await writeAtomic(env, envAfter)
  }

  await writeAtomic(path, composeAfter)

  if (!docker) {
    fix.check = 'no docker'

    return
  }

  if (before === undefined) {
    fix.check = 'fails before'

    return
  }

  const after = await resolved(path)

  if (after === before) {
    fix.check = 'same'

    return
  }

  await writeAtomic(path, compose)

  if (envBefore === undefined)
    await rm(env)
  else
    await writeAtomic(env, envBefore)

  fix.check = 'rolled back'
  fix.left.push(...fix.moved.map((key) => {
    const gained = after === undefined ? [] : gainedBy(before, after, key)

    return { key, why: gained.length > 0 ? `${gained.join(', ')} ${gained.length > 1 ? 'load' : 'loads'} the .env through env_file and would gain it, so it was put back` : 'docker compose config resolved differently once moved, so it was put back' }
  }))
  fix.moved = []
}
