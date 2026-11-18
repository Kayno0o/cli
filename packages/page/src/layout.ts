import type { LayoutBox } from './types'

// Subpixel layout drifts below this between two loads of the same page.
const NEAR = 1

export type ShiftKind = 'moved' | 'resized' | 'padding' | 'added' | 'removed'

export interface Shift {
  kind: ShiftKind
  selector: string
  message: string
  // Elements it moved, its own subtree's and the ones after it.
  pushed: number
}

type Place = 'same' | 'parent' | 'previous' | 'wrapped' | 'moved'

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < NEAR
}

// Each box's previous sibling among the boxes, -1 for a first child.
function previousOf(boxes: LayoutBox[]): number[] {
  const last = new Map<number, number>()

  return boxes.map((box, index) => {
    const previous = last.get(box.parent) ?? -1

    last.set(box.parent, index)

    return previous
  })
}

// Keys held by one unpaired box only, with that box.
function uniqueKeys(boxes: LayoutBox[], paired: number[], keyOf: (box: LayoutBox) => string): Map<string, number> {
  const found = new Map<string, number>()
  const shared = new Set<string>()

  for (const [index, box] of boxes.entries()) {
    const key = keyOf(box)

    if (key === '' || paired[index] !== -1)
      continue

    if (found.has(key))
      shared.add(key)

    found.set(key, index)
  }

  for (const key of shared)
    found.delete(key)

  return found
}

// A parent's unpaired children grouped by tag, in order.
function freeChildren(boxes: LayoutBox[], paired: number[], parent: number): Map<string, number[]> {
  const groups = new Map<string, number[]>()

  for (const [index, box] of boxes.entries()) {
    if (box.parent === parent && paired[index] === -1)
      groups.set(box.tag, [...groups.get(box.tag) ?? [], index])
  }

  return groups
}

/** Pairs each box of `a` with one of `b`, -1 when none: by id, then by tag with its text or accessible name, then by that text alone, wherever they sit, when unique on both sides; then the rest by tag in order under parents already paired. */
export function pairBoxes(a: LayoutBox[], b: LayoutBox[]): number[] {
  const aToB = a.map(() => -1)
  const bToA = b.map(() => -1)
  const link = (i: number, j: number): void => {
    aToB[i] = j
    bToA[j] = i
  }

  if (a.length === 0 || b.length === 0)
    return aToB

  link(0, 0)

  // The text alone last, for one element marked up with another tag.
  for (const keyOf of [(box: LayoutBox) => box.id, (box: LayoutBox) => box.label === '' ? '' : `${box.tag}|${box.label}`, (box: LayoutBox) => box.label]) {
    const fromB = uniqueKeys(b, bToA, keyOf)

    for (const [key, i] of uniqueKeys(a, aToB, keyOf)) {
      const j = fromB.get(key)

      if (j !== undefined)
        link(i, j)
    }
  }

  // Document order puts a parent before its children, so it is paired by the time they are reached.
  for (const i of a.keys()) {
    const j = aToB[i]!

    if (j === -1)
      continue

    const others = freeChildren(b, bToA, j)

    for (const [tag, children] of freeChildren(a, aToB, i)) {
      for (const [k, child] of children.entries()) {
        const other = others.get(tag)?.[k]

        if (other !== undefined)
          link(child, other)
      }
    }
  }

  return aToB
}

function direction(dx: number, dy: number): string {
  const parts = [dy >= NEAR ? `down ${Math.round(dy)}px` : '', dy <= -NEAR ? `up ${Math.round(-dy)}px` : '', dx >= NEAR ? `right ${Math.round(dx)}px` : '', dx <= -NEAR ? `left ${Math.round(-dx)}px` : '']

  return parts.filter(Boolean).join(', ')
}

function size(box: LayoutBox): string {
  return `${Math.round(box.width)}×${Math.round(box.height)}`
}

