import type { Example } from '../src'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, spyOn, test } from 'bun:test'
import { applyOutput, badUsage, description, fail, mainArgs, packageVersion, parse, printHint, runCli, runHint, runMain } from '../src'
import { capture, tempDirs } from '../src/test'

const cli = {
  name: 'demo',
  version: '1.2.3',
  about: 'a demo',
  commands: {
    echo: { summary: 'prints its arguments', run: async (args: string[]) => {
      console.log(args.join(' '))

      return 0
    } },
    boom: { summary: 'fails', run: async () => fail('it broke', 4) },
    plan: {
      summary: 'a group',
      commands: {
        add: { summary: 'adds', run: async (args: string[]) => {
          console.log(`add ${args.join(' ')}`)

          return 0
        } },
        bad: { summary: 'fails', run: async () => badUsage('nope') },
      },
      aliases: { new: 'add' },
    },
  },
  aliases: { say: 'echo' },
}

describe('runCli', () => {
  test('runs a command or its alias with the rest of the arguments', async () => {
    expect(await capture(async () => runCli(cli, ['echo', 'a', 'b']))).toEqual({ result: 0, out: 'a b\n', err: '' })
    expect((await capture(async () => runCli(cli, ['say', 'c']))).out).toBe('c\n')
  })

  test('prints the version and the help', async () => {
    expect((await capture(async () => runCli(cli, ['-v']))).out).toBe('1.2.3\n')
    expect((await capture(async () => runCli(cli, []))).out).toBe('demo 1.2.3  a demo\n\nUsage: demo <command> [options]\n\nCommands:\n  echo  prints its arguments\n  boom  fails\n  plan  a group\n\nOptions:\n      --color <value>  auto (on a terminal alone), always or never\n      --plain          plain text, no colour or spinner: --color never\n  -h, --help           show this help\n  -v, --version        print the version\n\nRun demo <command> --help for its options.\n')
  })

  test('names the command an Exit came from and uses its code', async () => {
    expect(await capture(async () => runCli(cli, ['boom']))).toEqual({ result: 4, out: '', err: 'error: demo boom: it broke\n' })
  })

  test('points a typo at the command meant', async () => {
    expect(await capture(async () => runCli(cli, ['ech']))).toEqual({ result: 2, out: '', err: 'error: demo: no command ech\n  hint: did you mean echo?\n' })
  })

  test('gives a usage error a hint at the help, an Exit its own hint, and a failure none', async () => {
    const hinted = { ...cli, commands: { own: { summary: 'own hint', run: async () => fail('no remote', 1, 'add one with git remote add') } } }

    expect((await capture(async () => runCli(hinted, ['own']))).err).toBe('error: demo own: no remote\n  hint: add one with git remote add\n')
    expect((await capture(async () => runCli(cli, ['nope']))).err).toBe('error: demo: no command nope\n  hint: run demo --help for its commands\n')
  })

  test('hands the arguments to the default command when the first names none', async () => {
    const withDefault = { ...cli, defaultCommand: 'echo' }

    expect((await capture(async () => runCli(withDefault, ['-n', '5', 'x']))).out).toBe('-n 5 x\n')
    expect((await capture(async () => runCli(withDefault, ['echo', 'x']))).out).toBe('x\n')
  })

  test('lists the default command\'s options in the help, without running it', async () => {
    const ran: string[] = []
    const withDefault = { ...cli, commands: { ...cli.commands, port: { summary: 'parses first', run: async (args: string[]) => {
      parse(args, 'demo port [options]', { max: { type: 'string', description: 'highest port' } })
      ran.push('port')

      return 0
    } } }, defaultCommand: 'port' }

    expect((await capture(async () => runCli(withDefault, ['--help']))).out).toBe('demo 1.2.3  a demo\n\nUsage: demo [<command>] [options]\n\nCommands:\n  echo  prints its arguments\n  boom  fails\n  plan  a group\n  port  parses first\n\nOptions of port: the command run when none is named\n      --max <value>  highest port\n\nOptions:\n      --color <value>  auto (on a terminal alone), always or never\n      --plain          plain text, no colour or spinner: --color never\n  -h, --help           show this help\n  -v, --version        print the version\n\nRun demo <command> --help for its options.\n')
    expect(ran).toEqual([])
  })

  test('ends a command on its --help with exit 0, printing the help alone', async () => {
    const helped = { ...cli, commands: { port: { summary: 'parses first', run: async (args: string[]) => {
      parse(args, 'demo port', {})
      console.log('ran')

      return 3
    } } } }

    expect(await capture(async () => runCli(helped, ['port', '--help']))).toEqual({ result: 0, out: 'Usage: demo port\n\nOptions:\n      --color <value>  auto (on a terminal alone), always or never\n      --plain          plain text, no colour or spinner: --color never\n  -h, --help           show this help\n', err: '' })
  })

  test('names an error other than an Exit by its class, prints its cause\'s message under it, and redacts both', async () => {
    class MigrationError extends Error {
      override name = 'MigrationError'
    }
    const failing = { ...cli, commands: { sync: { summary: 'fails with a cause', run: async () => {
      throw new MigrationError('sync failed for secret-row', { cause: new Error('duplicate key secret-row') })
    } } } }

    expect(await capture(async () => runCli(failing, ['sync']))).toEqual({ result: 1, out: '', err: 'error: demo sync: MigrationError: sync failed for secret-row\n  cause: duplicate key secret-row\n' })
    expect((await capture(async () => runCli({ ...failing, redact: (text: string) => text.replaceAll('secret-row', '[redacted]') }, ['sync']))).err).toBe('error: demo sync: MigrationError: sync failed for [redacted]\n  cause: duplicate key [redacted]\n')
  })

  test('prints a cause that is not an Error as nothing, never the object itself', async () => {
    const failing = { ...cli, commands: { sync: { summary: 'fails', run: async () => {
      throw new Error('boom', { cause: { row: 'secret' } })
    } } } }

    expect((await capture(async () => runCli(failing, ['sync']))).err).toBe('error: demo sync: boom\n')
  })

  test('dispatches a group\'s subcommands', async () => {
    expect((await capture(async () => runCli(cli, ['plan', 'add', '1', '2']))).out).toBe('add 1 2\n')
    expect((await capture(async () => runCli(cli, ['plan', 'new', '3']))).out).toBe('add 3\n')
    expect(await capture(async () => runCli(cli, ['plan', 'bad']))).toEqual({ result: 2, out: '', err: 'error: demo plan bad: nope\n  hint: run demo plan bad --help for its options\n' })
    expect((await capture(async () => runCli(cli, ['plan', '--help']))).out).toStartWith('demo plan  a group')
    expect((await capture(async () => runCli(cli, ['plan']))).result).toBe(2)
    expect((await capture(async () => runCli(cli, ['plan', 'ad']))).err).toBe('error: demo plan: no command ad\n  hint: did you mean add?\n')
  })
})

