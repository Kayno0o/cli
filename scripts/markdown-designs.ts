// Candidate looks for how `view` draws markdown, each element in a few variants three to a row: `bun scripts/markdown-designs.ts [--plain|--color] [element...]`, the elements being headings, inline, code, quote, lists, table, rule, links.
const PER_ROW = 3
const GAP = 4
const FROM = [192, 132, 252]
const TO = [103, 232, 249]

const args = process.argv.slice(2)
const modes = { '--plain': [false], '--color': [true] }[args[0] ?? ''] ?? [false, true]
const only = args.filter(arg => !arg.startsWith('--'))

let color = true

const sgr = (code: string, text: string) => color ? `\x1B[${code}m${text}\x1B[0m` : text
const bold = (text: string) => sgr('1', text)
const dim = (text: string) => sgr('2', text)
const italic = (text: string) => sgr('3', text)
const underline = (text: string) => sgr('4', text)
const accent = (text: string) => sgr('36', text)
const rgb = (t: number) => FROM.map((start, index) => Math.round(start + (TO[index]! - start) * t)).join(';')
const shade = (t: number, text: string, extra = '') => sgr(`${extra}38;2;${rgb(t)}`, text)
const background = (level: number, text: string) => sgr(`48;5;${level}`, text)
const gradientText = (text: string) => Array.from(text).map((char, index, all) => shade(all.length <= 1 ? 0 : index / (all.length - 1), char)).join('')
const blue = (text: string) => sgr('34', text)
const yellow = (text: string) => sgr('33', text)
const green = (text: string) => sgr('32', text)
const magenta = (text: string) => sgr('35', text)

interface Variant { name: string, about: string, draw: () => string[] }
interface Section { id: string, title: string, variants: Variant[] }

const COMMENT = /\/\/.*/
const CODE = ['const total = items', '  .filter(Boolean)', '  .length // count']

// A highlighted line of the sample code: keyword, string-free, comment dimmed.
function highlighted(line: string): string {
  return line.replace('const', magenta('const')).replace(COMMENT, comment => dim(comment))
}

