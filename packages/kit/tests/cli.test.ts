import { describe, expect, test } from 'bun:test'
import { fail, runCli, runMain } from '../src'
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
        bad: { summary: 'fails', run: async () => fail('nope') },
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
    expect((await capture(async () => runCli(cli, []))).out).toStartWith('demo 1.2.3: a demo')
  })

  test('names the command an Exit came from and uses its code', async () => {
    expect(await capture(async () => runCli(cli, ['boom']))).toEqual({ result: 4, out: '', err: 'demo boom: it broke\n' })
  })

  test('points a typo at the command meant', async () => {
    expect(await capture(async () => runCli(cli, ['ech']))).toEqual({ result: 2, out: '', err: 'demo: no command ech, did you mean echo?\n' })
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
    expect(await capture(async () => runCli(cli, ['plan', 'bad']))).toEqual({ result: 2, out: '', err: 'demo plan bad: nope\n' })
    expect((await capture(async () => runCli(cli, ['plan', '--help']))).out).toStartWith('demo plan: a group')
    expect((await capture(async () => runCli(cli, ['plan']))).result).toBe(2)
    expect((await capture(async () => runCli(cli, ['plan', 'ad']))).err).toBe('demo plan: no command ad, did you mean add?\n')
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
    expect(await capture(async () => runMain(main(async () => fail('bad input', 2)), []))).toEqual({ result: 2, out: '', err: 'solo: bad input\n' })
    expect(await capture(async () => runMain(main(async () => {
      throw new Error('crash')
    }), []))).toEqual({ result: 1, out: '', err: 'solo: crash\n' })
  })
})
