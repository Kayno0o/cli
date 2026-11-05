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

type Tint = 'dim' | 'shade' | 'faded' | 'accent' | 'blue' | 'violet' | 'none'

interface Look {
  name: string
  about: string
  // How the guide of each level is coloured; plain output is the same for all.
  guide: Tint
  // The file dots and names.
  file: Tint
}

// Small dots, folders bold cyan ending in a slash; only the colour of the guides and the file dots varies.
const looks: Look[] = [
  { name: '1. dim', about: 'grey guides (now)', guide: 'dim', file: 'dim' },
  { name: '2. shaded', about: 'each level its depth shade', guide: 'shade', file: 'dim' },
  { name: '3. faded', about: 'depth shade at half strength', guide: 'faded', file: 'dim' },
  { name: '4. accent', about: 'guides in the theme accent', guide: 'accent', file: 'dim' },
  { name: '5. faded + shaded files', about: 'half strength guides, file dots shaded', guide: 'faded', file: 'shade' },
  { name: '6. blue', about: 'one soft blue for guides', guide: 'blue', file: 'dim' },
  { name: '7. violet', about: 'one soft violet for guides', guide: 'violet', file: 'dim' },
  { name: '8. shaded + faded files', about: 'full shade guides, faded file dots', guide: 'shade', file: 'faded' },
  { name: '9. faded, plain files', about: 'half strength guides, no file dot colour', guide: 'faded', file: 'none' },
]

const depthOf = (nodes: Node[]): number => Math.max(0, ...nodes.map(node => 1 + depthOf(node.children ?? [])))
const deepest = depthOf(sample) - 1

function shade(depth: number, strength = 1): string {
  const t = deepest <= 0 ? 0 : depth / deepest

  return FROM.map((start, index) => Math.round((start + (TO[index]! - start) * t) * strength)).join(';')
}

// The SGR code a tint gives the guide or the file dot of a level.
function code(tint: Tint, level: number): string {
  return {
    dim: '2',
    shade: `38;2;${shade(level)}`,
    faded: `38;2;${shade(level, 0.55)}`,
    accent: '36',
    blue: '38;2;96;130;170',
    violet: '38;2;130;100;170',
    none: '0',
  }[tint]
}

const wrap = (code: string, text: string, color: boolean) => color ? `\x1B[${code}m${text}\x1B[0m` : text

function draw(look: Look, color: boolean): string[] {
  const lines: string[] = []

  function walk(nodes: Node[], depth: number) {
    const rgb = `38;2;${shade(depth)}`

    for (const node of nodes) {
      const folder = (node.children ?? []).length > 0
      const mark = wrap(folder ? rgb : code(look.file, depth), folder ? '•' : '·', color)
      const note = node.note === undefined ? '' : ` ${wrap('2', node.note, color)}`
      const label = folder ? wrap('1;36', `${node.label}/`, color) : node.label

      const guides = Array.from({ length: depth }, (_, level) => wrap(code(look.guide, level), '│ ', color)).join('')

      lines.push(`${guides}${mark} ${label}${note}`)
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
