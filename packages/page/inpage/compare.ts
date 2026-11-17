import type { Compared, CompareInput, Region } from '../src/types'

// Runs in a blank page: src/inpage.ts sends this file's transpiled source with a call to compareImages, so it may import types alone.

/** Compares two PNGs pixel by pixel and boxes the differing regions, cells of 8px joined across a 16px gap so a changed line of text makes one box. */
export async function compareImages({ mockup, built, threshold }: CompareInput): Promise<Compared> {
  const cell = 8
  const reach = 2
  const gap = 24
  const box = '#d0006f'

  async function bitmap(base64: string): Promise<ImageBitmap> {
    const response = await fetch(`data:image/png;base64,${base64}`)

    return createImageBitmap(await response.blob())
  }

  function canvasOf(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
    const canvas = document.createElement('canvas')

    canvas.width = width
    canvas.height = height

    return [canvas, canvas.getContext('2d')!]
  }

  const [left, right] = await Promise.all([bitmap(mockup), bitmap(built)])
  const width = Math.max(left.width, right.width)
  const height = Math.max(left.height, right.height)

  function pixels(image: ImageBitmap): Uint8ClampedArray {
    const [, context] = canvasOf(width, height)

    context.fillStyle = '#fff'
    context.fillRect(0, 0, width, height)
    context.drawImage(image, 0, 0)

    return context.getImageData(0, 0, width, height).data
  }

  const a = pixels(left)
  const b = pixels(right)
  const columns = Math.ceil(width / cell)
  const rows = Math.ceil(height / cell)
  const counts = new Uint32Array(columns * rows)
  const mask = new Uint8Array(width * height)
  let differing = 0

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4
      const distance = Math.max(Math.abs(a[at]! - b[at]!), Math.abs(a[at + 1]! - b[at + 1]!), Math.abs(a[at + 2]! - b[at + 2]!))

      if (distance > threshold) {
        mask[y * width + x] = 1
        differing++
        counts[Math.floor(y / cell) * columns + Math.floor(x / cell)]! += 1
      }
    }
  }

  // A cell with a lone differing pixel is antialiasing noise, not a change.
  const dirty = (index: number): boolean => counts[index]! >= 2
  const seen = new Uint8Array(columns * rows)
  const regions: Region[] = []

  for (let start = 0; start < counts.length; start++) {
    if (seen[start] === 1 || !dirty(start))
      continue

    let minX = columns
    let minY = rows
    let maxX = 0
    let maxY = 0
    const queue = [start]

    seen[start] = 1

    for (const index of queue) {
      const cx = index % columns
      const cy = Math.floor(index / columns)

      minX = Math.min(minX, cx)
      maxX = Math.max(maxX, cx)
      minY = Math.min(minY, cy)
      maxY = Math.max(maxY, cy)

      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const nx = cx + dx
          const ny = cy + dy
          const next = ny * columns + nx

          if (nx >= 0 && ny >= 0 && nx < columns && ny < rows && seen[next] === 0 && dirty(next)) {
            seen[next] = 1
            queue.push(next)
          }
        }
      }
    }

    const x = minX * cell
    const y = minY * cell

    regions.push({ x, y, width: Math.min((maxX + 1) * cell, width) - x, height: Math.min((maxY + 1) * cell, height) - y })
  }

  regions.sort((one, two) => one.y - two.y || one.x - two.x)

  function outline(context: CanvasRenderingContext2D, offset: number): void {
    context.lineWidth = 2
    context.font = 'bold 12px sans-serif'

    for (const [index, region] of regions.entries()) {
      const label = String(index + 1)
      const labelWidth = context.measureText(label).width + 8

      context.strokeStyle = box
      context.strokeRect(offset + region.x + 1, region.y + 1, Math.max(region.width - 2, 1), Math.max(region.height - 2, 1))
      context.fillStyle = box
      context.fillRect(offset + region.x, Math.max(region.y - 16, 0), labelWidth, 16)
      context.fillStyle = '#fff'
      context.fillText(label, offset + region.x + 4, Math.max(region.y - 16, 0) + 12)
    }
  }

  const [overlay, overlayContext] = canvasOf(width, height)
  const faded = overlayContext.createImageData(width, height)

  for (let index = 0; index < width * height; index++) {
    const at = index * 4

    if (mask[index] === 1) {
      faded.data.set([230, 0, 60, 255], at)
    }
    else {
      faded.data.set([b[at]! / 4 + 191, b[at + 1]! / 4 + 191, b[at + 2]! / 4 + 191, 255], at)
    }
  }

  overlayContext.putImageData(faded, 0, 0)
  outline(overlayContext, 0)

  const [side, sideContext] = canvasOf(width * 2 + gap, height)

  sideContext.fillStyle = '#888'
  sideContext.fillRect(0, 0, width * 2 + gap, height)
  sideContext.fillStyle = '#fff'
  sideContext.fillRect(0, 0, width, height)
  sideContext.fillRect(width + gap, 0, width, height)
  sideContext.drawImage(left, 0, 0)
  sideContext.drawImage(right, width + gap, 0)
  outline(sideContext, 0)
  outline(sideContext, width + gap)

  const base64 = (canvas: HTMLCanvasElement): string => canvas.toDataURL('image/png').slice('data:image/png;base64,'.length)

  return { width, mockupHeight: left.height, builtHeight: right.height, differing: differing / (width * height), regions, side: base64(side), overlay: base64(overlay) }
}
