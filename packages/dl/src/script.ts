export interface Finding {
  line: number
  // What the line does, several joined by a comma: `fetches, sudo`.
  does: string
  text: string
}

export interface Summary {
  findings: Finding[]
  // The environment variables the script reads, the shell's own left out.
  env: string[]
}

// What a line of an install script does that a reader must see before running it, each by the word the summary shows.
const PATTERNS: [does: string, pattern: RegExp][] = [
  ['fetches', /\b(?:curl|wget)\b|https?:\/\//],
  ['sudo', /\b(?:sudo|doas)\b/],
  ['removes', /\brm\s+-[a-z]*[rf]/i],
  ['profile', /\.(?:bashrc|bash_profile|zshrc|zprofile|zshenv|profile)\b|\.config\/fish\b/],
  ['system', /(?:^|[\s"'=:])\/(?:usr|etc|opt|bin|sbin|lib)\//],
  ['runs', /\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|\beval\b/],
]
const COMMENT = /^\s*#/
// A variable read, its whole name taken so `$Red` is not read as `R`; only upper-case names count as the environment.
const VARIABLE = /\$\{?([A-Z_]\w*)/gi
const UPPER_CASE = /^[A-Z_][A-Z0-9_]*$/
// Variables every shell sets, which say nothing about how the script can be steered.
const SHELL_OWN = new Set(['HOME', 'PATH', 'PWD', 'OLDPWD', 'SHELL', 'USER', 'IFS', 'TERM', 'LINENO', 'RANDOM', 'UID', 'EUID', 'BASH_SOURCE', 'BASH_VERSION', 'ZSH_VERSION'])

// The lines of a script that fetch, use sudo, remove recursively, touch a shell profile or a system folder, or run code in a shell, with the variables it reads.
export function summarize(script: string): Summary {
  const findings: Finding[] = []
  const env = new Set<string>()

  for (const [index, text] of script.split('\n').entries()) {
    if (COMMENT.test(text))
      continue

    const does = PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([word]) => word)

    if (does.length > 0)
      findings.push({ line: index + 1, does: does.join(', '), text: text.trim() })

    for (const [, name] of text.matchAll(VARIABLE)) {
      if (UPPER_CASE.test(name!) && !SHELL_OWN.has(name!))
        env.add(name!)
    }
  }

  return { findings, env: [...env].sort() }
}
