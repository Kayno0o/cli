export interface Block {
  // The file the block names, undefined for one applying to the files given as arguments.
  file: string | undefined
  from: string
  to: string
}

const LINE_BREAK = /\r?\n/
const OPENER = /^(<{7,}) SEARCH$/

// Reads SEARCH/REPLACE blocks. A non-blank line outside a block names the file of the next one. A longer opener (`<<<<<<<<<< SEARCH`) makes the divider and closer that many characters too, for text that holds a 7-character marker line itself.
export function parseBlocks(text: string): Block[] | string {
  const blocks: Block[] = []
  const lines = text.split(LINE_BREAK)
  let file: string | undefined
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''
    const opener = OPENER.exec(line)

    i++

    if (opener === null) {
      if (line.trim() === '')
        continue

      if (file !== undefined)
        return `line ${i}: "${line}" after the file name "${file}", which wants a <<<<<<< SEARCH block next`

      file = line.trim()

      continue
    }

    const width = (opener[1] ?? '').length
    const divider = '='.repeat(width)
    const closer = `${'>'.repeat(width)} REPLACE`
    const start = i
    const search: string[] = []
    const replace: string[] = []
    let target = search
    let closed = false

    for (; i < lines.length; i++) {
      const inner = lines[i] ?? ''

      if (inner === closer && target === replace) {
        closed = true
        i++

        break
      }

      if (inner === divider && target === search)
        target = replace
      else
        target.push(inner)
    }

    if (!closed)
      return `line ${start}: the block never reaches its ${target === search ? `${divider} line and ` : ''}${closer} line`

    blocks.push({ file, from: search.join('\n'), to: replace.join('\n') })
    file = undefined
  }

  if (file !== undefined)
    return `the file name "${file}" is not followed by a block`

  return blocks.length === 0 ? 'no <<<<<<< SEARCH block found' : blocks
}
