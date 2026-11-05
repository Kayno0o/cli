import process from 'node:process'
import { activeTheme, badge, bar, barChart, header, keyValue, link, marked, role, sparkline, table, textWidth, tree } from '../packages/kit/src'
import { task } from '../packages/kit/src/progress'

// Every look the kit draws, on one screen, to compare before and after a style change.
// Run it on a terminal for the human look, piped (`| cat`) or with NO_COLOR=1 for what an agent receives; `--save <name>` stores the render in colour and `--diff <name>` shows it next to the current one, `--plain` for the piped look; `--live` runs a spinner for a while, to resize the window meanwhile.
// A render taken for a snapshot draws its colours as on a terminal, unless --plain asks for what an agent receives.
if (process.env.GALLERY_COLOR === '1')
  Object.defineProperty(process.stdout, 'isTTY', { value: true })

const out = process.stdout
const SNAPSHOTS = new URL('.gallery/', import.meta.url).pathname
const flag = (name: string) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined
const saving = flag('--save')
const comparing = flag('--diff')

// Rows that match line up through the longest common run of lines; between two matches the changed lines pair off, and the surplus on one side faces a blank.
function alignRows(left: string[], right: string[]): [string | undefined, string | undefined][] {
  const common = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0))

  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--)
      common[i]![j] = left[i] === right[j] ? common[i + 1]![j + 1]! + 1 : Math.max(common[i + 1]![j]!, common[i]![j + 1]!)
  }

  const rows: [string | undefined, string | undefined][] = []
  let i = 0
  let j = 0

  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      rows.push([left[i++], right[j++]])

      continue
    }

    const removed: string[] = []
    const added: string[] = []

    while (i < left.length && (j >= right.length || left[i] !== right[j]) && (j >= right.length || common[i + 1]![j]! >= common[i]![j + 1]!))
      removed.push(left[i++]!)

    while (j < right.length && (i >= left.length || left[i] !== right[j]) && (i >= left.length || common[i]![j + 1]! > common[i + 1]![j]!))
      added.push(right[j++]!)

    for (let row = 0; row < Math.max(removed.length, added.length); row++)
      rows.push([removed[row], added[row]])
  }

  return rows
}

function barColour(a: string | undefined, b: string | undefined): number {
  if (a === undefined)
    return 32

  return b === undefined ? 31 : 33
}

// The two renders side by side: a dim bar between rows that match, yellow between ones that changed, green where a row was added and red where one went.
function sideBySide(before: string, now: string): string {
  const rows = alignRows(before.split('\n'), now.split('\n'))
  const width = Math.max(6, ...rows.map(([a]) => textWidth(a ?? '')))
  const paint = (code: number, text: string) => `\x1B[${code}m${text}\x1B[0m`
  const lines = rows.map(([a, b]) => {
    const bar = paint(a === b ? 2 : barColour(a, b), a === b ? '│' : '┃')

    return `${a ?? ''}${' '.repeat(width - textWidth(a ?? ''))} ${bar} ${b ?? ''}`
  })

  return [`${paint(2, 'before'.padEnd(width))}   ${paint(2, 'now')}`, ...lines].join('\n')
}

if (saving !== undefined || comparing !== undefined) {
  const plain = process.argv.includes('--plain')
  const render = () => Bun.spawnSync(['bun', import.meta.path], { stdout: 'pipe', stderr: 'inherit', env: { ...process.env, GALLERY_COLOR: plain ? '0' : '1' } }).stdout.toString()
  const rendered = render()
  const file = `${SNAPSHOTS}${saving ?? comparing}${plain ? '.plain' : ''}.txt`

  if (saving !== undefined) {
    await Bun.write(file, rendered)
    console.log(`saved ${saving}: ${Buffer.byteLength(rendered)} bytes`)
  }
  else {
    const before = await Bun.file(file).text()

    console.log(sideBySide(before, rendered))
    console.log(`\n${Buffer.byteLength(before)} -> ${Buffer.byteLength(rendered)} bytes${plain ? '' : ' (colour codes included, --plain for what an agent receives)'}`)
  }

  process.exit(0)
}

function section(title: string, body: string): void {
  console.log(`\n${role('label', out)(`-- ${title}`)}\n${body}`)
}

section('theme', (() => {
  const { preset, sources } = activeTheme()

  return keyValue([['preset', preset], ['files', sources.length === 0 ? 'none' : sources.join(', ')]], { stream: out })
})())
// A header is empty off a terminal, so a plain gallery has no section for it.
const headers = [header('check', 'cli · 4 steps', out), header('ft', undefined, out), header('pick', 'kit', out), header('db', 'local', out)].filter(line => line !== '')

if (headers.length > 0)
  section('header', headers.join('\n'))

section('marks', ['ok', 'warn', 'problem', 'note'].map(mark => marked(mark as 'ok', `a ${mark} line`, out, 'detail')).join('\n'))
section('roles', (['accent', 'id', 'path', 'label', 'value'] as const).map(name => role(name, out)(name)).join('  '))
section('status badges', ['success', 'failure', 'running', 'waiting', 'skipped'].map(word => badge(word, out)).join('  '))
section('link', link('issue #49', 'https://git.kaynooo.fr/kaynooo/cli/issues/49', out))
section('table', table([
  ['bin', 'package', 'runs', 'age'],
  ['check', 'packages/check', '128', '2m'],
  ['ft', 'packages/ft', '1042', '14h'],
  ['pick', 'packages/pick', '36', '3d'],
], { header: true, align: ['left', 'left', 'right', 'right'] }))
section('key value', keyValue([['state', 'open'], ['labels', 'ux, kit'], ['author', 'kaynooo']]))
section('bar', `${bar(0.35)}  ${bar(0.8, { width: 10 })}`)
section('bar chart', barChart([['kit', 42], ['ft', 30], ['pick', 7]]))
section('sparkline', sparkline([1, 3, 2, 5, 8, 4, 9, 6]))
section('tree', tree([{ label: 'packages', children: [{ label: 'kit', children: [{ label: 'picker' }] }, { label: 'pick' }] }]))

if (process.argv.includes('--live')) {
  console.log(`\n${role('label', out)('-- live: resize the window now, nothing should be left behind')}`)

  await task('building', async (update) => {
    for (let done = 0; done <= 100; done += 2) {
      update({ done, total: 100, unit: '%' })
      await Bun.sleep(100)
    }
  })

  console.log(marked('ok', 'live part finished', out))
}