describe('hidden commands', () => {
  const hiding = { ...cli, commands: { ...cli.commands, names: { summary: 'for the shell', hidden: true, run: cli.commands.echo.run } } }

  test('run as usual but stay out of the help and the completion', async () => {
    expect((await capture(async () => runCli(hiding, ['names', 'a']))).out).toBe('a\n')
    expect((await capture(async () => runCli(hiding, ['--help']))).out).not.toContain('names')
    expect((await capture(async () => runCli(hiding, ['__complete', '']))).out).not.toContain('names')
  })

  test('are never named by a typo hint', async () => {
    expect((await capture(async () => runCli(hiding, ['name']))).err).toBe('error: demo: no command name\n  hint: run demo --help for its commands\n')
  })
})

describe('runMain', () => {
  const main = (run: (args: string[]) => Promise<number>) => ({ name: 'solo', version: '0.4.0', run })

  test('prints the version when it is the only argument', async () => {
    expect(await capture(async () => runMain(main(async () => 9), ['--version']))).toEqual({ result: 0, out: '0.4.0\n', err: '' })
    expect((await capture(async () => runMain(main(async () => 9), ['-v']))).out).toBe('0.4.0\n')
  })

  test('returns the run\'s exit code', async () => {
    expect((await capture(async () => runMain(main(async () => 3), ['x']))).result).toBe(3)
  })

  test('turns an Exit or an error into a message and an exit code', async () => {
    expect(await capture(async () => runMain(main(async () => badUsage('bad input')), []))).toEqual({ result: 2, out: '', err: 'error: solo: bad input\n  hint: run solo --help for its options\n' })
    expect((await capture(async () => runMain(main(async () => fail('timed out', 2)), []))).err).toBe('error: solo: timed out\n')
    expect(await capture(async () => runMain(main(async () => {
      throw new Error('crash')
    }), []))).toEqual({ result: 1, out: '', err: 'error: solo: crash\n' })
  })

  test('prints the error as JSON when the command was given --json', async () => {
    expect(await capture(async () => runMain(main(async () => badUsage('bad input')), ['--json']))).toEqual({ result: 2, out: '', err: '{"error":"bad input","hint":"run solo --help for its options"}\n' })
    expect((await capture(async () => runMain(main(async () => fail('timed out', 2)), ['--json', 'x']))).err).toBe('{"error":"timed out"}\n')
    expect((await capture(async () => runMain(main(async () => fail('timed out', 2)), ['--', '--json']))).err).toBe('error: solo: timed out\n')
    expect((await capture(async () => runCli({ name: 'demo', version: '1.0.0', about: 'a demo', commands: { boom: { summary: 'fails', run: async () => fail('it broke', 4) } } }, ['boom', '--json']))).err).toBe('{"error":"it broke"}\n')
  })
})

