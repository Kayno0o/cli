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
  file: string
  // What the label of a folder and of a file is drawn with, given the depth's shade.
  folderLabel: 'bold-accent' | 'bold' | 'shade' | 'bold-shade'
  fileLabel: 'plain' | 'dim' | 'blue'
  slash?: boolean
  shadeFile?: boolean
}

const looks: Look[] = [
  { name: '1. accent folders', about: 'bold cyan folders, plain files', folder: '▾', file: '·', folderLabel: 'bold-accent', fileLabel: 'plain' },
  { name: '2. shaded folders', about: 'folders take their depth shade', folder: '▾', file: '·', folderLabel: 'bold-shade', fileLabel: 'plain' },
  { name: '3. dim files', about: 'bold folders, dimmed files', folder: '▾', file: '·', folderLabel: 'bold', fileLabel: 'dim' },
  { name: '4. blue files', about: 'shaded folders, blue files', folder: '▾', file: '·', folderLabel: 'shade', fileLabel: 'blue' },
  { name: '5. slash', about: 'folders end in /, arrows ▸', folder: '▸', file: '·', folderLabel: 'bold-accent', fileLabel: 'plain', slash: true },
  { name: '6. dots', about: 'filled and hollow dots', folder: '●', file: '○', folderLabel: 'bold-shade', fileLabel: 'dim' },
  { name: '7. triangles', about: 'open and closed triangles', folder: '▼', file: '▷', folderLabel: 'bold', fileLabel: 'plain' },
  { name: '8. chevrons', about: 'chevrons for both, files dimmed', folder: '❯', file: '›', folderLabel: 'bold-accent', fileLabel: 'dim', shadeFile: true },
  { name: '9. squares', about: 'squares, files shaded too', folder: '■', file: '□', folderLabel: 'bold-shade', fileLabel: 'plain', shadeFile: true },
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
      const mark = wrap(folder || look.shadeFile === true ? rgb : '2', folder ? look.folder : look.file, color)
      const name = folder && look.slash === true ? `${node.label}/` : node.label
      const note = node.note === undefined ? '' : ` ${wrap('2', node.note, color)}`
      let label = name

      label = folder ? wrap({ 'bold-accent': '1;36', 'bold': '1', 'shade': rgb, 'bold-shade': `1;${rgb}` }[look.folderLabel], name, color) : wrap({ plain: '0', dim: '2', blue: '34' }[look.fileLabel], name, color)

      lines.push(`${'  '.repeat(depth)}${mark} ${label}${note}`)
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
