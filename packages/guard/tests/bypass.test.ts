import type { Context } from '../src/check'
import type { HookInput, Machine } from '../src/hook'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { checkCommand, checkPath } from '../src/check'
import { asksForPush, hook } from '../src/hook'

const REPO = '/work/repo'

function context(files: Record<string, string> = {}, settings: Partial<Context> = {}): Context {
  return {
    cwd: REPO,
    home: '/home/me',
    isPushAsked: false,
    canRewrite: false,
    canWrap: false,
    canSub: true,
    read: path => files[path] ?? null,
    exists: path => path in files,
    ...settings,
  }
}

async function rules(command: string, files: Record<string, string> = {}, settings: Partial<Context> = {}): Promise<string[]> {
  return (await checkCommand(command, context(files, settings))).violations.map(violation => violation.rule)
}

function cases(rule: string, refused: string[], allowed: string[], files: Record<string, string> = {}, settings: Partial<Context> = {}) {
  for (const command of refused) {
    test(`refuses ${JSON.stringify(command)}`, async () => {
      expect(await rules(command, files, settings)).toContain(rule)
    })
  }

  for (const command of allowed) {
    test(`lets ${JSON.stringify(command)} through`, async () => {
      expect(await rules(command, files, settings)).toEqual([])
    })
  }
}

describe('compound commands and wrappers', () => {
  cases('git', [
    'if true; then git stash; fi',
    'for f in a b; do git stash; done',
    'while true; do git stash; done',
    '! git stash',
    '{ git stash; }',
    'case x in a) git stash;; esac',
    'bash -c \'git stash\'',
    'bash -lc "git stash"',
    'sh -c "echo a; git stash"',
    'docker exec db sh -c "git stash"',
    'su -c "git stash"',
    'eval git stash',
    'eval "git" "stash"',
    'echo a | xargs git stash',
    'xargs -n1 -I{} git stash',
    'find . -exec git stash \\;',
    'find . -name x -execdir git stash {} +',
    'timeout 5 git stash',
    'timeout -k 1 5 git stash',
    'nice git stash',
    'nice -n 5 git stash',
    'ionice -c 3 git stash',
    'setsid git stash',
    'stdbuf -oL git stash',
    'doas git stash',
    'chroot /srv git stash',
    'busybox git stash',
    'exec -a x git stash',
    'sudo -u root git stash',
    'sudo -g wheel -E git stash',
    'sudo -- git stash',
    'env -u X git stash',
    'env -C /tmp git stash',
    'env -S "git stash"',
    'bash <<EOF\ngit stash\nEOF',
    'sh <<< "git stash"',
    'sh <<<"git stash"',
    'echo "git stash" | sh',
    'printf \'%s\\n\' "git stash" | bash',
    'diff <(git stash) x',
    'echo $(echo $(git stash))',
  ], [
    'echo git stash',
    'echo "if true; then git stash; fi"',
    'bash script.sh',
    'bash script.sh <<EOF\ngit stash\nEOF',
    'git log | xargs echo',
    'timeout 5 git log',
    'sudo -u root git status',
    'cat <<\'EOF\' | cat\ngit stash\nEOF',
    'find . -name "*.ts" -exec echo {} \\;',
    'env FOO=1 bun test',
    'if true; then git status; fi',
  ])

  cases('git', ['if true; then git push; fi', '! git push', 'bash -c \'git push\'', 'xargs git push', 'timeout 5 git push', 'nice git push', 'sudo -u root git push', 'env -u X git push'], [])

  cases('git', ['git push'], [], {}, { isPushAsked: false })

  test('lets a wrapped push through once asked', async () => {
    expect(await rules('timeout 5 git push origin main', {}, { isPushAsked: true })).toEqual([])
  })

  cases('remote', ['bash -c "ssh prod"', 'sudo -u deploy ssh prod', 'if true; then ssh prod; fi', 'xargs ssh', 'env -u X ssh prod'], [])

  cases('sql', ['bash -c "psql -c \'DROP TABLE t\'"', 'docker exec db sh -c "psql -c \'DROP TABLE t\'"', 'timeout 5 psql -c "DROP TABLE t"', 'if true; then psql -c "DROP TABLE t"; fi'], [])

  cases('env', ['bash -c "cat .env"', 'timeout 5 cat .env', 'if true; then cat .env; fi', 'sudo -u root cat .env', 'echo .env | xargs cat', 'sh <<< "cat .env"'], [])
})