describe('mainArgs', () => {
  const OPTS = { port: { type: 'string' } } as const
  const parsing = async (argv: string[]) => {
    const exits: number[] = []
    const exit = spyOn(process, 'exit').mockImplementation((code) => {
      exits.push(Number(code ?? 0))

      throw new Error('exited')
    })

    let values: { port?: string | undefined } | undefined

    try {
      const captured = await capture(async () => {
        try {
          values = await mainArgs({ name: 'solo', version: '0.4.0' }, args => parse(args, 'solo', OPTS).values, argv)
        }
        catch (error) {
          if (!(error instanceof Error) || error.message !== 'exited')
            throw error
        }

        return 0
      })

      return { ...captured, exits, values }
    }
    finally {
      exit.mockRestore()
    }
  }

  test('hands the parsed values back', async () => {
    expect((await parsing(['--port', '80'])).values).toEqual({ port: '80' })
  })

  test('ends the process itself on help, version, completion or a usage error', async () => {
    expect(await parsing(['--help'])).toMatchObject({ exits: [0], out: expect.stringContaining('Usage: solo') })
    expect(await parsing(['--version'])).toMatchObject({ exits: [0], out: '0.4.0\n' })
    expect(await parsing(['__complete', '--'])).toMatchObject({ exits: [0], out: expect.stringContaining('--port') })
    expect(await parsing(['--nope'])).toMatchObject({ exits: [2], err: expect.stringContaining('solo: unknown option') })
  })
})

describe('defaultCommand', () => {
  const list = async (args: string[]) => {
    parse(args, 'list', {}, { positionals: ['[name]'] })
    console.log('listing')

    return 0
  }
  const withDefault = { ...cli, commands: { ...cli.commands, ls: { summary: 'lists', run: list } }, defaultCommand: 'ls' }

  test('names the default command, not the typed argument, in an error', async () => {
    expect((await capture(async () => runCli(withDefault, ['a', 'b']))).err).toBe('error: demo ls: unexpected argument b\n  hint: run demo ls --help for its options\n')
  })

  test('__complete adds the default command\'s first positional values after the subcommands, minus a name a command has', async () => {
    const picking = { ...cli, commands: { ...cli.commands, up: { summary: 'starts', run: async (args: string[]) => {
      parse(args, 'up <project>', {}, { positionals: ['<project>'], candidates: { '<project>': () => [['alpha', 'the first'], 'echo'] } })

      return 0
    } } }, defaultCommand: 'up' }

    expect((await capture(async () => runCli(picking, ['__complete', '']))).out).toBe('echo\tprints its arguments\nboom\tfails\nplan\ta group\nup\tstarts\nalpha\tthe first\n')
    expect((await capture(async () => runCli(withDefault, ['__complete', '']))).out).toBe('echo\tprints its arguments\nboom\tfails\nplan\ta group\nls\tlists\n')
  })

  test('prints the help for a bare run unless told to run the default command', async () => {
    expect((await capture(async () => runCli(withDefault, []))).out).toStartWith('demo 1.2.3')
    expect(await capture(async () => runCli({ ...withDefault, runBare: true }, []))).toEqual({ result: 0, out: 'listing\n', err: '' })
  })
})

