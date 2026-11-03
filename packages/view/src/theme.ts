import type { Colors } from '@kaynooo/cli-kit'
import process from 'node:process'
import { link, paint, role } from '@kaynooo/cli-kit'

// What each part of a document is drawn in, the roles every @kaynooo CLI colours its data with.
export interface Theme {
  heading: (text: string) => string
  code: (text: string) => string
  path: (text: string) => string
  id: (text: string) => string
  dim: (text: string) => string
  bold: (text: string) => string
  italic: (text: string) => string
  strike: (text: string) => string
  added: (text: string) => string
  removed: (text: string) => string
  accent: (text: string) => string
  keyword: (text: string) => string
  string: (text: string) => string
  number: (text: string) => string
  link: (text: string, url: string) => string
}

interface Stream { isTTY?: boolean }

export function themeFor(stream: Stream = process.stdout, env: Record<string, string | undefined> = process.env): Theme {
  const colors: Colors = paint(stream, env)
  const accent = role('accent', stream, env)
  const path = role('path', stream, env)

  return {
    heading: text => accent(colors.bold(text)),
    code: role('id', stream, env),
    path,
    id: role('id', stream, env),
    dim: role('label', stream, env),
    bold: colors.bold,
    italic: colors.italic,
    strike: colors.strikethrough,
    added: colors.green,
    removed: colors.red,
    accent,
    keyword: colors.magenta,
    string: colors.green,
    number: colors.yellow,
    link: (text, url) => path(colors.underline(link(text, url, stream, env))),
  }
}