describe('comments, subshells and quoting', () => {
  cases('git', ['echo a # it\'s\ngit stash', 'echo a # it\'s\nechoed\ngit stash', 'echo $\'a\\\'b\'; git stash', 'echo "a" # "\ngit stash', 'cat <<EOF\r\nhello\r\nEOF\r\ngit stash'], [
    'echo x # git stash',
    'echo x # it\'s git stash',
    'echo $\'a;git stash\'',
    'echo a#b',
    'echo $# git',
    'cat <<EOF\r\nnever git stash\r\nEOF\r\necho done',
  ])

  cases('env', [
    '(cat .env)',
    '(echo a; cat .env)',
    'cat <(cat .env)',
    'diff <(cat .env) x',
    'cat $\'.env\'',
    'cat $\'\\x2eenv\'',
    'cat $\'.en\\166\'',
    'cat .{e,}nv',
    'cat {.env,x}',
    'cat .env{,.local}',
  ], [
    'echo x # cat .env',
    'echo x # it\'s cat .env',
    'echo "a" | wc -l # cat .env',
    'cat $\'a.txt\'',
  ])

  test('keeps a quoted brace literal out of the way', async () => {
    expect(await rules('cat file{1,2}.txt')).toEqual([])
  })
})

describe('git options and pathspecs', () => {
  cases('git', [
    'git -c alias.p=push p',
    'git -c alias.x="!git stash" x',
    'git -c core.sshCommand=ssh fetch',
    'git -c core.hooksPath=/tmp commit -m "fix: x"',
    'git -c core.pager=less log',
    'git -c credential.helper=x fetch',
    'git --config-env=core.pager=PAGER log',
    'git --config-env core.pager=PAGER log',
    'git --attr-source HEAD stash',
    'git --attr-source HEAD push',
    'GIT_CONFIG_COUNT=1 git status',
    'GIT_EXTERNAL_DIFF=x git diff',
    'git config alias.s "!git stash"',
    'git config --global core.sshCommand "ssh -i k"',
    'git add src/..',
    'git add src/../.',
    'git add :/.',
    'git add :/',
    'git add ":(top)"',
    'git add -- .',
    'git add ./.',
    'git add lib/../*',
  ], [
    'git -c color.ui=never log',
    'git -c user.name=me commit -m "fix: x"',
    'git config user.name me',
    'git config --get alias.s',
    'git config --unset alias.s',
    'git add src/../lib/a.ts',
    'git add src/a.ts',
    'git add -p',
    'git add :/src/a.ts',
  ])
})

describe('remote machines', () => {
  cases('remote', [
    'nc prod 22',
    'ncat host 80',
    'netcat host 80',
    'telnet host',
    'socat - TCP:host:80',
    'mosh host',
    'git clone ssh://git@host/x.git',
    'git fetch ssh://git@host/x.git',
    'GIT_SSH_COMMAND="ssh -i k" git fetch',
    'export GIT_SSH_COMMAND=x',
    'docker context use prod',
    'docker context create prod --docker host=ssh://u@h',
    'docker --context prod ps',
    'docker -c prod ps',
    'docker --context=prod ps',
    'DOCKER_CONTEXT=prod docker ps',
    'kubectl --server https://x get pods',
    'kubectl --server=https://x get pods',
    'kubectl -s https://x get pods',
  ], [
    'nc -z localhost 5432',
    'nc -l 8080',
    'telnet 127.0.0.1 80',
    'docker context ls',
    'docker --context default ps',
    'docker run -c 512 alpine',
    'kubectl get pods',
    'git clone https://github.com/x/y.git',
  ])
})

