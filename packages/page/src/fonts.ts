import type { Page } from 'playwright-core'
import type { FontSample } from './types'
import { inPage } from './inpage'

const MARK = 'data-page-font'
const SAMPLES_PER_STYLE = 3
const MAX_SAMPLES = 300

// Keywords naming no font of their own, which the browser maps to whatever the system configured.
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'math', 'emoji', 'fangsong', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', '-apple-system', 'blinkmacsystemfont'])
const MONOSPACE = new Set(['monospace', 'ui-monospace'])
const QUOTES = /^["']|["']$/g

export interface FontFinding {
  kind: 'font'
  selector: string
  message: string
}

/** The families of a `font-family` value, unquoted, in order. */
export function families(stack: string): string[] {
  return stack.split(',').map(family => family.trim().replace(QUOTES, '')).filter(family => family !== '')
}

/** What is wrong with drawing text declared in `stack` with `drawn`, or undefined when nothing is. */
export function fallbackOf(stack: string, drawn: string, monospaced: boolean): string | undefined {
  const declared = families(stack)
  const firstGeneric = declared.findIndex(family => GENERIC.has(family.toLowerCase()))
  const named = (firstGeneric === -1 ? declared : declared.slice(0, firstGeneric))
  const wanted = drawn.toLowerCase()

  if (named.length > 0)
    return declared.some(family => family.toLowerCase() === wanted) ? undefined : `${named.join(', ')} ${named.length === 1 ? 'is' : 'are'} not available`

  const generic = declared[0]?.toLowerCase() ?? ''

  return monospaced && !MONOSPACE.has(generic) ? `${declared[0]} resolves to a monospace font` : undefined
}

/** Text drawn in a font other than the one its stack asks for, read from the fonts Chromium actually used (CDP `CSS.getPlatformFontsForNode`). */
export async function fontFindings(page: Page): Promise<FontFinding[]> {
  const samples = await inPage<FontSample[]>(page, 'measure', 'markFontSamples', { mark: MARK, perStyle: SAMPLES_PER_STYLE, max: MAX_SAMPLES })

  if (samples.length === 0)
    return []

  const cdp = await page.context().newCDPSession(page)

  try {
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')

    const { root } = await cdp.send('DOM.getDocument', { depth: 0 })
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: `[${MARK}]` })
    const drawn = new Map<FontSample, string>()

    for (const nodeId of nodeIds) {
      const { attributes } = await cdp.send('DOM.getAttributes', { nodeId })
      const sample = samples[Number(attributes[attributes.indexOf(MARK) + 1])]
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })
      const main = fonts.toSorted((a, b) => b.glyphCount - a.glyphCount)[0]

      // Text made of emoji alone is meant to come from the emoji font.
      if (sample !== undefined && main !== undefined && !main.familyName.toLowerCase().includes('emoji'))
        drawn.set(sample, main.familyName)
    }

    const mono = new Set<string>()

    for (const name of new Set(drawn.values())) {
      if (await inPage<boolean>(page, 'measure', 'monospaced', name))
        mono.add(name)
    }

    // One finding per stack and font drawn, counting the elements of every weight and style sharing it.
    const found = new Map<string, { first: FontSample, why: string, counts: Map<string, number> }>()

    for (const [sample, font] of drawn) {
      const why = fallbackOf(sample.stack, font, mono.has(font))
      const key = `${sample.stack}|${font}`

      if (why === undefined)
        continue

      const entry = found.get(key) ?? { first: sample, why: `font-family ${sample.stack} drawn in ${font}: ${why}`, counts: new Map<string, number>() }

      entry.counts.set(sample.style, sample.count)
      found.set(key, entry)
    }

    return [...found.values()].map(({ first, why, counts }) => {
      const count = [...counts.values()].reduce((sum, each) => sum + each, 0)

      return { kind: 'font', selector: first.selector, message: count > 1 ? `${why} (${count} elements)` : why }
    })
  }
  finally {
    await cdp.detach()
    await inPage(page, 'measure', 'unmarkFontSamples', MARK)
  }
}
