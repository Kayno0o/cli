import type { LinkMap, ResolvedChangelogOptions } from './types'
import { isAbsolute, join } from 'node:path'
import { getVersionString } from './git'

export interface Highlights {
  // The version's section, headings demoted to sit under the highlights title and links made absolute.
  lines: string[]
  // The page, at the version's heading.
  link: string
}

const fenceRE = /^\s*(`{3,}|~{3,})/
const headingRE = /^(#{1,6})(\s.*)$/
const schemeRE = /^[a-z][a-z\d+.-]*:/i
// A target may hold balanced parentheses, as CommonMark allows: `/wiki/Foo_(bar)`.
const inlineLinkRE = /(\]\(\s*<?)((?:[^\s<>()]|\([^\s<>()]*\))+)/g
const definitionRE = /^(\s{0,3}\[[^\]]+\]:\s*<?)([^\s<>]+)(>?(?:\s.*)?)$/
const codeSpanRE = /(`+)[\s\S]*?\1/

// The same slug GitHub and Bun.markdown give a heading: `1.44.0` is `#1440`.
export function headingAnchor(text: string) {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-')
}

// The page a target names, as `link` maps it, then made absolute against the page.
function resolveTarget(written: string, base: string, link?: LinkMap) {
  const target = link?.(written) ?? written

  if (schemeRE.test(target) || target.startsWith('//'))
    return target

  try {
    return new URL(target, base).href
  }
  catch {
    return target
  }
}

// Makes each link of a line absolute against the page, leaving code spans as written.
export function resolveLinks(line: string, base: string, link?: LinkMap) {
  const definition = definitionRE.exec(line)

  if (definition)
    return `${definition[1]}${resolveTarget(definition[2]!, base, link)}${definition[3]}`

  let rest = line
  let out = ''

  while (rest) {
    const code = codeSpanRE.exec(rest)
    const text = code ? rest.slice(0, code.index) : rest

    out += text.replace(inlineLinkRE, (_, open: string, target: string) => `${open}${resolveTarget(target, base, link)}`)

    if (!code)
      break

    out += code[0]
    rest = rest.slice(code.index + code[0].length)
  }

  return out
}

function withoutFrontmatter(lines: string[]) {
  if (lines[0]?.trim() !== '---')
    return lines

  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')

  return end === -1 ? lines : lines.slice(end + 1)
}

// The lines under `## <version>`, up to the next `## ` heading outside a code fence; a heading under it is demoted one level, below the `###` highlights title.
export function parseHighlights(source: string, version: string, url: string, link?: LinkMap): Highlights | undefined {
  const lines = withoutFrontmatter(source.split(/\r?\n/))
  const section: string[] = []
  let fence: string | undefined
  let inside = false

  for (const line of lines) {
    const marker = fenceRE.exec(line)?.[1]

    if (!fence && !marker) {
      const heading = headingRE.exec(line)

      if (heading?.[1] === '##') {
        if (inside)
          break

        inside = heading[2]!.trim() === version

        continue
      }

      if (inside && heading) {
        section.push(`${'#'.repeat(Math.min(heading[1]!.length + 1, 6))}${heading[2]}`)

        continue
      }
    }

    if (marker)
      fence = !fence ? marker : marker.startsWith(fence) ? undefined : fence

    if (inside)
      section.push(fence || marker ? line : resolveLinks(line, url, link))
  }

  while (section.length && !section[0]!.trim())
    section.shift()

  while (section.length && !section.at(-1)!.trim())
    section.pop()

  if (!section.length)
    return undefined

  return { lines: section, link: `${url.split('#')[0]}#${headingAnchor(version)}` }
}

// The `highlights.file` section of the version being released, or nothing without the option, the file or a section for it.
export async function readHighlights(options: ResolvedChangelogOptions, cwd = process.cwd()): Promise<Highlights | undefined> {
  if (!options.highlights)
    return undefined

  const { file, url, link } = options.highlights
  const source = Bun.file(isAbsolute(file) ? file : join(cwd, file))

  if (!await source.exists())
    return undefined

  return parseHighlights(await source.text(), getVersionString(options.tag, options.to), url, link)
}