const sections: Section[] = [
  {
    id: 'headings',
    title: 'Headings',
    variants: [
      { name: '1. hashes (now)', about: 'dim hashes, bold accent', draw: () => [1, 2, 3].map(level => `${dim(`${'#'.repeat(level)} `)}${bold(accent(['Title', 'Section', 'Detail'][level - 1]!))}`) },
      { name: '2. underlined', about: 'rule under the first two', draw: () => [`${bold(accent('Title'))}\n${accent('═════')}`, `${bold(accent('Section'))}\n${dim('───────')}`, bold('Detail')].flatMap(each => each.split('\n')) },
      { name: '3. side bar', about: 'a bar shaded by level', draw: () => [0, 0.5, 1].map((t, index) => `${shade(t, '▌')} ${bold(['Title', 'Section', 'Detail'][index]!)}`) },
      { name: '4. chip', about: 'h1 on a coloured chip', draw: () => [sgr('1;30;48;2;192;132;252', ' Title '), bold(accent('Section')), bold('Detail')] },
      { name: '5. gradient', about: 'letters along the gradient', draw: () => ['Title', 'Section', 'Detail'].map(text => bold(gradientText(text))) },
      { name: '6. size by tone', about: 'upper case, bold, plain', draw: () => [bold(shade(0, 'TITLE')), bold(accent('Section')), bold('Detail')] },
    ],
  },
  {
    id: 'inline',
    title: 'Inline code, emphasis',
    variants: [
      { name: '1. yellow (now)', about: 'the id colour, no ticks', draw: () => [`run ${yellow('bun test')} now`, `${bold('bold')} ${italic('italic')} ${sgr('9', 'gone')}`] },
      { name: '2. chip', about: 'dark background, padded', draw: () => [`run ${background(237, ' bun test ')} now`, `${bold('bold')} ${italic('italic')} ${sgr('9', 'gone')}`] },
      { name: '3. ticks', about: 'dim ticks around cyan', draw: () => [`run ${dim('`')}${accent('bun test')}${dim('`')} now`, `${bold('bold')} ${italic('italic')} ${sgr('9', 'gone')}`] },
      { name: '4. cyan chip', about: 'cyan text on a chip', draw: () => [`run ${sgr('36;48;5;237', ' bun test ')} now`, `${bold(shade(0, 'bold'))} ${italic('italic')} ${sgr('9', 'gone')}`] },
      { name: '5. magenta', about: 'magenta, no ticks', draw: () => [`run ${magenta('bun test')} now`, `${bold('bold')} ${italic(accent('italic'))} ${sgr('9', 'gone')}`] },
      { name: '6. underline', about: 'dim underline', draw: () => [`run ${sgr('4;2', 'bun test')} now`, `${bold('bold')} ${italic('italic')} ${sgr('9', 'gone')}`] },
    ],
  },
  {
    id: 'code',
    title: 'Code blocks',
    variants: [
      { name: '1. gutter (now)', about: 'dim bar before each line', draw: () => CODE.map(line => `${dim('│ ')}${highlighted(line)}`) },
      { name: '2. box', about: 'rounded box, language label', draw: () => [`${dim('╭─ ')}${accent('ts')}${dim(' ─────────────────────╮')}`, ...CODE.map(line => `${dim('│')} ${highlighted(line)}${' '.repeat(Math.max(0, 25 - line.length))}${dim('│')}`), dim('╰──────────────────────────╯')] },
      { name: '3. background', about: 'tinted block, padded', draw: () => CODE.map(line => background(236, ` ${highlighted(line).replaceAll('\x1B[0m', '\x1B[0;48;5;236m')}${' '.repeat(Math.max(0, 25 - line.length))} `)) },
      { name: '4. shaded gutter', about: 'bar down the gradient', draw: () => CODE.map((line, index) => `${shade(index / (CODE.length - 1), '▎')} ${highlighted(line)}`) },
      { name: '5. numbered', about: 'dim line numbers', draw: () => CODE.map((line, index) => `${dim(`${index + 1} │`)} ${highlighted(line)}`) },
      { name: '6. label rule', about: 'language over, rule under', draw: () => [`${dim('ts ')}${dim('─'.repeat(22))}`, ...CODE.map(highlighted), dim('─'.repeat(25))] },
    ],
  },
  {
    id: 'quote',
    title: 'Block quotes',
    variants: [
      { name: '1. dim bar (now)', about: '▎ then the text', draw: () => ['one sentence quoted', 'then a second line'].map(line => `${dim('▎ ')}${line}`) },
      { name: '2. purple bar', about: 'coloured bar, italic text', draw: () => ['one sentence quoted', 'then a second line'].map(line => `${shade(0, '▎')} ${italic(line)}`) },
      { name: '3. shaded bar', about: 'bar down the gradient', draw: () => ['one sentence quoted', 'then a second line'].map((line, index) => `${shade(index, '┃')} ${dim(line)}`) },
      { name: '4. quote mark', about: 'a big opening mark', draw: () => [`${shade(0, '❝')} one sentence quoted`, `  then a second line`] },
      { name: '5. indented', about: 'two spaces, dim italic', draw: () => ['one sentence quoted', 'then a second line'].map(line => `  ${dim(italic(line))}`) },
      { name: '6. background', about: 'tinted line', draw: () => ['one sentence quoted ', 'then a second line  '].map(line => background(236, ` ${line}`)) },
    ],
  },
  {
    id: 'lists',
    title: 'Lists',
    variants: [
      { name: '1. dots (now)', about: 'accent • ◦ ▪, numbers', draw: () => [`${accent('•')} first`, `  ${accent('◦')} nested`, `${accent('•')} second`, `${accent('1.')} one`, `${accent('2.')} two`, `${green('✓')} done`, `${dim('○')} todo`] },
      { name: '2. shaded', about: 'markers by depth', draw: () => [`${shade(0, '•')} first`, `  ${shade(1, '•')} nested`, `${shade(0, '•')} second`, `${shade(0, '1.')} one`, `${shade(0, '2.')} two`, `${green('✓')} done`, `${dim('○')} todo`] },
      { name: '3. dashes', about: 'dim dashes', draw: () => [`${dim('-')} first`, `  ${dim('-')} nested`, `${dim('-')} second`, `${dim('1.')} one`, `${dim('2.')} two`, `${green('✓')} done`, `${dim('☐')} todo`] },
      { name: '4. arrows', about: 'arrows deeper, small', draw: () => [`${accent('›')} first`, `  ${accent('›')} nested`, `${accent('›')} second`, `${accent('1')} one`, `${accent('2')} two`, `${green('☑')} done`, `${dim('☐')} todo`] },
      { name: '5. guides', about: 'dim guide for nesting', draw: () => [`${accent('•')} first`, `${dim('│')} ${accent('•')} nested`, `${accent('•')} second`, `${bold(accent('1'))}${dim('.')} one`, `${bold(accent('2'))}${dim('.')} two`, `${green('●')} done`, `${dim('○')} todo`] },
      { name: '6. squares', about: 'squares, bold numbers', draw: () => [`${accent('▪')} first`, `  ${accent('▫')} nested`, `${accent('▪')} second`, `${bold('1.')} one`, `${bold('2.')} two`, `${green('■')} done`, `${dim('□')} todo`] },
    ],
  },
  {
    id: 'table',
    title: 'Tables',
    variants: [
      { name: '1. rule (now)', about: 'bold header, rule under', draw: () => [`${bold('name  ')}  ${bold('files')}`, dim('─────────────'), 'kit       34', 'ft        21'] },
      { name: '2. grid', about: 'full box drawing', draw: () => [dim('┌────────┬───────┐'), `${dim('│')} ${bold('name  ')} ${dim('│')} ${bold('files')} ${dim('│')}`, dim('├────────┼───────┤'), `${dim('│')} kit    ${dim('│')}    34 ${dim('│')}`, `${dim('│')} ft     ${dim('│')}    21 ${dim('│')}`, dim('└────────┴───────┘')] },
      { name: '3. rounded', about: 'rounded, header rule only', draw: () => [dim('╭────────┬───────╮'), `${dim('│')} ${bold(accent('name  '))} ${dim('│')} ${bold(accent('files'))} ${dim('│')}`, dim('├────────┼───────┤'), `${dim('│')} kit    ${dim('│')}    34 ${dim('│')}`, `${dim('│')} ft     ${dim('│')}    21 ${dim('│')}`, dim('╰────────┴───────╯')] },
      { name: '4. header band', about: 'tinted header row', draw: () => [background(236, bold(' name       files ')), ' kit           34', ' ft            21'] },
      { name: '5. separators', about: 'dim bars between columns', draw: () => [`${bold('name  ')} ${dim('│')} ${bold('files')}`, dim('───────┼──────'), `kit    ${dim('│')}    34`, `ft     ${dim('│')}    21`] },
      { name: '6. zebra', about: 'every other row tinted', draw: () => [bold(accent('name       files')), background(235, 'kit           34'), 'ft            21', background(235, 'pick           8')] },
    ],
  },
  {
    id: 'rule',
    title: 'Horizontal rules',
    variants: [
      { name: '1. thin (now)', about: 'dim ─', draw: () => [dim('─'.repeat(28))] },
      { name: '2. gradient', about: 'purple to blue', draw: () => [Array.from({ length: 28 }, (_, index) => shade(index / 27, '─')).join('')] },
      { name: '3. heavy', about: 'dim ━', draw: () => [dim('━'.repeat(28))] },
      { name: '4. dotted', about: 'dim ┈', draw: () => [dim('┈'.repeat(28))] },
      { name: '5. ornament', about: 'a mark in the middle', draw: () => [`${dim('─'.repeat(12))} ${shade(0.5, '✦')} ${dim('─'.repeat(12))}`] },
      { name: '6. short', about: 'a short bold rule', draw: () => [shade(0, '━'.repeat(8))] },
    ],
  },
  {
    id: 'links',
    title: 'Links, images, html',
    variants: [
      { name: '1. underline (now)', about: 'blue underlined text', draw: () => [`see ${underline(blue('the docs'))} here`, dim('[image: logo]'), dim('<br>')] },
      { name: '2. with url', about: 'text then the url dimmed', draw: () => [`see ${underline(blue('the docs'))} ${dim('(kaynooo.fr)')}`, dim('[image: logo]'), dim('<br>')] },
      { name: '3. arrow', about: 'a small arrow after it', draw: () => [`see ${blue('the docs')}${dim('↗')} here`, `${dim('▣')} ${dim('logo')}`, dim('<br>')] },
      { name: '4. cyan', about: 'accent underline', draw: () => [`see ${sgr('4;36', 'the docs')} here`, `${dim('🖼')} ${dim('logo')}`, dim('<br>')] },
      { name: '5. gradient', about: 'gradient underline', draw: () => [`see ${underline(gradientText('the docs'))} here`, `${dim('▢')} ${dim('logo')}`, dim('<br>')] },
      { name: '6. bracket', about: 'dim brackets', draw: () => [`see ${dim('[')}${blue('the docs')}${dim(']')} here`, `${dim('[')}${dim('img')} ${dim('logo')}${dim(']')}`, dim('<br>')] },
    ],
  },
]

const stripped = (text: string) => Bun.stripANSI(text)

for (const useColor of modes) {
  color = useColor
  console.log(`\n=== ${color ? 'with colours' : 'plain'} ===`)

  for (const section of sections.filter(each => only.length === 0 || only.includes(each.id))) {
    console.log(`\n${bold(`## ${section.title}`)}`)

    for (let start = 0; start < section.variants.length; start += PER_ROW) {
      const group = section.variants.slice(start, start + PER_ROW)
      const drawn = group.map(variant => variant.draw())
      const width = Math.max(...drawn.flat().map(line => Bun.stringWidth(stripped(line))), ...group.map(variant => variant.about.length), ...group.map(variant => variant.name.length))
      const rows = Math.max(...drawn.map(lines => lines.length))
      const cell = (text: string) => text + ' '.repeat(width - Bun.stringWidth(stripped(text)) + GAP)

      console.log()
      console.log(group.map(variant => cell(bold(variant.name))).join('').trimEnd())
      console.log(group.map(variant => cell(dim(variant.about))).join('').trimEnd())

      for (let row = 0; row < rows; row++)
        console.log(drawn.map(lines => cell(lines[row] ?? '')).join('').trimEnd())
    }
  }
}
