import process from 'node:process'

type Env = Record<string, string | undefined>

// Who reads the output: a person at a `terminal`, a `ci` log, an `agent` paying for every token it reads, or `pipe` for anything else not on a terminal.
export type Mode = 'terminal' | 'ci' | 'agent' | 'pipe'

const MODES = new Set<string>(['terminal', 'ci', 'agent', 'pipe'])
// Variables an agent's own tool sets for what it runs: `CLAUDECODE` by Claude Code, `AI_AGENT` by the tools that follow that convention; another agent's variable goes here once confirmed.
const AGENT_VARIABLES = ['CLAUDECODE', 'AI_AGENT']

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false'
}

// `KIT_MODE` names the mode outright; otherwise an agent's variable wins over the stream, as what an agent runs lands in its transcript even on a pty, then a terminal, then `CI`.
export function outputMode(stream: { isTTY?: boolean } = process.stdout, env: Env = process.env): Mode {
  const chosen = env.KIT_MODE

  if (chosen !== undefined && MODES.has(chosen))
    return chosen as Mode

  if (AGENT_VARIABLES.some(name => isSet(env[name])))
    return 'agent'

  if (stream.isTTY === true)
    return 'terminal'

  return isSet(env.CI) ? 'ci' : 'pipe'
}
