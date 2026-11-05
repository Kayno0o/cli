// Candidate looks for kit's tree(), variants of the indented design three to a row: `bun scripts/tree-designs.ts [--plain|--color]`.
interface Node { label: string, note?: string, children?: Node[] }

const sample: Node[] = [{
  label: 'packages',
  children: [
    { label: 'kit', note: '34', children: [{ label: 'picker', children: [{ label: 'view.ts' }, { label: 'terminal.ts' }] }, { label: 'ci.ts' }] },
    { label: 'ft', note: '21', children: [{ label: 'commands', children: [{ label: 'watch.ts' }] }, { label: 'runs.ts' }] },
    { label: 'pick', children: [{ label: 'pick.ts' }] },
  ],
}, {
  label: 'scripts',
  children: [{ label: 'style-gallery.ts' }, { label: 'tree-designs.ts' }],
}]

const PER_ROW = 3
const FROM = [192, 132, 252]
const TO = [103, 232, 249]

const wanted = process.argv[2]
const modes = { '--plain': [false], '--color': [true] }[wanted ?? ''] ?? [false, true]

interface Look {
  name: string
  about: string
  folder: string
  guide: string
}

// Folders end in a slash and are bold in the accent; files are plain behind a dim dot; the guide stands where the two spaces of a level were.
const looks: Look[] = [
  { name: '1. ▸ solid', about: 'the arrow of 5, solid guides', folder: '▸', guide: '│ ' },
  { name: '2. ❯ solid', about: 'chevron, solid guides', folder: '❯', guide: '│ ' },
  { name: '3. ▶ solid', about: 'big triangle, solid guides', folder: '▶', guide: '│ ' },
  { name: '4. › broken', about: 'light chevron, broken guides', folder: '›', guide: '┆ ' },
  { name: '5. ➜ dotted', about: 'arrow, dotted guides', folder: '➜', guide: '┊ ' },
  { name: '6. » dashed', about: 'double chevron, dashed guides', folder: '»', guide: '╎ ' },
  { name: '7. ▸ dashed', about: 'the arrow of 5, dashed guides', folder: '▸', guide: '╎ ' },
  { name: '8. ❯ dotted', about: 'chevron, dotted guides', folder: '❯', guide: '┊ ' },
  { name: '9. ▶ broken', about: 'big triangle, broken guides', folder: '▶', guide: '┆ ' },
]

const depthOf = (nodes: Node[]): number => Math.max(0, ...nodes.map(node => 1 + depthOf(node.children ?? [])))
const deepest = depthOf(sample) - 1

function shade(depth: number): string {
  const t = deepest <= 0 ? 0 : depth / deepest

  return FROM.map((start, index) => Math.round(start + (TO[index]! - start) * t)).join(';')
}

const wrap = (code: string, text: string, color: boolean) => color ? `\x1B[${code}m${text}\x1B[0m` : text

function draw(look: Look, color: boolean): string[] {
  const lines: string[] = []

  function walk(nodes: Node[], depth: number) {
    const rgb = `38;2;${shade(depth)}`

    for (const node of nodes) {
      const folder = (node.children ?? []).length > 0
      const mark = wrap(folder ? rgb : '2', folder ? look.folder : '·', color)
      const note = node.note === undefined ? '' : ` ${wrap('2', node.note, color)}`
      const label = folder ? wrap('1;36', `${node.label}/`, color) : node.label

      lines.push(`${wrap('2', look.guide.repeat(depth), color)}${mark} ${label}${note}`)
      walk(node.children ?? [], depth + 1)
    }
  }

  walk(sample, 0)

  return lines
}

const GAP = 4

for (const color of modes) {
  console.log(`\n=== ${color ? 'with colours' : 'plain'} ===`)

  for (let start = 0; start < looks.length; start += PER_ROW) {
    const group = looks.slice(start, start + PER_ROW)
    const drawn = group.map(look => draw(look, color))
    const width = Math.max(...drawn.flat().map(line => Bun.stringWidth(line)), ...group.map(look => look.about.length))
    const rows = Math.max(...drawn.map(lines => lines.length))
    const cell = (text: string) => text + ' '.repeat(width - Bun.stringWidth(text) + GAP)

    console.log()
    console.log(group.map(look => cell(wrap('1', look.name, color))).join('').trimEnd())
    console.log(group.map(look => cell(wrap('2', look.about, color))).join('').trimEnd())

    for (let row = 0; row < rows; row++)
      console.log(drawn.map(lines => cell(lines[row] ?? '')).join('').trimEnd())
  }
}
