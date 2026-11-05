// Destroys a /dev/tty ReadStream a moment after its first key, as the picker did before it read keys elsewhere.
import { openSync } from 'node:fs'
import tty from 'node:tty'

const input = new tty.ReadStream(openSync('/dev/tty', 'r'))

input.setRawMode(true)
input.once('data', () => setTimeout(() => {
  input.setRawMode(false)
  input.destroy()
}, 30))
