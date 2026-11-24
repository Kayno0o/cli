// What crosses between the CLI and the code it runs in the page (inpage/).

export type DomKind = 'overflow' | 'tap-target' | 'padding' | 'wrap' | 'clip' | 'spill' | 'overlap' | 'text-size' | 'stretch' | 'double-border' | 'image' | 'layout-shift' | 'a11y' | 'head'

export interface DomFinding {
  kind: DomKind
  selector: string
  message: string
}

export interface FontSample {
  index: number
  stack: string
  selector: string
  // The family, weight and style it stands for.
  style: string
  // Elements sharing that style.
  count: number
}

export interface LayoutBox {
  // Index of the nearest ancestor drawn, -1 for the root.
  parent: number
  id: string
  selector: string
  tag: string
  // Its accessible name or short text, '' when it has neither.
  label: string
  // Its border box in page coordinates.
  x: number
  y: number
  width: number
  height: number
  // Top, right, bottom and left, in px.
  padding: number[]
  border: number[]
}

export interface Region {
  x: number
  y: number
  width: number
  height: number
}

export interface Compared {
  width: number
  mockupHeight: number
  builtHeight: number
  // Share of the compared pixels that differ, 0 to 1.
  differing: number
  regions: Region[]
  // PNGs as base64 from the page, their paths once written: the mockup and the built page side by side, and the built page faded with the differing pixels in red.
  side: string
  overlay: string
}

export interface CompareInput {
  mockup: string
  built: string
  // Largest per-channel difference two pixels may show and still count as the same.
  threshold: number
}
