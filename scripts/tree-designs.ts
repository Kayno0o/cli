// Candidate looks for kit's tree(), each drawn plain and with colours: `bun scripts/tree-designs.ts [--plain|--color]`.
interface Node { label: string, note?: string, children?: Node[] }

const sample: Node[] = [{
  label: 'packages',
  children: [
    { label: 'kit', note: '34 files', children: [{ label: 'picker', children: [{ label: 'view.ts' }, { label: 'terminal.ts' }] }, { label: 'ci.ts' }, { label: 'chart.ts' }] },
    { label: 'ft', note: '21 files', children: [{ label: 'commands', children: [{ label: 'watch.ts' }, { label: 'ci.ts' }] }, { label: 'runs.ts' }] },
    { label: 'pick', children: [{ label: 'pick.ts' }] },
  ],
}, {
  label: 'scripts',
  children: [{ label: 'style-gallery.ts' }, { label: 'tree-designs.ts' }],
}]

const wanted = process.argv[2]
const modes = { '--plain': [false], '--color': [true] }[wanted ?? ''] ?? [false, true]

interface Design {
  name: string
  about: string
  root: (n: Node, c: Palette) => string
  line: (n: Node, last: boolean, depth: number, c: Palette) => string
  pad: (last: boolean, c: Palette) => string
  // Prefix of a root's children, for a design with no guides to hang them on.
  indent?: string
}

interface Palette { dim: (s: string) => string, bold: (s: string) => string, accent: (s: string) => string, soft: (s: string) => string, level: (depth: number, s: string) => string }

const on = (code: string) => (s: string) => `\x1B[${code}m${s}\x1B[0m`
const colored: Palette = { dim: on('2'), bold: on('1'), accent: on('38;2;103;232;249'), soft: on('38;2;192;132;252'), level: (depth, s) => on(['1;38;2;192;132;252', '38;2;165;180;252', '38;2;103;232;249', '0'][Math.min(depth, 3)]!)(s) }
const id = (s: string) => s
const plain: Palette = { dim: id, bold: id, accent: id, soft: id, level: (_, s) => s }
const note = (n: Node, c: Palette) => n.note === undefined ? '' : ` ${c.dim(n.note)}`
const isDir = (n: Node) => n.children !== undefined

const designs: Design[] = [
  { name: 'A. current', about: 'dim ├─ └─ │, bold roots', root: (n, c) => c.bold(n.label), line: (n, last, _d, c) => `${c.dim(last ? '└─' : '├─')} ${n.label}${note(n, c)}`, pad: (last, c) => c.dim(last ? '   ' : '│  ') },
  { name: 'B. rounded', about: 'soft corners, short stroke', root: (n, c) => c.bold(n.label), line: (n, last, _d, c) => `${c.dim(last ? '╰╴' : '├╴')}${n.label}${note(n, c)}`, pad: (last, c) => c.dim(last ? '  ' : '│ ') },
  { name: 'C. heavy', about: 'heavy guides, folders marked', root: (n, c) => c.bold(n.label), line: (n, last, _d, c) => `${c.dim(last ? '┗━' : '┣━')} ${isDir(n) ? c.bold(`${n.label}/`) : n.label}${note(n, c)}`, pad: (last, c) => c.dim(last ? '   ' : '┃  ') },
  { name: 'D. no lines', about: 'indent only, markers by kind (readable without box drawing)', root: (n, c) => `${c.soft('▾')} ${c.bold(n.label)}`, line: (n, _l, _d, c) => `${isDir(n) ? `${c.soft('▾')} ${c.bold(n.label)}` : `${c.dim('·')} ${n.label}`}${note(n, c)}`, pad: (_l, _c) => '  ', indent: '  ' },
  { name: 'E. dotted', about: 'quiet dotted guides', root: (n, c) => c.bold(n.label), line: (n, last, _d, c) => `${c.dim(last ? '└┈' : '├┈')} ${n.label}${note(n, c)}`, pad: (last, c) => c.dim(last ? '   ' : '┊  ') },
  { name: 'F. by depth', about: 'classic lines, label colour shifts with depth (the gradient purple to blue)', root: (n, c) => c.level(0, n.label), line: (n, last, d, c) => `${c.dim(last ? '└─' : '├─')} ${c.level(d, n.label)}${note(n, c)}`, pad: (last, c) => c.dim(last ? '   ' : '│  ') },
  { name: 'G. wide', about: 'wider strokes, folders in the accent colour', root: (n, c) => c.bold(n.label), line: (n, last, _d, c) => `${c.dim(last ? '╰──' : '├──')} ${isDir(n) ? c.accent(n.label) : n.label}${note(n, c)}`, pad: (last, c) => c.dim(last ? '    ' : '│   ') },
]

function draw(design: Design, c: Palette): string[] {
  const out: string[] = []

  function walk(nodes: Node[], prefix: string, depth: number) {
    for (const [index, node] of nodes.entries()) {
      const last = index === nodes.length - 1

      out.push(prefix + design.line(node, last, depth, c))
      walk(node.children ?? [], prefix + design.pad(last, c), depth + 1)
    }
  }

  for (const root of sample) {
    out.push(design.root(root, c))
    walk(root.children ?? [], design.indent ?? '', 1)
  }

  return out
}

for (const color of modes) {
  console.log(`\n=== ${color ? 'with colours' : 'plain'} ===`)

  for (const design of designs) {
    console.log(`\n${design.name}: ${design.about}`)
    console.log(draw(design, color ? colored : plain).join('\n'))
  }
}