// Where its children are laid out from: the border box inside its border and padding.
function content(box: LayoutBox): { x: number, y: number, width: number } {
  const inset = (side: number): number => (box.border[side] ?? 0) + (box.padding[side] ?? 0)

  return { x: box.x + inset(3), y: box.y + inset(0), width: box.width - inset(1) - inset(3) }
}

function sides(values: number[]): string {
  const rounded = values.map(value => Math.round(value))

  return rounded.every(value => value === rounded[0]) ? String(rounded[0]) : rounded.join(' ')
}

// "padding 16 to 24px, border 1 to 2px", '' when neither changed.
function insetChange(a: LayoutBox, b: LayoutBox): string {
  const changes: string[] = []

  for (const name of ['padding', 'border'] as const) {
    if (a[name].some((value, side) => !near(value, b[name][side] ?? 0)))
      changes.push(`${name} ${sides(a[name])} to ${sides(b[name])}px`)
  }

  return changes.join(', ')
}

/**
 * What moved or resized between two layouts of a page, by cause: an element keeping its offset from its parent, or its gap to its previous sibling, was pushed and is counted in the cause it follows.
 * A box resized because something inside it changed, or whose width follows its parent's, is not a cause either; added and removed boxes are, the outermost one of each.
 */
export function layoutShifts(a: LayoutBox[], b: LayoutBox[]): Shift[] {
  const aToB = pairBoxes(a, b)
  const bToA = b.map(() => -1)

  for (const [i, j] of aToB.entries()) {
    if (j !== -1)
      bToA[j] = i
  }

  const previousA = previousOf(a)
  const previousB = previousOf(b)
  const isRoot = (parent: number, paired: number[]): boolean => parent === -1 || paired[parent] !== -1

  const placeOf = (i: number, j: number): Place => {
    const [boxA, boxB] = [a[i]!, b[j]!]

    if (near(boxA.x, boxB.x) && near(boxA.y, boxB.y))
      return 'same'

    const [parentA, parentB] = [a[boxA.parent], b[boxB.parent]]

    if (parentA === undefined || parentB === undefined)
      return 'moved'

    // A wrapper added around it or taken away moves it with it.
    if (bToA[boxB.parent] === -1 || aToB[boxA.parent] === -1)
      return 'wrapped'

    const [insideA, insideB] = [content(parentA), content(parentB)]
    const keepsX = near(boxA.x - insideA.x, boxB.x - insideB.x)
    const keepsY = near(boxA.y - insideA.y, boxB.y - insideB.y)

    if (keepsX && keepsY)
      return 'parent'

    const [p, q] = [previousA[i]!, previousB[j]!]

    // A sibling removed or added right before it moves it by its own size.
    if ((p !== -1 && aToB[p] === -1) || (q !== -1 && bToA[q] === -1))
      return 'previous'

    const [beforeA, beforeB] = [a[p], b[q]]

    if (beforeA === undefined || beforeB === undefined)
      return 'moved'

    const keepsGapBelow = keepsX && near(boxA.y - beforeA.y - beforeA.height, boxB.y - beforeB.y - beforeB.height)
    const keepsGapBeside = keepsY && near(boxA.x - beforeA.x - beforeA.width, boxB.x - beforeB.x - beforeB.width)

    return keepsGapBelow || keepsGapBeside ? 'previous' : 'moved'
  }

  const places = aToB.map((j, i): Place => j === -1 ? 'same' : placeOf(i, j))
  const shifts = new Map<string, Shift & { y: number }>()

  // Below a box, the first cause in document order; added boxes are causes of b, everything else of a.
  const causeBelowB = b.map(() => '')

  for (let j = b.length - 1; j >= 0; j--) {
    const box = b[j]!
    let own = ''

    if (bToA[j] === -1 && isRoot(box.parent, bToA)) {
      own = `b${j}`
      shifts.set(own, { kind: 'added', selector: box.selector, message: `${size(box)}px at ${Math.round(box.x)},${Math.round(box.y)}`, pushed: 0, y: box.y })
    }

    const up = own || causeBelowB[j]!

    if (up !== '' && box.parent !== -1)
      causeBelowB[box.parent] = up
  }

  const causeBelowA = a.map(() => '')
  // A box resized by what changed inside it stands for that cause when it pushes its siblings.
  const grownBy = a.map(() => '')

  for (let i = a.length - 1; i >= 0; i--) {
    const box = a[i]!
    const j = aToB[i]!
    let own = ''
    let below = causeBelowA[i]!

    if (j === -1) {
      if (isRoot(box.parent, aToB)) {
        own = `a${i}`
        shifts.set(own, { kind: 'removed', selector: box.selector, message: `${size(box)}px at ${Math.round(box.x)},${Math.round(box.y)}`, pushed: 0, y: box.y })
      }
    }
    else {
      const other = b[j]!
      const parentA = a[box.parent]
      const parentB = b[other.parent]

      below ||= causeBelowB[j]!

      const resized = !near(box.width, other.width) || !near(box.height, other.height)
      const followsParent = !near(box.width, other.width) && parentA !== undefined && parentB !== undefined && near(other.width - box.width, content(parentB).width - content(parentA).width)
      const moved = direction(other.x - box.x, other.y - box.y)
      const inset = insetChange(box, other)
      // A centred or bottom-anchored box grown by what is inside it moves by up to its growth.
      const movedByGrowth = resized && below !== '' && Math.abs(other.x - box.x) <= Math.abs(other.width - box.width) + NEAR && Math.abs(other.y - box.y) <= Math.abs(other.height - box.height) + NEAR

      if ((resized && below === '' && !followsParent) || inset !== '') {
        own = `a${i}`
        shifts.set(own, { kind: resized ? 'resized' : 'padding', selector: other.selector, message: [resized ? `${size(box)} to ${size(other)}px` : '', inset, places[i] === 'moved' ? moved : ''].filter(Boolean).join(', '), pushed: 0, y: box.y })
      }
      else if (places[i] === 'moved' && !movedByGrowth) {
        own = `a${i}`
        shifts.set(own, { kind: 'moved', selector: other.selector, message: moved, pushed: 0, y: box.y })
      }
      else if (resized) {
        grownBy[i] = below
      }
    }

    if ((own || below) && box.parent !== -1)
      causeBelowA[box.parent] = own || below
  }

  // Each pushed box follows its parent's cause or its previous sibling's, both earlier in document order.
  const causeOf = a.map(() => '')
  const outermost = (boxes: LayoutBox[], paired: number[], index: number, side: 'a' | 'b'): string => {
    let k = index

    while (!isRoot(boxes[k]!.parent, paired))
      k = boxes[k]!.parent

    return `${side}${k}`
  }

  for (const [i, j] of aToB.entries()) {
    if (j === -1)
      continue

    if (shifts.has(`a${i}`)) {
      causeOf[i] = `a${i}`

      continue
    }

    const p = previousA[i]!
    const q = previousB[j]!
    const place = places[i]

    if (place === 'parent')
      causeOf[i] = causeOf[a[i]!.parent]!
    else if (place === 'moved')
      causeOf[i] = grownBy[i]!
    else if (place === 'wrapped')
      causeOf[i] = bToA[b[j]!.parent] === -1 ? outermost(b, bToA, b[j]!.parent, 'b') : outermost(a, aToB, a[i]!.parent, 'a')
    else if (place === 'previous' && q !== -1 && bToA[q] === -1)
      causeOf[i] = outermost(b, bToA, q, 'b')
    else if (place === 'previous' && p !== -1 && aToB[p] === -1)
      causeOf[i] = `a${p}`
    else if (place === 'previous')
      causeOf[i] = grownBy[p]! || causeOf[p]!

    const shift = shifts.get(causeOf[i]!)

    if (place !== 'same' && shift !== undefined)
      shift.pushed++
  }

  // Top to bottom, a removal before what replaced it.
  return [...shifts.values()].sort((x, y) => x.y - y.y || Number(y.kind === 'removed') - Number(x.kind === 'removed')).map(({ y: _, ...shift }) => shift)
}