describe('__complete', () => {
  const ran: string[] = []
  const parsing = {
    ...cli,
    commands: {
      ...cli.commands,
      port: { summary: 'parses first', run: async (args: string[]) => {
        parse(args, 'port <name>', { max: { type: 'string', description: 'highest port' }, bare: { type: 'boolean' } })
        ran.push('port')

        return 0
      } },
    },
  }

  test('offers --no-<flag> for a negatable flag, and the positive one only with a description of its own', async () => {
    const toggling = { ...cli, commands: { ...cli.commands, sync: { summary: 'syncs', run: async (args: string[]) => {
      parse(args, 'sync', { refresh: { type: 'boolean', negative: 'keep the cached copy' }, md: { type: 'boolean', description: 'markdown', negative: 'no markdown' } }, { allowNegative: true })

      return 0
    } } } }

    expect((await capture(async () => runCli(toggling, ['__complete', 'sync', '--']))).out).toStartWith('--no-refresh\tkeep the cached copy\n--md\tmarkdown\n--no-md\tno markdown\n')
  })

  test('offers the candidates of the positional being typed, and of an option\'s value from a function', async () => {
    const naming = { ...cli, commands: { ...cli.commands, open: { summary: 'opens', run: async (args: string[]) => {
      parse(args, 'open <project> [more...]', { out: { type: 'string', short: 'o', candidates: () => ['a', ['b', 'the b']] }, all: { type: 'boolean' } }, {
        positionals: ['<project>', '[more...]'],
        candidates: { '<project>': async () => [['alpha', 'the first'], 'beta'], '[more...]': () => ['x', 'y'] },
      })

      return 0
    } } } }
    const complete = async (...words: string[]) => (await capture(async () => runCli(naming, ['__complete', 'open', ...words]))).out

    expect(await complete('')).toBe('alpha\tthe first\nbeta\n')
    expect(await complete('--all', 'al')).toBe('alpha\tthe first\nbeta\n')
    expect(await complete('-o', 'a', '')).toBe('alpha\tthe first\nbeta\n')
    expect(await complete('alpha', 'b', '')).toBe('x\ny\n')
    expect(await complete('alpha', '')).toBe('x\ny\n')
    expect(await complete('--out', '')).toBe('a\nb\tthe b\n')
    expect(await complete('--', 'p', '')).toBe('x\ny\n')
  })

  test('still offers paths for a positional with no candidates', async () => {
    const plain = { ...cli, commands: { ...cli.commands, put: { summary: 'puts', run: async (args: string[]) => {
      parse(args, 'put <file> <name>', { to: { type: 'string' } }, { positionals: ['<file>', '<name>'], candidates: { '<name>': () => ['n'] } })

      return 0
    } } } }

    expect((await capture(async () => runCli(plain, ['__complete', 'put', '']))).out).toBe('__files__\n')
    expect((await capture(async () => runCli(plain, ['__complete', 'put', 'f', '']))).out).toBe('n\n')
    expect((await capture(async () => runCli(plain, ['__complete', 'put', '--to', '']))).out).toBe('__files__\n')
  })

  test('offers the choices of the string option just typed', async () => {
    const choosing = { ...cli, commands: { ...cli.commands, pick: { summary: 'picks', run: async (args: string[]) => {
      parse(args, 'pick', { bump: { type: 'string', short: 'b', choices: ['patch', 'minor'] }, name: { type: 'string' } })

      return 0
    } } } }

    expect((await capture(async () => runCli(choosing, ['__complete', 'pick', '--bump', '']))).out).toBe('patch\nminor\n')
    expect((await capture(async () => runCli(choosing, ['__complete', 'pick', '-b', 'm']))).out).toBe('patch\nminor\n')
    expect((await capture(async () => runCli(choosing, ['__complete', 'pick', '--name', '']))).out).toBe('__files__\n')
  })

  test('lists the commands, or a group\'s, with their summaries', async () => {
    expect((await capture(async () => runCli(parsing, ['__complete', '']))).out).toBe('echo\tprints its arguments\nboom\tfails\nplan\ta group\nport\tparses first\n')
    expect((await capture(async () => runCli(parsing, ['__complete', 'plan', 'a']))).out).toBe('add\tadds\nbad\tfails\n')
  })

  test('lists a command\'s options without running it, and asks for paths otherwise', async () => {
    expect((await capture(async () => runCli(parsing, ['__complete', 'port', '--']))).out).toBe('--max\thighest port\n--bare\n--color\tauto (on a terminal alone), always or never\n--plain\tplain text, no colour or spinner: --color never\n--help\tshow this help\n')
    expect((await capture(async () => runCli(parsing, ['__complete', 'port', '']))).out).toBe('__files__\n')
    expect(ran).toEqual([])
    expect((await capture(async () => runCli(parsing, ['port']))).result).toBe(0)
    expect(ran).toEqual(['port'])
  })

  test('completes a single-command bin\'s options', async () => {
    const run = async (args: string[]) => {
      parse(args, 'x', { only: { type: 'string', description: 'some' } })

      return 0
    }

    expect((await capture(async () => runMain({ name: 'x', version: '1', run }, ['__complete', '-']))).out).toBe('--only\tsome\n--color\tauto (on a terminal alone), always or never\n--plain\tplain text, no colour or spinner: --color never\n--help\tshow this help\n')
  })
})