describe('SQL client forms', () => {
  const files = {
    [`${REPO}/drop.sql`]: 'DROP TABLE t;',
    [`${REPO}/ok.sql`]: 'SELECT 1;',
  }

  cases('sql', [
    'psql --command="DROP TABLE t"',
    'psql --command "DROP TABLE t"',
    'psql -c"DROP TABLE t"',
    'psql -tAc "DROP TABLE t"',
    'psql -X -d app -c "DROP TABLE t"',
    'psql --file=drop.sql',
    'psql --file drop.sql',
    'psql -fdrop.sql',
    'psql -f drop.sql',
    'psql < drop.sql',
    'psql <drop.sql',
    'cat drop.sql | psql',
    'psql <<< "DROP TABLE t"',
    'psql <<<"DROP TABLE t"',
    'echo "DROP TABLE t" | psql',
    'psql <<EOF\nDROP TABLE t;\nEOF',
    'sh -c "psql -c \'DROP TABLE t\'"',
    'docker compose exec db sh -c "psql -c \'DROP TABLE t\'"',
    'mysql -e "DROP TABLE t"',
    'mysql --execute="DROP TABLE t"',
    'mysql -psecret -e "DROP TABLE t"',
    'mysql -uroot -e"DROP TABLE t"',
    'sqlite3 db.sqlite "DROP TABLE t"',
    'sqlite3 db.sqlite -cmd "DROP TABLE t"',
    'psql -c \'drop table t\' # test',
    'psql -c "drop table test_t"',
    'psql -d prod -c "drop table t" --set=note=test',
    'psql -f missing.sql',
    'psql -f /dev/zero',
    'psql --file=/dev/zero',
    'psql < /dev/zero',
    'PGDATABASE=prod_test psql -d prod -c "drop table t"',
    'psql "host=h dbname=prod user=test" -c "delete from t"',
    'psql -d prod test_user -c "drop table t"',
    'mysql -e "drop database prod" test_db',
    'mysql -D app_test -e "insert into prod.t values (1)"',
    'mysql -D app_test -e "use prod; delete from t"',
    'psql -d app_test -c "drop database app"',
    'psql "dbname=app_test dbname=prod" -c "delete from t"',
    'psql "user=\'a dbname=x_test\' dbname=prod" -c "delete from t"',
    'psql "postgres://h/app_test?dbname=prod" -c "delete from t"',
    'APP_ENV=test psql -d prod -c "delete from t"',
    'APP_ENV=test psql "user=a\'b dbname=prod" -c "delete from t"',
    'APP_ENV=test psql "dbname=app_test user=\'unterminated" -c "delete from t"',
    'psql "postgres://h/app_test?%64bname=prod" -c "delete from t"',
    'psql "postgres://h/app_test#?dbname=prod" -c "delete from t"',
    'APP_ENV=test mycli "mysql://h/prod#app_test" -e "delete from t"',
  ], [
    'psql -c "SELECT 1"',
    'psql -tAc "SELECT 1"',
    'psql -f ok.sql',
    'psql -f - <<EOF\nSELECT 1\nEOF',
    'psql -f /dev/stdin <<EOF\nSELECT 1\nEOF',
    'sqlite3 db.sqlite "SELECT 1"',
    'mysql -e "SELECT 1"',
    'psql -d app_test -c "DROP TABLE t"',
    'psql app_test -c "DROP TABLE t"',
    'psql --dbname=app_test --command="DROP TABLE t"',
    'psql postgres://u@h/app_test -c "DROP TABLE t"',
    'PGDATABASE=app_test psql -c "DROP TABLE t"',
    'mysql -D app_test -e "DROP TABLE t"',
    'docker compose -f compose.test.yaml exec db psql -c "DROP TABLE t"',
    'psql "host=h dbname=app_test user=u" -c "delete from t"',
    'psql "host=h dbname=\'app test\'" -c "delete from t"',
    'psql "dbname=prod dbname=app_test" -c "delete from t"',
    'psql "postgres://h/prod?sslmode=require&dbname=app%5Ftest" -c "delete from t"',
    'psql "host=h user=a\'b dbname=app_test" -c "delete from t"',
    'psql "dbname=app_test user=a\\\\" -c "delete from t"',
    'psql "postgres://h/prod?%64bname=app_test" -c "delete from t"',
    'psql "postgres://h/app_test#x" -c "delete from t"',
    'psql -d app_test -c "insert into public.t values (1)"',
    'mysql -D app_test -e "select * from prod.t"',
    'mysql -D app_test -e "drop database app_test"',
  ], files)

  test('refuses the psql forms from the audit with the hand-over message', async () => {
    const { violations } = await checkCommand('psql -f /dev/zero', context(files))

    expect(violations[0]?.message).toContain('cannot be read')
  })
})

