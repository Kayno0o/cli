// Opens the picker on the real terminal, prints how it ended, then reads one more key from the terminal the way the command run next would.
import { openSync } from 'node:fs'
import tty from 'node:tty'
import { select } from '../../../src/picker/terminal'

const found = await select([{ hidden: ['id-1'], cells: ['install'] }], { multi: false, prompt: '> ', query: '', height: { lines: 6 }, preview: undefined })

console.log(found === undefined ? 'cancelled' : `picked ${found.rows[0]?.hidden[0]}`)

const next = new tty.ReadStream(openSync('/dev/tty', 'r'))

next.setRawMode(true)
next.once('data', (chunk) => {
  next.setRawMode(false)
  next.destroy()
  console.log(`next key ${chunk.toString()}`)
})
