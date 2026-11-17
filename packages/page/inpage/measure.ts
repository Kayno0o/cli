import type { DomFinding, FontSample } from '../src/types'

// Runs in the page: src/inpage.ts sends this file's transpiled source with a call to one of its exports, so it may import types alone.

const NUMBERS = /[\d.]+/g
const NOT_SPACE = /\S/

interface ShiftState {
  score: number
  node: Node | null
}

declare global {
  var __pageShifts: ShiftState | undefined
}

/** Added before the page loads: keeps the cumulative layout shift score (its worst session window) and the node that moved most in it. */
export function watchShifts(): void {
  const state: ShiftState = { score: 0, node: null }
  let session = 0
  let first = 0
  let last = 0
  let biggest = 0
  let biggestNode: Node | null = null

  globalThis.__pageShifts = state

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & { value: number, hadRecentInput: boolean, sources?: { node?: Node | null }[] })[]) {
        if (entry.hadRecentInput)
          continue

        // A window closes after a second without a shift, or five seconds after it opened.
        if (entry.startTime - last > 1000 || entry.startTime - first > 5000) {
          session = 0
          first = entry.startTime
          biggest = 0
          biggestNode = null
        }

        session += entry.value
        last = entry.startTime

        if (entry.value > biggest) {
          biggest = entry.value
          biggestNode = entry.sources?.find(source => source.node !== undefined && source.node !== null)?.node ?? null
        }

        if (session > state.score) {
          state.score = session
          state.node = biggestNode
        }
      }
    }).observe({ type: 'layout-shift', buffered: true })
  }
  catch {}
}

function describe(element: Element): string {
  const tag = element.tagName.toLowerCase()

  if (element.id !== '')
    return `${tag}#${element.id}`

  const classes = [...element.classList].slice(0, 2)
  const own = classes.length > 0 ? `${tag}.${classes.join('.')}` : tag
  const parent = element.parentElement

  if (classes.length > 0 || parent === null || parent === document.body || parent === document.documentElement || element === document.body)
    return own

  return `${describe(parent)} > ${own}`
}

function visible(element: Element): boolean {
  const rect = element.getBoundingClientRect()
  const style = getComputedStyle(element)

  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.opacity !== '0'
}

function alpha(color: string): number {
  if (color === 'transparent')
    return 0

  const parts = color.match(NUMBERS) ?? []

  return color.startsWith('rgba') || parts.length === 4 ? Number(parts[3] ?? 1) : 1
}

// The colour painted behind an element by its nearest ancestor with an opaque enough background.
function backdrop(element: Element | null): string {
  for (let at = element; at !== null; at = at.parentElement) {
    const color = getComputedStyle(at).backgroundColor

    if (alpha(color) > 0)
      return color
  }

  return 'rgb(255, 255, 255)'
}

// The sides on which the element draws an edge of its own: each side with a visible border, or all four for a background unlike what is behind it.
function edgesOf(element: Element): string[] {
  const style = getComputedStyle(element)
  const sides = ['top', 'right', 'bottom', 'left']

  if (style.backgroundImage !== 'none' || (alpha(style.backgroundColor) > 0 && style.backgroundColor !== backdrop(element.parentElement)))
    return sides

  return sides.filter(side => Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0 && style.getPropertyValue(`border-${side}-style`) !== 'none' && alpha(style.getPropertyValue(`border-${side}-color`)) > 0)
}