describe('env reads', () => {
  cases('env', [
    'cat .en?',
    'cat .e*',
    'cat .[e]nv',
    'cat .env.*',
    'x=.env; cat $x',
    'x=.env\ncat "$x"',
    // eslint-disable-next-line no-template-curly-in-string -- the shell's own braces
    'export f=.env; cat ${f}',
    // eslint-disable-next-line no-template-curly-in-string -- the shell's own braces
    'x=.en; cat ${x}v',
    'for f in .env .env.local; do cat $f; done',
    'bun -e "console.log(require(\'fs\').readFileSync(\'.env\', \'utf8\'))"',
    'python3 -c "print(open(\'.env\').read())"',
    'python3 -c "import os; print(dict(os.environ))"',
    'perl -e \'open F, ".env"; print <F>\'',
    'grep -r SECRET .',
    'grep -rn SECRET',
    'grep -R KEY ..',
    'grep -e KEY -r .',
    'rg --hidden KEY',
    'rg -uu KEY .',
    'env',
    'env -i',
    'printenv',
    'export -p',
    'export',
    'declare -x',
    'set',
    'cat /proc/self/environ',
    'cat .envrc',
    'source .envrc',
    'bash -c "env"',
    'docker exec c sh -c "printenv"',
  ], [
    'ls .e*',
    'cat file.txt',
    'x=a.txt; cat $x',
    'for f in a b; do cat $f; done',
    'bun -e "console.log(1)"',
    'bun -e "console.log(process.env.HOME)"',
    'python3 -c "import os; print(os.environ[\'HOME\'], os.environ.get(\'X\'))"',
    'python3 script.py',
    'bun --env-file=.env.test test',
    'grep -r foo src',
    'grep -rn foo src/ lib/',
    'grep -r KEY . --include=*.ts',
    'grep -r KEY . --exclude=.env*',
    'grep KEY file.txt',
    'rg KEY',
    'rg --hidden KEY . -g \'!.env*\'',
    'printenv HOME',
    'env FOO=1 bun test',
    'export FOO=1',
    'set -e',
    'declare -a list',
    'printenv | ev redact',
    'env | ev redact',
    'cat .env.example',
    'git diff',
    'git log -p',
    'grep ".*" notes.md',
  ])

  cases('env', ['git diff', 'git --attr-source HEAD diff', 'git --config-env core.pager=P show HEAD', 'git diff HEAD~1', 'git show HEAD', 'git log -p', 'git log --patch -3', 'git grep KEY', 'git format-patch -1'], [
    'git diff --stat',
    'git diff --name-only',
    'git log --oneline',
    'git show --stat HEAD',
    'git diff -- . \':!.env\'',
    'git grep KEY -- \':(exclude).env\'',
    'git status',
  ], {}, { hasTrackedEnv: true })

  test('checks the paths of the file tools, globs included', () => {
    for (const path of ['.envrc', '.e*', '.en?', '.{e,}nv', '**/.env.*', 'api/.env']) {
      expect(checkPath(path)?.rule).toBe('env')
    }

    for (const path of ['.env.example', 'src/index.ts', '*.ts', '.gitignore']) {
      expect(checkPath(path)).toBeNull()
    }
  })
})

