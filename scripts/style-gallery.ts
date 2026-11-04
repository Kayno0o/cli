import process from 'node:process'
import { badge, bar, barChart, keyValue, link, marked, role, sparkline, table, tree } from '../packages/kit/src'
import { task } from '../packages/kit/src/progress'

// Every look the kit draws, on one screen, to compare before and after a style change.
// Run it on a terminal for the human look, piped (`| cat`) or with NO_COLOR=1 for what an agent receives; `--live` runs a spinner for a while, to resize the window meanwhile.
const out = process.stdout

function section(title: string, body: string): void {
  console.log(`\n${role('label', out)(`-- ${title}`)}\n${body}`)
}

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