// Runs `body` with NO_COLOR and FORCE_COLOR put back after, as the output flags set them on process.env.
async function keepingColorEnv<T>(body: () => Promise<T>): Promise<T> {
  const saved = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR }

  try {
    return await body()
  }
  finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined)
        Reflect.deleteProperty(process.env, key)
      else
        process.env[key] = value
    }
  }
}

describe('output flags', () => {
  test('--plain and --color set what the colours read, each choice dropping the other', () => {
    const env: Record<string, string | undefined> = { FORCE_COLOR: '1' }

    applyOutput(undefined, true, env)
    expect(env).toEqual({ NO_COLOR: '1' })
    applyOutput('always', undefined, env)
    expect(env).toEqual({ FORCE_COLOR: '1' })
    applyOutput('auto', undefined, env)
    expect(env).toEqual({ FORCE_COLOR: '1' })
    expect(() => applyOutput('sometimes', undefined, {})).toThrow('--color takes auto, always or never, not sometimes')
  })

  test('are taken before the command name and by every command\'s parse, a command\'s own --plain left to it', async () => {
    await keepingColorEnv(async () => {
      expect(await capture(async () => runCli(cli, ['--plain', 'echo', 'hi']))).toEqual({ result: 0, out: 'hi\n', err: '' })
      expect(process.env.NO_COLOR).toBe('1')

      parse(['--color=always'], 'u', {})
      expect([process.env.FORCE_COLOR, process.env.NO_COLOR]).toEqual(['1', undefined])
      expect(parse(['--plain'], 'u', { plain: { type: 'boolean', description: 'its own' } }).values.plain).toBe(true)
      expect(process.env.NO_COLOR).toBeUndefined()

      const refused = await capture(async () => runCli(cli, ['--color', 'sometimes', 'echo']))

      expect(refused.result).toBe(2)
      expect(refused.err).toContain('--color takes auto, always or never, not sometimes')
    })
  })
})

