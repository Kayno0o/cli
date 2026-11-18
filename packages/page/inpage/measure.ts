import type { DomFinding, FontSample, LayoutBox } from '../src/types'

// Runs in the page: src/inpage.ts sends this file's transpiled source with a call to one of its exports, so it may import types alone.

const NUMBERS = /[\d.]+/g
const NOT_SPACE = /\S/
const SPACES = /\s+/g
const WORDS = /\S{2,}/g
const WORD_CHAR = /[\p{L}\p{N}]/u
// Past this a word is shown cut, pieces and all.
const WORD_CAP = 60
const QUOTE_CAP = 30
const SMALLEST_TEXT = 12
// iOS zooms in on a field drawn under this size when it takes focus.
const SMALLEST_FIELD = 16
const FIELDS = 'textarea, select, input:not([type="hidden"], [type="checkbox"], [type="radio"], [type="range"], [type="color"], [type="file"], [type="submit"], [type="button"], [type="reset"], [type="image"])'
const SVG_SOURCE = /^data:image\/svg|\.svg(?:[?#]|$)/i
// Longer text no longer names one element, a section holding a whole paragraph say.
const LABEL_CAP = 80
const UNBOXED = new Set(['head', 'script', 'style', 'noscript', 'template'])

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

// Whether a box keeps what runs past its edge from being drawn, clipped or scrolled.
function contains(element: Element): boolean {
  const style = getComputedStyle(element)

  return style.overflowX !== 'visible' || style.overflowY !== 'visible'
}

// The non-blank text nodes an element holds itself, not those of its children.
function ownTexts(element: Element): Text[] {
  return [...element.childNodes].filter((node): node is Text => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '')
}

function quote(text: string): string {
  const flat = text.replace(SPACES, ' ').trim()

  return `"${flat.length > QUOTE_CAP ? `${flat.slice(0, QUOTE_CAP - 3)}...` : flat}"`
}

// Drawn and seen: inside a closed <details> or under an ancestor at opacity 0 is neither.
function visible(element: Element): boolean {
  const rect = element.getBoundingClientRect()

  return rect.width > 0 && rect.height > 0 && element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
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
  // Spill: text running past such an edge, with nothing between clipping or scrolling it.
  const touched = new Map<Element, Set<string>>()
  const spilled = new Map<Element, { side: string, by: number }>()
  const range = document.createRange()

  for (const element of document.body.querySelectorAll('*')) {
    const texts = ownTexts(element)

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

    let clipped = false

    for (let at: Element | null = element; at !== null && !clipped; at = at === box ? null : at.parentElement)
      clipped = contains(at)

    for (const side of edges) {
      // An inline box is exactly as tall as its text, so only its sides can lack padding.
      if (style.display === 'inline' && (side === 'top' || side === 'bottom'))
        continue

      const gap = gaps[side] ?? Infinity

      if (gap < -1 && !clipped && -gap > (spilled.get(box)?.by ?? 0))
        spilled.set(box, { side, by: -gap })

      if (Math.abs(gap) < 1) {
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

  for (const [box, { side, by }] of spilled)
    findings.push({ kind: 'spill', selector: describe(box), message: `text runs ${px(by)} past its ${side} edge` })

  // Wrap: a word broken between two letters or digits, in a column too narrow for it; a break at a hyphen or slash is the browser's own.
  for (const element of document.body.querySelectorAll('*')) {
    if (!visible(element) || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'PRE', 'TEXTAREA'].includes(element.tagName))
      continue

    for (const node of element.childNodes) {
      const content = node.nodeType === Node.TEXT_NODE ? node.textContent ?? '' : ''

      range.selectNodeContents(node)

      // Text on one line has nothing broken, and that is most of a page.
      if (content.trim() === '' || new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size < 2)
        continue

      const broken = [...content.matchAll(WORDS)].map(({ 0: word, index }) => {
        range.setStart(node, index)
        range.setEnd(node, index + word.length)

        // A word on one line is skipped before its letters are measured one by one.
        if (new Set([...range.getClientRects()].filter(({ width }) => width > 0).map(rect => Math.round(rect.top))).size < 2)
          return undefined

        const pieces: string[] = []
        let top: number | undefined
        let inside = false

        for (let at = 0; at < word.length; at++) {
          range.setStart(node, index + at)
          range.setEnd(node, index + at + 1)

          const rect = [...range.getClientRects()].find(({ width }) => width > 0)

          if (rect !== undefined && top !== undefined && Math.abs(rect.top - top) > 1) {
            inside ||= WORD_CHAR.test(word[at - 1] ?? '') && WORD_CHAR.test(word[at] ?? '')
            pieces.push('')
          }

          top = rect?.top ?? top
          pieces[Math.max(pieces.length - 1, 0)] = (pieces.at(-1) ?? '') + word[at]
        }

        return inside ? { word, pieces } : undefined
      }).find(found => found !== undefined)

      if (broken !== undefined) {
        const shown = broken.pieces.join('|')

        findings.push({ kind: 'wrap', selector: describe(element), message: `"${broken.word}" wraps inside the word: ${shown.length > WORD_CAP ? `${shown.slice(0, WORD_CAP - 3)}...` : shown}` })

        break
      }
    }
  }

  findings.push(...clippedText(range), ...overlappingText(range), ...smallText(phone), ...stretchedImages())

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

// The extent of an element's own text, undefined when nothing of it is laid out.
function textExtent(element: Element, range: Range): { left: number, right: number, top: number, bottom: number } | undefined {
  const extent = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity }

  for (const node of ownTexts(element)) {
    range.selectNodeContents(node)

    for (const rect of range.getClientRects()) {
      if (rect.width === 0)
        continue

      extent.left = Math.min(extent.left, rect.left)
      extent.right = Math.max(extent.right, rect.right)
      extent.top = Math.min(extent.top, rect.top)
      extent.bottom = Math.max(extent.bottom, rect.bottom)
    }
  }

  return extent.left === Infinity ? undefined : extent
}

// Clip: text cut by the box hiding what runs past it, an ellipsis included, with no title giving it whole; a 1px visually-hidden box is meant to hide.
function clippedText(range: Range): DomFinding[] {
  const cut = new Map<Element, string>()

  for (const element of document.body.querySelectorAll('*')) {
    if (!visible(element) || ownTexts(element).length === 0 || element.closest('[title]') !== null)
      continue

    let box: Element | null = element

    while (box !== null && box !== document.body && !['hidden', 'clip'].includes(getComputedStyle(box).overflowX) && !['hidden', 'clip'].includes(getComputedStyle(box).overflowY))
      box = box.parentElement

    if (box === null || box === document.body || cut.has(box))
      continue

    const outer = box.getBoundingClientRect()

    if (outer.width <= 1 || outer.height <= 1)
      continue

    const style = getComputedStyle(box)
    const ellipsis = getComputedStyle(element).textOverflow === 'ellipsis' && box.scrollWidth > box.clientWidth + 1
    const extent = textExtent(element, range)

    if (extent === undefined)
      continue

    // clientWidth and clientHeight are rounded, so the inside is measured from the box's own fractional size.
    const left = outer.left + box.clientLeft
    const top = outer.top + box.clientTop
    const width = box.clientWidth + outer.width - (box as HTMLElement).offsetWidth
    const height = box.clientHeight + outer.height - (box as HTMLElement).offsetHeight
    const wide = ellipsis || (style.overflowX !== 'visible' && (extent.right > left + width + 1 || extent.left < left - 1))
    const tall = style.overflowY !== 'visible' && (extent.bottom > top + height + 1 || extent.top < top - 1)
    // Text wholly outside the box is a slide or a panel put away, not text cut.
    const seen = extent.right > left && extent.left < left + width && extent.bottom > top && extent.top < top + height

    if (!seen)
      continue

    if (wide)
      cut.set(box, `text cut to ${Math.round(width)}px of ${Math.round(ellipsis ? box.scrollWidth : extent.right - extent.left)}px wide, no title`)
    else if (tall)
      cut.set(box, `text cut to ${Math.round(height)}px of ${Math.round(extent.bottom - extent.top)}px tall, no title`)
  }

  return [...cut].map(([box, message]) => ({ kind: 'clip', selector: describe(box), message }))
}

interface Run {
  element: Element
  node: Text
  rects: DOMRect[]
}

function runsOf(element: Element, range: Range): Run[] {
  return ownTexts(element).map((node) => {
    range.selectNodeContents(node)

    return { element, node, rects: [...range.getClientRects()].filter(({ width, height }) => width > 0 && height > 0) }
  })
}

// How much of the smaller rectangle the two share.
function shared(a: DOMRect, b: DOMRect): number {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)

  return width <= 0 || height <= 0 ? 0 : width * height / Math.min(a.width * a.height, b.width * b.height)
}

function intersection(runs: [Run, Run]): DOMRect | undefined {
  for (const a of runs[0].rects) {
    for (const b of runs[1].rects) {
      // Lines set tight share a sliver; text drawn over text shares a good part of a line.
      if (shared(a, b) >= 0.25)
        return new DOMRect(Math.max(a.left, b.left), Math.max(a.top, b.top), Math.min(a.right, b.right) - Math.max(a.left, b.left), Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
    }
  }

  return undefined
}

// Overlap: two runs of text drawn over each other with nothing opaque between them, a panel laid over text being fine.
function overlappingText(range: Range): DomFinding[] {
  const runs = [...document.body.querySelectorAll('*')].filter(element => visible(element) && !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA'].includes(element.tagName)).flatMap(element => runsOf(element, range)).filter(run => run.rects.length > 0)
  const candidates: [Run, Run][] = []
  const sorted = runs.flatMap(run => run.rects.map(rect => ({ run, rect }))).toSorted((a, b) => a.rect.top - b.rect.top)

  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!

    for (let j = i + 1; j < sorted.length && sorted[j]!.rect.top < a.rect.bottom; j++) {
      const b = sorted[j]!

      if (a.run.element !== b.run.element && !candidates.some(([x, y]) => (x === a.run && y === b.run) || (x === b.run && y === a.run)) && shared(a.rect, b.rect) >= 0.25)
        candidates.push([a.run, b.run])
    }
  }

  const findings: DomFinding[] = []
  const reported = new Set<Element>()
  const { scrollX, scrollY } = window

  for (const pair of candidates) {
    const first = intersection(pair)

    if (first === undefined)
      continue

    // The stack under a point is only known in the viewport, so the overlap is brought into it and measured again.
    window.scrollTo(0, Math.max(0, window.scrollY + first.top - window.innerHeight / 2))

    const fresh = pair.map(run => ({ ...run, rects: runsOf(run.element, range).find(other => other.node === run.node)?.rects ?? [] })) as [Run, Run]
    const at = intersection(fresh)

    if (at === undefined)
      continue

    const stack = document.elementsFromPoint(at.left + at.width / 2, at.top + at.height / 2)
    const [upper, lower] = pair.map(run => stack.indexOf(run.element)).toSorted((a, b) => a - b)

    // An element left out of the stack (pointer-events: none) cannot be ordered.
    if (upper === undefined || lower === undefined || upper < 0)
      continue

    const covered = stack.slice(upper + 1, lower).some((element) => {
      const style = getComputedStyle(element)

      return style.backgroundImage !== 'none' || alpha(style.backgroundColor) >= 1
    })
    const top = stack[upper]!
    const below = pair.find(run => run.element !== top)!

    if (covered || reported.has(top))
      continue

    reported.add(top)
    findings.push({ kind: 'overlap', selector: describe(top), message: `${quote(pair.find(run => run.element === top)!.node.textContent ?? '')} drawn over ${quote(below.node.textContent ?? '')} (${describe(below.element)})` })
  }

  window.scrollTo(scrollX, scrollY)

  return findings
}

// Text-size: text under 12px anywhere, and at a phone width a form field under 16px.
function smallText(phone: boolean): DomFinding[] {
  const lines = new Map<string, DomFinding>()
  const add = (finding: DomFinding): void => {
    lines.set(`${finding.selector}|${finding.message}`, finding)
  }

  for (const element of document.body.querySelectorAll('*')) {
    if (!visible(element) || ownTexts(element).length === 0 || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(element.tagName))
      continue

    const size = Number.parseFloat(getComputedStyle(element).fontSize)

    if (size > 0 && size < SMALLEST_TEXT)
      add({ kind: 'text-size', selector: describe(element), message: `${Math.round(size * 10) / 10}px text, under ${SMALLEST_TEXT}px` })
  }

  if (phone) {
    for (const field of document.querySelectorAll(FIELDS)) {
      const size = Number.parseFloat(getComputedStyle(field).fontSize)

      if (visible(field) && size < SMALLEST_FIELD)
        add({ kind: 'text-size', selector: describe(field), message: `${Math.round(size * 10) / 10}px text in a field, under ${SMALLEST_FIELD}px: iOS zooms in on focus` })
    }
  }

  return [...lines.values()]
}

// Stretch: a raster image drawn at another aspect ratio than its file, object-fit left at fill; an svg letterboxes through its viewBox instead.
function stretchedImages(): DomFinding[] {
  const findings: DomFinding[] = []

  for (const image of document.images) {
    const source = image.currentSrc || image.src
    const style = getComputedStyle(image)

    if (!image.complete || image.naturalWidth === 0 || image.naturalHeight === 0 || SVG_SOURCE.test(source) || style.objectFit !== 'fill' || !visible(image))
      continue

    const rect = image.getBoundingClientRect()
    const inset = (a: string, b: string): number => ['padding', 'border'].reduce((sum, kind) => sum + (Number.parseFloat(style.getPropertyValue(`${kind}-${a}${kind === 'border' ? '-width' : ''}`)) || 0) + (Number.parseFloat(style.getPropertyValue(`${kind}-${b}${kind === 'border' ? '-width' : ''}`)) || 0), 0)
    const width = rect.width - inset('left', 'right')
    const height = rect.height - inset('top', 'bottom')

    if (width <= 1 || height <= 1)
      continue

    const drawn = width / height
    const file = image.naturalWidth / image.naturalHeight

    // A pixel of rounding moves the ratio of a small image, so a few percent are let through.
    if (Math.abs(drawn - file) / file > 0.03)
      findings.push({ kind: 'stretch', selector: describe(image), message: `drawn ${Math.round(width)}×${Math.round(height)}px, the file is ${image.naturalWidth}×${image.naturalHeight}: stretched` })
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

// The accessible name or the text an element shows, when short enough to tell it from the others.
function labelOf(element: Element): string {
  const named = element.getAttribute('aria-label') ?? element.getAttribute('alt') ?? element.getAttribute('title') ?? element.getAttribute('placeholder')
  const text = (named ?? element.textContent ?? '').replace(SPACES, ' ').trim()

  return text.length <= LABEL_CAP ? text : ''
}

/** Every element drawn with a box, parents before children, its parent being the nearest one drawn; an svg is one box. */
export function layoutBoxes(): LayoutBox[] {
  const boxes: LayoutBox[] = []
  const round = (value: number): number => Math.round(value * 100) / 100

  const walk = (element: Element, parent: number): void => {
    const tag = element.localName

    if (UNBOXED.has(tag))
      return

    let own = parent

    if (visible(element)) {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      const sides = ['top', 'right', 'bottom', 'left']

      own = boxes.length
      boxes.push({
        parent,
        id: element.id,
        selector: describe(element),
        tag,
        label: labelOf(element),
        x: round(rect.left + scrollX),
        y: round(rect.top + scrollY),
        width: round(rect.width),
        height: round(rect.height),
        padding: sides.map(side => round(Number.parseFloat(style.getPropertyValue(`padding-${side}`)))),
        border: sides.map(side => round(Number.parseFloat(style.getPropertyValue(`border-${side}-width`)))),
      })
    }

    if (tag !== 'svg') {
      for (const child of element.children)
        walk(child, own)
    }
  }

  walk(document.documentElement, -1)

  return boxes
}
