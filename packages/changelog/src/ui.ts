import { paint } from '@kaynooo/cli-kit'

// Read per call: the colour flags are applied to the environment once the arguments are parsed.
export const out = () => paint(process.stdout)
export const err = () => paint(process.stderr)