describe('the help screen', () => {
  const run = async () => 0

  test('lists grouped commands under their heading after the others, and the CLI\'s examples', async () => {
    const examples: Example[] = ['demo echo hi', ['demo prune', 'as a cron job']]
    const grouped = { ...cli, commands: { echo: cli.commands.echo, prune: { summary: 'drops old runs', group: 'Admin', run }, boom: cli.commands.boom }, examples }
    const { out } = await capture(async () => runCli(grouped, ['--help']))

    expect(out).toContain('Commands:\n  echo   prints its arguments\n  boom   fails\n\nAdmin:\n  prune  drops old runs\n')
    expect(out).toContain('\n\nExamples:\n  demo echo hi\n  demo prune  # as a cron job\n\nRun demo')
  })

  test('shows a command\'s examples under its options', async () => {
    const example = async (args: string[]) => {
      parse(args, 'demo', {}, { examples: ['demo a'] })

      return 0
    }

    expect((await capture(async () => runMain({ name: 'demo', version: '1', run: example }, ['--help']))).out).toEndWith('show this help\n\nExamples:\n  demo a\n')
  })

  test('names what a command and a CLI replace under their usage', async () => {
    const replacing = async (args: string[]) => {
      parse(args, 'demo [file]: prints a file', {}, { replaces: 'cat' })

      return 0
    }

    expect((await capture(async () => runMain({ name: 'demo', version: '1', run: replacing }, ['--help']))).out).toStartWith('Usage: demo [file]: prints a file\n\nInstead of: cat\n\nOptions:')
    expect((await capture(async () => runCli({ ...cli, replaces: 'echo' }, ['--help']))).out).toContain('Usage: demo <command> [options]\n\nInstead of: echo\n\nCommands:')
  })

  test('prints the description as JSON under KIT_HELP=json', async () => {
    const described = async (args: string[]) => {
      parse(args, 'demo [file]: prints a file\n\nExits 0 always.', {}, { replaces: 'cat', examples: ['demo a', ['demo', 'stdin']] })

      return 0
    }

    process.env.KIT_HELP = 'json'

    try {
      expect(JSON.parse((await capture(async () => runMain({ name: 'demo', version: '1', run: described }, ['--help']))).out)).toEqual({ synopsis: 'demo [file]', summary: 'prints a file', replaces: 'cat', examples: [{ line: 'demo a' }, { line: 'demo', note: 'stdin' }], options: expect.arrayContaining([{ name: 'help', short: 'h', description: 'show this help' }]) })
      expect(JSON.parse((await capture(async () => runCli({ ...cli, examples: ['demo echo hi'] }, ['--help']))).out)).toEqual({ synopsis: 'demo <command> [options]', summary: 'a demo', examples: [{ line: 'demo echo hi' }] })
    }
    finally {
      delete process.env.KIT_HELP
    }
  })

  test('takes the summary from the line after the synopses when the first names none', () => {
    expect(description('errs [log]\nerrs -- <command>\n\nPrints one line per error.\nMore.')).toEqual({ synopsis: 'errs [log]', summary: 'prints one line per error', examples: [] })
  })
})

describe('runHint', () => {
  test('words a runnable command as a hint, with what it does when given', async () => {
    expect(runHint('ft take 12 --take-stale')).toBe('run `ft take 12 --take-stale`')
    expect(runHint('ft take 12 --take-stale', 'take it over')).toBe('run `ft take 12 --take-stale` to take it over')

    const hinted = { ...cli, commands: { own: { summary: 'own hint', run: async () => fail('held', 1, runHint('demo free')) } } }

    expect((await capture(async () => runCli(hinted, ['own']))).err).toBe('error: demo own: held\n  hint: run `demo free`\n')
  })

  test('prints a hint under a refusal a command prints itself', async () => {
    expect((await capture(async () => printHint(runHint('demo free')))).err).toBe('  hint: run `demo free`\n')
  })
})