/** Every DOM-measured defect at the current width; `phone` raises the smallest tap target from 24px to 44px. */
export function measureDom(phone: boolean): DomFinding[] {
  const findings: DomFinding[] = []
  const root = document.scrollingElement ?? document.documentElement
  const viewport = root.clientWidth
  const px = (value: number): string => `${Math.round(value)}px`

  // Overflow: the page scrolls sideways; name the elements where it starts, not every descendant riding along.
  const by = root.scrollWidth - viewport

  if (by > 0) {
    const escapes = (element: Element): boolean => {
      for (let at: Element | null = element; at !== null && at !== document.body; at = at.parentElement) {
        const style = getComputedStyle(at)

        if (style.position === 'fixed')
          return false

        if (at !== element && style.overflowX !== 'visible')
          return false
      }

      return true
    }
    const culprits = [...document.body.querySelectorAll('*')]
      .filter((element) => {
        const right = element.getBoundingClientRect().right
        const parent = element.parentElement

        return right > viewport + 0.5 && escapes(element) && (parent === null || parent === document.body || parent.getBoundingClientRect().right <= viewport + 0.5)
      })
      .toSorted((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)
      .slice(0, 3)

    for (const element of culprits) {
      const right = element.getBoundingClientRect().right

      findings.push({ kind: 'overflow', selector: describe(element), message: `right edge at ${px(right)}, ${px(right - viewport)} past the ${px(viewport)} viewport` })
    }

    if (culprits.length === 0)
      findings.push({ kind: 'overflow', selector: 'html', message: `the page scrolls ${px(by)} sideways` })
  }

  // Tap targets: a control smaller than a finger at phone widths, or than WCAG 2.5.8's 24px elsewhere; a link inside a sentence is exempt.
  const least = phone ? 44 : 24
  const controls = document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"]')

  for (const control of controls) {
    if (!visible(control) || (control as HTMLButtonElement).disabled)
      continue

    let rect = control.getBoundingClientRect()

    // Visually hidden helpers such as skip links are 1px squares until focused.
    if (rect.width <= 1 || rect.height <= 1)
      continue

    const style = getComputedStyle(control)
    const parent = control.parentElement

    if (style.display === 'inline' && parent !== null && (parent.textContent ?? '').trim().length > (control.textContent ?? '').trim().length)
      continue

    // A checkbox or radio is hit through its label too.
    const labels = (control as HTMLInputElement).labels

    if (labels !== null && labels !== undefined) {
      for (const label of labels) {
        const area = label.getBoundingClientRect()

        if (area.width * area.height > rect.width * rect.height)
          rect = area
      }
    }

    if (rect.width < least || rect.height < least)
      findings.push({ kind: 'tap-target', selector: describe(control), message: `${Math.round(rect.width)}×${Math.round(rect.height)}px, under ${least}px` })
  }

  // Padding: text flush against the border or background edge of the box drawing it.
  const touched = new Map<Element, Set<string>>()
  const range = document.createRange()

  for (const element of document.body.querySelectorAll('*')) {
    const texts = [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '')

    if (texts.length === 0 || !visible(element) || ['MARK', 'SCRIPT', 'STYLE', 'NOSCRIPT'].includes(element.tagName))
      continue

    let box: Element | null = element
    let edges: string[] = []

    for (; box !== null && box !== document.body; box = box.parentElement) {
      edges = edgesOf(box)

      if (edges.length > 0)
        break
    }

    if (box === null || box === document.body)
      continue

    let left = Infinity
    let right = -Infinity
    let top = Infinity
    let bottom = -Infinity

    for (const node of texts) {
      const content = node.textContent ?? ''

      range.setStart(node, content.search(NOT_SPACE))
      range.setEnd(node, content.trimEnd().length)

      for (const rect of range.getClientRects()) {
        left = Math.min(left, rect.left)
        right = Math.max(right, rect.right)
        top = Math.min(top, rect.top)
        bottom = Math.max(bottom, rect.bottom)
      }
    }

    if (left === Infinity)
      continue

    const outer = box.getBoundingClientRect()
    const style = getComputedStyle(box)
    const border = (side: string): number => Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) || 0
    const gaps: Record<string, number> = { top: top - outer.top - border('top'), right: outer.right - border('right') - right, bottom: outer.bottom - border('bottom') - bottom, left: left - outer.left - border('left') }

    for (const side of edges) {
      // An inline box is exactly as tall as its text, so only its sides can lack padding.
      if (style.display === 'inline' && (side === 'top' || side === 'bottom'))
        continue

      if (Math.abs(gaps[side] ?? Infinity) < 1) {
        const sides = touched.get(box) ?? new Set<string>()

        sides.add(side)
        touched.set(box, sides)
      }
    }
  }

  for (const [box, sides] of touched) {
    const order = ['top', 'right', 'bottom', 'left'].filter(side => sides.has(side))
    const named = order.length === 1 ? order[0] : `${order.slice(0, -1).join(', ')} and ${order.at(-1)}`

    findings.push({ kind: 'padding', selector: describe(box), message: `text touches its ${named} edge, no padding` })
  }

  // Images that finished loading with nothing to draw.
  for (const image of document.images) {
    const source = image.currentSrc || image.src

    if (source !== '' && image.complete && image.naturalWidth === 0)
      findings.push({ kind: 'image', selector: describe(image), message: `${source.length > 120 ? `${source.slice(0, 117)}...` : source} did not load` })
  }

  const shifts = globalThis.__pageShifts

  if (shifts !== undefined && shifts.score > 0.1) {
    const node = shifts.node
    const element = node instanceof Element ? node : node?.parentElement ?? null

    findings.push({ kind: 'layout-shift', selector: element === null ? 'html' : describe(element), message: `layout shift score ${shifts.score.toFixed(2)}, over 0.1` })
  }

  return findings
}

// Marks a few elements per family, weight and style holding text of their own, so CDP can find them by selector.
export function markFontSamples({ mark, perStyle, max }: { mark: string, perStyle: number, max: number }): FontSample[] {
  const counts = new Map<string, number>()
  const samples: FontSample[] = []

  for (const element of document.body.querySelectorAll('*')) {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(element.tagName))
      continue

    const hasText = [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '')
    const rect = element.getBoundingClientRect()

    if (!hasText || rect.width === 0 || rect.height === 0)
      continue

    const style = getComputedStyle(element)
    const key = `${style.fontFamily}|${style.fontWeight}|${style.fontStyle}`
    const count = (counts.get(key) ?? 0) + 1

    counts.set(key, count)

    if (count <= perStyle && samples.length < max) {
      element.setAttribute(mark, String(samples.length))
      samples.push({ index: samples.length, stack: style.fontFamily, selector: describe(element), style: key, count: 0 })
    }
  }

  return samples.map(sample => ({ ...sample, count: counts.get(sample.style) ?? 1 }))
}

// Whether the browser draws `family` with every glyph the same width.
export function monospaced(family: string): boolean {
  const context = document.createElement('canvas').getContext('2d')

  if (context === null)
    return false

  context.font = `32px "${family}"`

  return Math.abs(context.measureText('iiiiii').width - context.measureText('MMMMMM').width) < 0.5
}

export async function fontsReady(): Promise<void> {
  await document.fonts.ready
}

// Takes off the marks markFontSamples left once CDP has read them.
export function unmarkFontSamples(mark: string): void {
  for (const element of document.querySelectorAll(`[${mark}]`))
    element.removeAttribute(mark)
}