describe('commit messages the guard cannot read', () => {
  cases('commit', [
    'git commit -m "$MSG"',
    'git commit -m "fix: x" -m "$BODY"',
    'git commit -m "$(date)"',
    'git commit -F missing.txt',
    'git commit -F -',
    'echo "fix: x" | git commit -F -',
    'echo wip | git commit -F /dev/stdin',
    'echo wip | git commit -F /dev/fd/0',
    'git commit -F /dev/stdin',
  ], [
    'git commit --amend --no-edit',
    'git commit -m "fix: x"',
    'git commit -F good.txt',
  ], { [`${REPO}/good.txt`]: 'fix: x\n' })
})

describe('a rule that throws', () => {
  test('refuses the command and reports it', async () => {
    const seen: string[] = []
    const verdict = await checkCommand('psql -f x.sql', context({}, {
      read: () => {
        throw new Error('disk gone')
      },
      onError: (rule, _error, command) => seen.push(`${rule}:${command}`),
    }))

    expect(verdict.violations.map(each => each.rule)).toEqual(['sql'])
    expect(verdict.violations[0]?.message).toContain('disk gone')
    expect(seen).toEqual(['sql:psql -f x.sql'])
  })
})

function machine(files: Record<string, string> = {}, settings: Partial<Machine> = {}): Machine & { ran: string[][], logged: string[] } {
  const ran: string[][] = []
  const logged: string[] = []

  return {
    home: '/home/me',
    stateDir: '/state',
    has: () => true,
    run: async (argv) => {
      ran.push(argv)

      return Promise.resolve({ code: 0, text: '' })
    },
    read: path => files[path] ?? null,
    exists: path => path in files,
    write: (path, text) => {
      files[path] = text
    },
    remove: (path) => {
      delete files[path]
    },
    log: text => logged.push(text),
    ...settings,
    ran,
    logged,
  }
}

function tool(name: string, input: Record<string, unknown>): HookInput {
  return { session_id: 'abc-123', cwd: REPO, tool_name: name, tool_input: input }
}

function denies(reply: Awaited<ReturnType<typeof hook>>): boolean {
  return reply?.hookSpecificOutput.permissionDecision === 'deny'
}

describe('hook', () => {
  test('refuses any pkg check exit but 0', async () => {
    for (const code of [1, 2, 124, 137]) {
      const reply = await hook('pre-tool-use', tool('Bash', { command: 'bun add left-pad' }), machine({}, { run: async () => Promise.resolve({ code, text: 'boom' }) }))

      expect(denies(reply)).toBe(true)
      expect(reply?.hookSpecificOutput.permissionDecisionReason).toContain('boom')
    }

    expect(await hook('pre-tool-use', tool('Bash', { command: 'bun add left-pad' }), machine())).toBeNull()
  })

  test('refuses the file tools reaching an env file', async () => {
    const refused: [string, Record<string, unknown>][] = [
      ['Read', { file_path: '/work/repo/.env' }],
      ['MultiEdit', { file_path: '/work/repo/.env', edits: [] }],
      ['NotebookEdit', { notebook_path: '/work/repo/.envrc', new_source: '' }],
      ['Grep', { pattern: 'KEY', path: '/work/repo/.env' }],
      ['Grep', { pattern: 'KEY', glob: '.env*' }],
      ['Grep', { pattern: 'KEY', glob: '**/.env.*' }],
      ['Glob', { pattern: '*', path: '/work/repo/.env' }],
    ]

    for (const [name, input] of refused)
      expect(denies(await hook('pre-tool-use', tool(name, input), machine()))).toBe(true)

    for (const [name, input] of [['Grep', { pattern: 'KEY', path: '/work/repo/src', glob: '*.ts' }], ['Glob', { pattern: '**/*.ts' }], ['NotebookEdit', { notebook_path: '/work/repo/a.ipynb' }], ['Task', { prompt: 'x' }]] as const)
      expect(await hook('pre-tool-use', tool(name, input), machine())).toBeNull()
  })

  test('logs a rule that crashed and refuses the call', async () => {
    const made = machine({}, { read: () => {
      throw new Error('disk gone')
    } })
    const reply = await hook('pre-tool-use', tool('Bash', { command: 'psql -f x.sql' }), made)

    expect(denies(reply)).toBe(true)
    expect(made.logged.join('')).toContain('disk gone')
    expect(made.logged.join('')).toContain('psql -f x.sql')
  })

  test('asks git for a tracked env file only when a command prints what git tracks', async () => {
    const made = machine()

    await hook('pre-tool-use', tool('Bash', { command: 'ls' }), made)
    expect(made.ran).toEqual([])

    await hook('pre-tool-use', tool('Bash', { command: 'git diff' }), made)
    expect(made.ran[0]?.slice(0, 3)).toEqual(['git', 'ls-files', '-z'])
  })

  test('refuses a patch once git lists a tracked env file', async () => {
    const tracked = machine({}, { run: async () => Promise.resolve({ code: 0, text: 'api/.env\0' }) })

    expect(denies(await hook('pre-tool-use', tool('Bash', { command: 'git diff' }), tracked))).toBe(true)
    expect(denies(await hook('pre-tool-use', tool('Bash', { command: 'git diff --stat' }), tracked))).toBe(false)
  })
})

