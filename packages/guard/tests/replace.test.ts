import { describe, expect, test } from 'bun:test'
import { replaceViolation } from '../src/replace'

// The command a refusal hands over, null when it gives none.
function suggested(command: string): string | null {
  const message = replaceViolation(command)

  if (message === null)
    return null

  const at = message.indexOf('\nsub ')

  return at === -1 ? 'generic' : message.slice(at + 1)
}

describe('sed -i', () => {
  const translated: [string, string][] = [
    ['sed -i \'s/foo/bar/\' a.ts', 'sub --from foo --to bar a.ts'],
    ['sed -i \'s/foo/bar/g\' a.ts b.ts', 'sub --from foo --to bar --all a.ts b.ts'],
    ['sed -i.bak -e \'s|a/b|c|\' src/*.ts', 'sub --from a/b --to c src/*.ts'],
    ['sed -Ei \'s/v(\\d+)/w\\1/g\' x', 'sub --from \'v(\\d+)\' --to \'w$1\' --regex --all x'],
    ['sed -i \'s/a\\(b\\)\\+/[&]/\' x', 'sub --from \'a(b)+\' --to \'[$&]\' --regex x'],
    ['sed -i \'s/1\\.2/1.3/\' x', 'sub --from 1.2 --to 1.3 x'],
    ['sed -i \'s/it\'\\\'\'s/its/\' x', 'sub --from \'it\'\\\'\'s\' --to its x'],
    ['sed -i -e \'s/a/b/\' -e \'s/c/d/g\' x', 'sub --pairs - x <<\'PAIRS\'\n[{"from":"a","to":"b"},{"from":"c","to":"d","all":true}]\nPAIRS'],
    ['cd x && sed -i \'s/a/&&/\' y', 'sub --from a --to aa y'],
  ]

  for (const [command, sub] of translated) {
    test(`turns ${command} into sub`, () => {
      expect(suggested(command)).toBe(sub)
    })
  }

  test('points what it cannot translate at sub without a command', () => {
    for (const command of ['sed -i \'/x/d\' a', 'sed -i \'3s/a/b/\' a', 'sed -i \'s/a/b/I\' a', 'sed -n -i \'s/a/b/p\' a', 'sed -i -f script.sed a'])
      expect(suggested(command)).toBe('generic')
  })

  test('lets a sed that edits nothing in place through', () => {
    for (const command of ['sed -n \'1,20p\' a.ts', 'sed \'s/a/b/\' a > b', 'grep x a | sed \'s/a/b/\''])
      expect(replaceViolation(command)).toBeNull()
  })
})