describe('lazy commands', () => {
  const calls: string[][] = []
  const summaries: string[] = []
  const hello = {
    summary: async () => {
      summaries.push('hello')

      return 'says hello'
    },
    run: async (args: string[]) => {
      console.log(`hello ${args.join(' ')}`)

      return 0
    },
  }
  const lazy = {
    ...cli,
    extraCommands: async (words: string[]) => {
      calls.push(words)

      return { hello, echo: { summary: 'shadowed', run: async () => 9 } }
    },
  }

  test('is not called to run a command the CLI has, and never awaits a summary for a run', async () => {
    calls.length = 0
    summaries.length = 0

    const throwing = { ...lazy, commands: { ...cli.commands, hello: { summary: async () => Promise.reject(new Error('read the module')), run: async () => 0 } } }

    expect(await capture(async () => runCli(throwing, ['echo', 'a']))).toEqual({ result: 0, out: 'a\n', err: '' })
    expect((await capture(async () => runCli(throwing, ['hello']))).result).toBe(0)
    expect(calls).toEqual([])
    expect(summaries).toEqual([])
  })

  test('is called with the words typed for a word it does not know, and runs what it gives', async () => {
    calls.length = 0
    summaries.length = 0

    expect(await capture(async () => runCli(lazy, ['hello', 'world']))).toEqual({ result: 0, out: 'hello world\n', err: '' })
    expect(calls).toEqual([['hello', 'world']])
    expect(summaries).toEqual([])
    expect((await capture(async () => runCli(lazy, ['nope']))).err).toBe('error: demo: no command nope\n  hint: run demo --help for its commands\n')
  })

  test('is called for a help and awaits the summaries it lists, the CLI\'s own commands winning a shared name', async () => {
    calls.length = 0
    summaries.length = 0

    const { out } = await capture(async () => runCli(lazy, ['--help']))

    expect(out).toContain('  hello  says hello\n')
    expect(out).toContain('  echo   prints its arguments\n')
    expect(calls).toEqual([['--help']])
    expect(summaries).toEqual(['hello'])
  })

  test('is called for __complete, to list and to complete a word it gives', async () => {
    calls.length = 0

    expect((await capture(async () => runCli(lazy, ['__complete', '']))).out).toBe('echo\tprints its arguments\nboom\tfails\nplan\ta group\nhello\tsays hello\n')
    expect(calls).toEqual([['']])

    const parsing = { ...cli, commands: async () => ({ port: { summary: 'parses first', run: async (args: string[]) => {
      parse(args, 'port', { max: { type: 'string', description: 'highest port' } })

      return 0
    } } }) }

    expect((await capture(async () => runCli(parsing, ['__complete', 'port', '--']))).out).toContain('--max\thighest port\n')
  })

  test('may be the only source of commands, as a function in place of the record', async () => {
    const only = { ...cli, commands: async () => ({ hello }) }

    expect((await capture(async () => runCli(only, ['hello', 'x']))).out).toBe('hello x\n')
    expect((await capture(async () => runCli(only, []))).out).toContain('  hello  says hello\n')
  })

  test('works the same in a group, called with the words from the CLI\'s name on', async () => {
    const seen: string[][] = []
    const grouped = { ...cli, commands: { team: { summary: async () => 'lazy group', commands: { list: cli.commands.echo }, extraCommands: async (words: string[]) => {
      seen.push(words)

      return { hello }
    } } } }

    expect((await capture(async () => runCli(grouped, ['team', 'list', 'a']))).out).toBe('a\n')
    expect(seen).toEqual([])
    expect((await capture(async () => runCli(grouped, ['team', 'hello', 'b']))).out).toBe('hello b\n')
    expect(seen).toEqual([['team', 'hello', 'b']])

    const help = (await capture(async () => runCli(grouped, ['team', '--help']))).out

    expect(help).toContain('demo team  lazy group')
    expect(help).toContain('  hello  says hello\n')
    expect((await capture(async () => runCli(grouped, ['__complete', 'team', '']))).out).toBe('list\tprints its arguments\nhello\tsays hello\n')
  })
})

describe('packageVersion', () => {
  const temp = tempDirs()

  test('is the version of the nearest package.json above the entry file, through a link', () => {
    const dir = temp('version-')

    mkdirSync(join(dir, 'dist'))
    writeFileSync(join(dir, 'package.json'), '{"name":"x","version":"9.8.7"}')
    writeFileSync(join(dir, 'dist', 'cli.js'), '')
    symlinkSync(join(dir, 'dist', 'cli.js'), join(dir, 'link.js'))

    expect(packageVersion(join(dir, 'dist', 'cli.js'))).toBe('9.8.7')
    expect(packageVersion(join(dir, 'link.js'))).toBe('9.8.7')
  })

  test('skips a package.json without a version', () => {
    const dir = temp('version-')

    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'package.json'), '{"version":"1.2.3"}')
    writeFileSync(join(dir, 'src', 'package.json'), '{"type":"module"}')
    writeFileSync(join(dir, 'src', 'cli.ts'), '')

    expect(packageVersion(join(dir, 'src', 'cli.ts'))).toBe('1.2.3')
  })

  test('runMain and runCli print it when no version is given', async () => {
    expect((await capture(async () => runMain({ name: 'demo', run: async () => 0 }, ['--version']))).out).toBe(`${packageVersion()}\n`)
    expect((await capture(async () => runCli({ name: 'demo', about: 'x', commands: {} }, ['--version']))).out).toBe(`${packageVersion()}\n`)
  })
})