describe('the push grant', () => {
  test('needs an affirmative request', () => {
    for (const prompt of ['push it', 'Commit and push.', 'please push to origin', 'can you push?', 'git push', 'pousse', 'tu peux pousser', 'fix it, then push']) {
      expect(asksForPush(prompt)).toBe(true)
    }

    for (const prompt of ['don\'t push', 'do not push yet', 'never push', 'it was pushed earlier', 'did you push?', 'pushing is not allowed', 'no push', 'ne pousse pas', 'fix the push notification bug', 'commit, but don\'t push', 'without pushing', 'it is already pushed', 'fix it']) {
      expect(asksForPush(prompt)).toBe(false)
    }
  })

  test('is remembered per session by the prompt hook', async () => {
    const files: Record<string, string> = {}
    const made = machine(files)

    await hook('user-prompt-submit', { session_id: 'abc-123', prompt: 'don\'t push' }, made)
    expect(Object.keys(files)).toEqual([])

    await hook('user-prompt-submit', { session_id: 'abc-123', prompt: 'commit and push' }, made)
    expect(Object.keys(files)).toEqual(['/state/push-asked/abc-123'])

    await hook('user-prompt-submit', { session_id: 'abc-123', prompt: 'thanks' }, made)
    expect(Object.keys(files)).toEqual([])
  })
})

describe('the plugin hooks', () => {
  const plugin = JSON.parse(readFileSync(join(import.meta.dir, '../../../plugin/hooks/hooks.json'), 'utf8')) as { hooks: Record<string, { matcher?: string, hooks: { command: string }[] }[]> }

  test('matches every tool guard answers for', () => {
    const matcher = plugin.hooks.PreToolUse?.[0]?.matcher ?? ''

    for (const name of ['Bash', 'Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Grep', 'Glob'])
      expect(matcher.split('|')).toContain(name)
  })

  test('resolves guard by path, not through PATH', () => {
    for (const entries of Object.values(plugin.hooks)) {
      for (const entry of entries)
        expect(entry.hooks[0]?.command).toContain('/bin/guard" hook')
    }
  })
})