describe('replace scripts', () => {
  test('reads a python heredoc asserting its count, its texts in variables', () => {
    const command = 'python3 - <<\'EOF\'\nfrom pathlib import Path\np = Path(\'src/a.ts\')\ns = p.read_text()\nold = """  return a\n"""\nnew = \'  return b\\n\'\nassert s.count(old) == 1\np.write_text(s.replace(old, new))\nEOF'

    expect(suggested(command)).toBe('sub src/a.ts <<\'EOF\'\n<<<<<<< SEARCH\n  return a\n\n=======\n  return b\n\n>>>>>>> REPLACE\nEOF')
    expect(replaceViolation(command)).toStartWith('A python script replacing text')
  })

  test('takes python\'s replace as every match without an asserted count', () => {
    const command = 'python3 -c "import pathlib; p = pathlib.Path(\'a.md\'); p.write_text(p.read_text().replace(\'x\', \'y\').replace(\'z\', \'w\', 2))"'

    expect(suggested(command)).toBe('sub --pairs - a.md <<\'PAIRS\'\n[{"from":"x","to":"y","all":true},{"from":"z","to":"w","count":2}]\nPAIRS')
  })

  test('hands several pairs with the same flags over as SEARCH/REPLACE blocks, a longer fence around a marker line', () => {
    expect(suggested('sed -i -e \'s/a/b/\' -e \'s/c/d/\' x')).toBe('sub x <<\'EOF\'\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nc\n=======\nd\n>>>>>>> REPLACE\nEOF')

    const command = 'python3 - <<\'EOF\'\np = \'a.md\'\ns = open(p).read()\nold = """Title\n=======\n"""\nnew = "T\\n"\nassert s.count(old) == 1\nopen(p, \'w\').write(s.replace(old, new))\nEOF'

    expect(suggested(command)).toContain('<<<<<<<< SEARCH\nTitle\n=======\n\n========\nT\n\n>>>>>>>> REPLACE')
  })

  test('reads a bun -e script, a regex literal included', () => {
    expect(suggested('bun -e "const f=\'a.ts\'; await Bun.write(f, (await Bun.file(f).text()).replace(\'x\', \'y\'))"')).toBe('sub --from x --to y a.ts')
    expect(suggested('bun -e "const t = await Bun.file(\'a.ts\').text(); await Bun.write(\'a.ts\', t.replace(/v\\d+/g, \'v2\'))"')).toBe('sub --from \'v\\d+\' --to v2 --regex --all a.ts')
  })

  test('points a script it cannot read at sub without a command', () => {
    expect(suggested('python3 - <<\'EOF\'\nimport sys\np = sys.argv[1]\ns = open(p).read()\nopen(p, \'w\').write(s.replace(f\'{x}\', \'y\'))\nEOF')).toBe('generic')
  })

  test('lets a script that writes only files it never read through', () => {
    const commands = [
      // eslint-disable-next-line no-template-curly-in-string -- the script's own template string
      'bun -e "const [dir, out] = process.argv.slice(2); const parts = []; for (let i = 1; i <= 4; i++) parts.push(await Bun.file(`${dir}/part${i}.json`).text()); await Bun.write(out, parts.map(s => s.replace(/\\s+/g, \' \')).join())"',
      'bun -e "writeFileSync(\'b.json\', readFileSync(\'a.json\', \'utf8\').replace(\'x\', \'y\'))"',
      'python3 -c "s = open(\'a.txt\').read().replace(\'x\', \'y\'); open(\'b.txt\', \'w\').write(s)"',
    ]

    for (const command of commands)
      expect(replaceViolation(command)).toBeNull()
  })

  test('still refuses a script writing back a file it read, however it names it', () => {
    expect(suggested('bun -e "const p = process.argv[2]; writeFileSync(p, readFileSync(p, \'utf8\').replace(\'a\', \'b\'))"')).toBe('sub --from a --to b <file>')
    expect(suggested('bun -e "for (const f of files) { const t = await Bun.file(f).text(); await Bun.write(f, t.replace(\'a\', \'b\')) }"')).toBe('sub --from a --to b <file>')
    expect(suggested('bun -e "const f = Bun.file(\'a.ts\'); await Bun.write(f, (await f.text()).replace(\'a\', \'b\'))"')).toBe('sub --from a --to b a.ts')
    expect(suggested('python3 -c "from pathlib import Path; import sys; p = sys.argv[1]; Path(p).write_text(Path(p).read_text().replace(\'a\', \'b\'))"')).toBe('sub --from a --to b --all <file>')
    expect(suggested('python3 - <<\'EOF\'\nwith open(\'a.txt\') as fh:\n    s = fh.read()\nwith open(\'a.txt\', mode=\'w\') as fh:\n    fh.write(s.replace(\'x\', \'y\'))\nEOF')).toBe('sub --from x --to y --all a.txt')
  })

  test('hands no sub command when it cannot tell which file a script writes', () => {
    expect(suggested('python3 -c "s = paths[1].read_text().replace(\'a\', \'b\'); paths[0].write_text(s)"')).toBe('generic')
  })

  test('lets a script that writes no file through', () => {
    for (const command of ['python3 -c "print(\'a-b\'.replace(\'-\', \'_\'))"', 'bun -e "console.log(\'a\'.replace(\'a\', \'b\'))"', 'python3 script.py'])
      expect(replaceViolation(command)).toBeNull()
  })
})
