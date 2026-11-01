import { describe, expect, test } from 'bun:test'
import { badUsage, fail, parse, runCli, runMain } from '../src'
import { capture } from '../src/test'

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
    expect((await capture(async () => runCli(cli, []))).out).toBe('demo 1.2.3  a demo\n\nUsage: demo <command> [options]\n\nCommands:\n  echo  prints its arguments\n  boom  fails\n  plan  a group\n\nRun demo <command> --help for its options.\n')
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

    expect((await capture(async () => runCli(withDefault, ['--help']))).out).toBe('demo 1.2.3  a demo\n\nUsage: demo [<command>] [options]\n\nCommands:\n  echo  prints its arguments\n  boom  fails\n  plan  a group\n  port  parses first\n\nOptions of port: the command run when none is named\n      --max <value>  highest port\n  -h, --help         show this help\n\nRun demo <command> --help for its options.\n')
    expect(ran).toEqual([])
  })

  test('ends a command on its --help with exit 0, printing the help alone', async () => {
    const helped = { ...cli, commands: { port: { summary: 'parses first', run: async (args: string[]) => {
      parse(args, 'demo port', {})
      console.log('ran')

      return 3
    } } } }

    expect(await capture(async () => runCli(helped, ['port', '--help']))).toEqual({ result: 0, out: 'Usage: demo port\n\nOptions:\n  -h, --help  show this help\n', err: '' })
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
})

describe('__complete', () => {
  const ran: string[] = []
  const parsing = {
    ...cli,
    commands: {
      ...cli.commands,
      port: { summary: 'parses first', run: async (args: string[]) => {
        parse(args, 'port <name>', { max: { type: 'string', description: 'highest port' } })
        ran.push('port')

        return 0
      } },
    },
  }

  test('lists the commands, or a group\'s, with their summaries', async () => {
    expect((await capture(async () => runCli(parsing, ['__complete', '']))).out).toBe('echo\tprints its arguments\nboom\tfails\nplan\ta group\nport\tparses first\n')
    expect((await capture(async () => runCli(parsing, ['__complete', 'plan', 'a']))).out).toBe('add\tadds\nbad\tfails\n')
  })

  test('lists a command\'s options without running it, and asks for paths otherwise', async () => {
    expect((await capture(async () => runCli(parsing, ['__complete', 'port', '--']))).out).toBe('--max\thighest port\n--help\tshow this help\n')
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

    expect((await capture(async () => runMain({ name: 'x', version: '1', run }, ['__complete', '-']))).out).toBe('--only\tsome\n--help\tshow this help\n')
  })
})
