// What crosses between the CLI and the code it runs in the page (inpage/).

export type DomKind = 'overflow' | 'tap-target' | 'padding' | 'image' | 'layout-shift'

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
