import { stripAnsi } from '@kaynooo/cli-kit'

const TRAILING_SLASH = /\/$/

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

// The regex matching the working directory as a path of its own, never inside a longer one.
function cwdPath(cwd: string): RegExp {
  return new RegExp(`(?<![\\w./~-])${escapeRegExp(cwd.replace(TRAILING_SLASH, ''))}/`, 'g')
}

// The output without colour codes and with paths under the working directory made relative, which loses nothing the reader needs.
export function tidy(text: string, cwd = process.cwd()): string {
  const plain = stripAnsi(text)

  return cwd === '/' || cwd === '' ? plain : plain.replaceAll(cwdPath(cwd), './')
}
