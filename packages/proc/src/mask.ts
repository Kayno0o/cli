import { basename } from 'node:path'
import { isSecretName } from '@kaynooo/cli-kit'

export const MASK = '***'

// Shapes of a secret that give themselves away whatever the name holding them: a URL password, a well known token format, a long opaque token.
const URL_PASSWORD = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]*:)[^\s'"@]{1,1024}@/gi
const TOKEN = /\b(?:gh[pousr]_|github_pat_|glpat-|sk-|xox[abprs]-|npm_|[sr]k_(?:live|test)_)[\w-]{10,}|\beyJ[\w-]+\.[\w-]+\.[\w-]+|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bBearer\s+[\w.~+/=-]{16,}/g
const OPAQUE = /(?<![\w-])(?=[\w-]{32,}(?![\w-]))(?=[\w-]*[A-Z])(?=[\w-]*\d)[\w-]+/gi
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*/

// A value with whatever looks like a secret inside it replaced.
export function maskText(value: string): string {
  return value.replace(PEM, MASK).replace(URL_PASSWORD, `$1${MASK}@`).replace(TOKEN, MASK).replace(OPAQUE, MASK)
}

// A value under its variable name: all of it when the name says secret, else the secrets inside it.
export function maskValue(name: string, value: string): string {
  if (value === '')
    return value

  return isSecretName(name) ? MASK : maskText(value)
}

export function maskEnviron(entries: [name: string, value: string][]): [name: string, value: string][] {
  return entries.map(([name, value]) => [name, maskValue(name, value)])
}

const FLAG = /^-{1,2}([\w.-]+)(=|$)/
const ASSIGNMENT_NAME = /^[\w.-]+$/
// Commands whose short -p flag carries a password; for the others (ssh, docker, psql) it is a port.
const PASSWORD_SPLIT = new Set(['sshpass'])
const PASSWORD_JOINED = new Set(['mysql', 'mysqldump', 'mysqladmin', 'mariadb', 'mariadb-dump'])

// A command line with secrets masked: `--password=x`, `--token x` and `API_KEY=x` words, and secret shapes in any other.
export function maskArgs(args: string[]): string[] {
  const command = basename(args[0] ?? '')
  let hidden = false

  return args.map((arg, index) => {
    if (hidden) {
      hidden = false

      return arg.startsWith('-') ? maskText(arg) : MASK
    }

    if (index > 0 && arg === '-p' && PASSWORD_SPLIT.has(command)) {
      hidden = true

      return arg
    }

    if (index > 0 && arg.length > 2 && arg.startsWith('-p') && PASSWORD_JOINED.has(command))
      return `-p${MASK}`

    const flag = FLAG.exec(arg)

    if (flag !== null) {
      if (flag[2] === '=')
        return isSecretName(flag[1]!) ? `${arg.slice(0, flag[0].length)}${MASK}` : maskText(arg)

      hidden = isSecretName(flag[1]!)

      return arg
    }

    const equals = arg.indexOf('=')

    return equals > 0 && ASSIGNMENT_NAME.test(arg.slice(0, equals)) ? `${arg.slice(0, equals + 1)}${maskValue(arg.slice(0, equals), arg.slice(equals + 1))}` : maskText(arg)
  })
}
