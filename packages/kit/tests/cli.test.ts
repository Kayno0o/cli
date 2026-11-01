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
    expect((await capture(async () => runCli(withDefault, ['--help']))).out).toStartWith('demo 1.2.3')
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
    const run = async (args: string[]) => (parse(args, 'x', { only: { type: 'string', description: 'some' } }) === undefined ? 0 : 0)

    expect((await capture(async () => runMain({ name: 'x', version: '1', run }, ['__complete', '-']))).out).toBe('--only\tsome\n--help\tshow this help\n')
  })
})