describe('spellings that must be refused like their plain form', () => {
  const pinned = { '/work/repo/bun.lock': '' }

  cases('commit', ['git commit -m"fix x y"', 'git commit -qm"wip is here"', 'git commit -F /dev/stdin <<EOF\nwip\nEOF', 'git commit -F /dev/fd/0 <<EOF\nwip\nEOF'], ['git commit -F /dev/stdin <<EOF\nfeat: x\nEOF'])
  cases('git', ['git commit -am"feat: x y"', 'git commit -a -m"feat: x"', 'git commit -am "feat: x"'], [])
  cases('git', ['fish -c \'git push\'', 'csh -c "git push"', 'tcsh -c "git push"', 'nu -c "git push"', 'pwsh -c "git push"', 'pwsh -Command "git push"'], ['fish -c \'git status\''])
  cases('git', ['echo $((1<<2))\ngit push', 'echo $((1<<2)) && git push'], [])
  cases('git', ['f() { git stash; }; f', 'function f { git stash; }; f', 'function f\n{\n git stash\n}\nf', 'f () ( git stash )'], ['f() { git status; }; f'])
  cases('git', ['watch git stash', 'watch -n 5 git stash', 'flock /tmp/l git stash', 'flock -w 5 /tmp/l git stash', 'parallel git stash', 'unbuffer git stash', 'systemd-run --user git stash', 'systemd-run -p Nice=5 git stash'], ['watch git status', 'flock /tmp/l git log'])
  cases('remote', ['git clone user@host:repo', 'git clone git@example.com:a/b.git', 'git fetch user@host:repo', 'git ls-remote example.com:a/b'], ['git clone ./repo', 'git clone /srv/repo', 'git clone https://example.com/a/b.git'])
  cases('package-manager', ['bash -c \'npm i x\'', 'echo $(npm i x)', 'echo x | xargs npm i', 'fish -c "npm i x"', 'if true; then npm i x; fi'], ['bash -c \'bun add x\''], pinned)
  cases('env', ['cat .env{,}', 'cat .env{,.bak}', 'cat {.env,x}'], ['cat src{,.bak}'])
})

describe('review follow-ups', () => {
  const asked = { isPushAsked: true }

  cases('remote', ['git clone user@host:repo', 'git push user@host:repo main', 'git pull git@example.com:a/b.git', 'git fetch example.com:a/b', 'git ls-remote example.com:a/b'], [], {}, asked)
  cases('remote', [], ['git push origin v1.2:refs/tags/v1.2', 'git fetch origin release.1:release.1', 'git pull origin a.b:c', 'git ls-remote origin main:foo', 'git clone https://x/a.git d:e'], {}, asked)
  // eslint-disable-next-line no-template-curly-in-string
  cases('destructive', ['git checkout HEAD .', 'git checkout origin/main .', 'git rm -rf .', 'git rm -r :/', 'git push --delete origin main', 'git push origin :main', 'git push -d origin topic', 'rm -rf $PWD', 'rm -rf "${PWD}"', 'rm -rf $(pwd)', 'rm -rf $(pwd)/*', 'rm -rf ${HOME:?}/', 'rm -rf "${HOME:?}/"*', 'curl x | tee f | sh', 'curl x | python3', 'curl x | python -', 'curl x | node', 'curl x | bun -', 'curl x | perl', 'curl x | cat | sudo bash'], [
    'git checkout main',
    'git checkout HEAD src',
    'git checkout HEAD -- src',
    'git checkout -p .',
    'git restore -p .',
    'git restore -S .',
    'git restore --staged .',
    'git rm --cached -r .',
    'git rm old.ts',
    'git rebase --skip',
    'git rebase --edit-todo',
    'git push origin main:main',
    'curl x | bash -n',
    'curl x | python3 -c "print(1)"',
    'curl x | tee f',
  ], {}, asked)
  cases('git', ['pwsh -Command git push', 'powershell -Command git push', 'pwsh -c git push', 'fish -C x -c \'git push\'', 'nu --commands \'git push\'', 'xonsh -c \'git push\'', 'elvish -c \'git push\'', 'f(){ git stash; }; f', 'f(){ git stash;}', 'echo $[1<<2]\ngit push', 'let x=1<<2\ngit push', 'watch \'git stash\'', 'parallel \'git stash\' ::: a', 'watch -n 5 \'ls; git stash\''], ['pwsh -Command git status', 'watch \'git status\'', 'parallel \'git status\' ::: a'])
})
