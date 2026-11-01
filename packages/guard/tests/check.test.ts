import type { Context } from '../src/check'
import { describe, expect, test } from 'bun:test'
import { checkCommand, checkPath } from '../src/check'

const REPO = '/work/repo'

function context(files: Record<string, string> = {}, settings: Partial<Context> = {}): Context {
  return {
    cwd: REPO,
    home: '/home/me',
    isPushAsked: false,
    canRewrite: true,
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

function heredoc(message: string): string {
  return `git commit -m "$(cat <<'EOF'\n${message}\nEOF\n)"`
}

function cases(rule: string, refused: string[], allowed: string[], files: Record<string, string> = {}) {
  for (const command of refused) {
    test(`refuses ${command}`, async () => {
      expect(await rules(command, files)).toContain(rule)
    })
  }

  for (const command of allowed) {
    test(`lets ${command} through`, async () => {
      expect(await rules(command, files)).toEqual([])
    })
  }
}

describe('git', () => {
  cases('git', ['(git stash)', 'command git stash', 'sleep 1 & git stash', 'git \\\n  stash', 'git add -Av', 'git add -fA src', 'git stash pop', 'git -C /tmp/x stash push -m wip', 'git add -A', 'git add .', 'git add -u src', 'git commit -am "fix: wip"', 'git commit --all -m "fix: wip"', 'cd x && git commit -a', 'git push'], ['git log 2>&1 | head', 'cat > notes.md <<\'EOF\'\nnever git add -A\ngit stash\nEOF', 'git stash list', 'git stash show -p', 'git add src/a.ts', 'git commit -m "fix: -a flag"', 'git commit -m "fix: wip" -- a.ts', 'git commit --amend --no-edit'])

  test('points a stash at base', async () => {
    const { violations } = await checkCommand('git stash', context())

    expect(violations[0]?.message).toContain('base -- <cmd>')
  })

  test('lets a push through once asked, tags only atomically', async () => {
    expect(await rules('git push origin main', {}, { isPushAsked: true })).toEqual([])
    expect(await rules('git push --tags', {}, { isPushAsked: true })).toEqual(['git'])
    expect(await rules('git push --atomic --follow-tags origin main', {}, { isPushAsked: true })).toEqual([])
  })
})

describe('remote machines', () => {
  cases('remote', ['ssh prod', 'ssh -p 2222 deploy@staging.example.com uptime', 'scp dump.sql qualif:/tmp', 'rsync -az dist/ recette:/srv/app', 'DOCKER_HOST=ssh://prod docker ps', 'docker -H ssh://prod ps', 'cd x && sftp host'], ['ssh-keygen -t ed25519', 'ssh-add -l', 'rsync -a src/ dist/', 'git fetch origin', 'grep ssh notes.md'])
})

describe('commit messages', () => {
  cases('commit', ['git commit -m "Fixed the band"', heredoc('fix: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>'), 'git commit -s -m "fix: x"', 'git commit -sm "fix: x"', 'git commit -m "fix: x" -m "Generated with Claude Code"', heredoc('fix: x\nand y'), heredoc('fix: x\n\n- one\n- two'), heredoc('fix: x\n\nOne.\nTwo.\nThree.'), heredoc('fix: x\n\nKeep the band visible when the\nprompt grows.'), 'git commit --file=bad.txt', 'git commit -F - <<\'EOF\'\nwip\nEOF'], ['git commit -m "feat(mods): x"', 'git commit -m "feat(api)!: x"', heredoc('fix(band): x\n\nKeeps the band visible.\n\n#5 - deliver every pointer\n#6 - [UC12] Afficher la liste'), heredoc('fix: x\n\nKeeps the band visible.\nDrops the old cache.'), 'git commit -m "Merge branch \'x\'"', 'git commit -C HEAD', 'git commit -m "$TITLE"', 'git commit', heredoc('feat(api)!: drop v1\n\n- one\n- two\n- three'), 'git commit -m "fix: types generated with openapi"', 'git commit -F /dev/stdin', 'git commit -F good.txt', 'git commit -F - <<\'EOF\'\nfix: y\nEOF'], { [`${REPO}/good.txt`]: 'fix: x\n', [`${REPO}/bad.txt`]: 'Fix x\n' })

  test('spells the whole rule out and points at gc', async () => {
    const { violations } = await checkCommand('git commit -m "Fixed the band"', context())

    expect(violations[0]?.message).toContain('The rule: a `type(scope): title` line')
    expect(violations[0]?.message).toContain('`gc \'fix(api): retry a timed-out fetch\'')
    expect((await checkCommand('git commit -am "fix: wip"', context())).violations[0]?.message).toContain('Commit with `gc`')
  })
})

describe('in-place edits', () => {
  cases('edit', ['sed -i \'s/a/b/\' x', 'echo "$(sed -i \'s/a/b/\' x)"', 'python3 - <<\'EOF\'\nfrom pathlib import Path\np = Path(\'x\')\np.write_text(p.read_text().replace(\'a\', \'b\'))\nEOF'], ['sed -n 1p x', 'sub --from a --to b x'])

  test('lets them through where sub is not installed', async () => {
    expect(await rules('sed -i \'s/a/b/\' x', {}, { canSub: false })).toEqual([])
  })
})

describe('SQL', () => {
  const refused = [
    'docker compose exec db psql -U app -c "DELETE FROM users WHERE id = 3"',
    'psql app -c "update users set name = \'x\'"',
    'psql app <<\'EOF\'\nALTER TABLE users ADD COLUMN x int;\nEOF',
    'echo "TRUNCATE logs" | psql app',
    'psql app -f fix.sql',
    'docker compose exec php bin/console doctrine:migrations:migrate -n',
    'php artisan migrate',
    'dropdb app',
    // leaving the shot stack again, or a directory merely named like it, is no shot stack
    'cd ~/w/.worktrees/booki-docker/shot && cd ~/w/booki-docker && docker compose exec db psql -c "DELETE FROM t"',
    'cd ~/w/.worktrees/booki-docker/screenshot && psql app -c "DELETE FROM t"',
    // writes a quote, a DO body or a MySQL version comment would hide
    'psql app -c \'DO $$ BEGIN DELETE FROM t; END $$\'',
    'mysql app -e "SELECT 1 /*!50000 ; DROP TABLE t */"',
    'psql app -c "SET ROLE admin"',
  ]
  const allowed = [
    'docker compose exec db psql -U app -c "SELECT * FROM users WHERE status = \'deleted\'"',
    'psql app -c "SELECT created_at, updated_at FROM t"',
    'psql booki_test -c "DELETE FROM users"',
    'docker compose -f compose.test.yaml exec db psql -c "DROP TABLE x"',
    'docker compose exec php bin/console doctrine:migrations:migrate --env=test',
    'php bin/console doctrine:migrations:status',
    'php bin/console doctrine:fixtures:load -e test -n',
    'psql app -c "select 1" | rg drop',
    'rg -n "insert into" src ; psql --version',
    'psql app -c "select * from t where x = \'update t set y\'"',
    'psql -c \'select * from "grant"\'',
    'pg_restore -l dump.backup',
    // session settings, exports and names that look like keywords
    'psql app -c "SET search_path TO app; SELECT * FROM t"',
    'psql app -c \'\\copy t to x.csv\'',
    'mysql app -e "SELECT `drop` FROM t"',
    // the disposable shot stack git-diff captures on: its directory, compose project or container
    'cd ~/w/.worktrees/booki-docker/shot && docker compose exec -T igesa-db psql -U booki booki -c "UPDATE booking SET x = 1"',
    'docker compose --project-directory ~/w/.worktrees/booki-docker/shot exec db psql -c "DELETE FROM t"',
    'docker exec booki-docker--shot-igesa-db-1 psql -U booki -c "DELETE FROM t"',
  ]

  cases('sql', refused, allowed, { [`${REPO}/fix.sql`]: 'INSERT INTO t VALUES (1);' })
})

describe('env files', () => {
  cases('env', ['cat .env', 'grep TOKEN .env.local', 'cat <<EOF\nmentions .env\nEOF\ncat .env'], ['ev list', 'cat .env.example', 'cat > notes.md <<\'EOF\'\nnever cat .env\nEOF'])

  test('refuses a file tool opening one, not a template', () => {
    expect(checkPath('/repo/apps/api/.env.production')?.rule).toBe('env')
    expect(checkPath('/repo/.env.example')).toBeNull()
  })
})

describe('package managers', () => {
  const pnpm = { [`${REPO}/pnpm-lock.yaml`]: '' }

  test('rewrites an install to the pinned manager, saying why', async () => {
    const verdict = await checkCommand('npm i -D vitest && npm test', context(pnpm))

    expect(verdict.violations).toEqual([])
    expect(verdict.command).toBe('pnpm add --save-dev vitest && npm test')
    expect(verdict.notes.join('')).toContain('pinned to pnpm')
    expect(verdict.packages).toEqual(['vitest'])
  })

  test('refuses the install with its translation when the caller cannot rewrite', async () => {
    const verdict = await checkCommand('npm i -D vitest', context(pnpm, { canRewrite: false, canWrap: true }))

    expect(verdict.violations).toEqual([{ rule: 'package-manager', message: expect.stringContaining('Run `pnpm add --save-dev vitest` instead.') }])
    expect(verdict.command).toBe('npm i -D vitest')
  })

  test('the lockfile nearest to the directory a cd reaches decides', async () => {
    expect((await checkCommand('cd client && npm uninstall left-pad', context({ ...pnpm, [`${REPO}/client/yarn.lock`]: '' }))).command).toBe('cd client && yarn remove left-pad')
  })

  test('refuses what it cannot translate, keeping the command as given', async () => {
    for (const command of ['pnpm --filter=web add zod', 'npm install --legacy-peer-deps']) {
      const verdict = await checkCommand(command, context(command.startsWith('npm') ? pnpm : { [`${REPO}/package-lock.json`]: '' }))

      expect(verdict.violations.map(violation => violation.rule)).toEqual(['package-manager'])
      expect(verdict.command).toBe(command)
    }
  })

  test('turns a clean install into a frozen one', async () => {
    expect((await checkCommand('CI=1 npm ci', context({ [`${REPO}/bun.lock`]: '' }))).command).toBe('CI=1 bun install --frozen-lockfile')
  })

  test('installs with the pinned manager on a bare yarn', async () => {
    expect((await checkCommand('yarn', context({ [`${REPO}/bun.lock`]: '' }))).command).toBe('bun install')
  })

  test('refuses a flag that may aim the install elsewhere', async () => {
    for (const command of ['pnpm -w add zod', 'sudo pnpm add zod'])
      expect(await rules(command, { [`${REPO}/package-lock.json`]: '' })).toEqual(['package-manager'])

    expect(await rules('bun --cwd client add zod', { [`${REPO}/client/pnpm-lock.yaml`]: '' })).toEqual(['package-manager'])
  })

  test('refuses a third manager beside two lockfiles', async () => {
    expect(await rules('npm install', { ...pnpm, [`${REPO}/bun.lock`]: '' })).toEqual(['package-manager'])
  })

  for (const [command, files] of [['pnpm add zod', pnpm], ['bun test && yarn lint', pnpm], ['npm install', {}]] as const) {
    test(`runs ${command} as typed`, async () => {
      const verdict = await checkCommand(command, context(files))

      expect(verdict.violations).toEqual([])
      expect(verdict.command).toBe(command)
    })
  }

  test('leaves an install written in a heredoc as typed', async () => {
    const command = 'cat > README.md <<\'EOF\'\nnpm install foo\nEOF'

    expect((await checkCommand(command, context(pnpm))).command).toBe(command)
  })
})

describe('substitutions', () => {
  cases('remote', ['echo $(ssh prod uptime)', 'echo "up: `ssh prod uptime`"', 'echo $(ssh h $(echo a))', 'echo $(echo $(ssh h))', 'echo $(ssh h; echo $(id))'], ['echo \'$(ssh prod uptime)\''])
  cases('git', ['cat <<EOF\n$(git stash)\nEOF', 'x=`git stash`'], ['cat <<\'EOF\'\n$(git stash)\nEOF'])
  cases('sql', ['echo "$(psql app -c \'DELETE FROM t\')"', 'echo $(psql app -c \'DELETE FROM t\')'], [])
})

describe('the bin', () => {
  test('hands a hook its verdict as JSON, exiting 1 on a broken rule', async () => {
    const run = Bun.spawn(['bun', `${import.meta.dir}/../src/cli.ts`, 'check', '--json', '--no-wrap', '--cwd', import.meta.dir, '-'], { stdin: new TextEncoder().encode('git stash'), stdout: 'pipe' })
    const verdict = JSON.parse(await new Response(run.stdout).text()) as Record<string, unknown>

    expect(await run.exited).toBe(1)
    expect(Object.keys(verdict).sort()).toEqual(['command', 'notes', 'packages', 'violations'])
    expect(verdict.violations).toEqual([expect.objectContaining({ rule: 'git' })])
  })
})

describe('refusals name the command that resolves them', () => {
  test.each([
    ['git stash', 'base -- <cmd>'],
    ['git add -A', 'gc \''],
    ['git commit -am x', 'gc \''],
    ['git push --tags', 'git push --atomic origin <branch> <tag>'],
    ['sed -i s/a/b/ f.ts', 'sub --from'],
    ['cat .env', 'ev list'],
  ])('%s', async (command, route) => {
    const [violation] = (await checkCommand(command, context({}, { isPushAsked: true }))).violations

    expect(violation?.message).toContain(route)
  })
})

describe('out', () => {
  test('routes a noisy command through out once it is installed', async () => {
    expect((await checkCommand('bun run lint', context({}, { canWrap: true }))).command).toBe('out -- bun run lint')
    expect((await checkCommand('bun run lint', context())).command).toBe('bun run lint')
  })

  test('leaves a refused command as given', async () => {
    expect((await checkCommand('bun run lint && git stash', context({}, { canWrap: true }))).command).toBe('bun run lint && git stash')
  })
})
