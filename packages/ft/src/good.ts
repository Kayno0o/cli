import process from 'node:process'
import { role } from '@kaynooo/cli-kit'

// A line saying something went through, green on a terminal and as given elsewhere.
export function good(text: string): string {
  return role('ok', process.stdout)(text)
}
