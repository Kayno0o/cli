import { commandsRun } from '@kaynooo/cli-kit/shell'
import { describe, expect, test } from 'bun:test'
import { isEnvFile, touchesEnv } from '../src/guard'

describe('isEnvFile', () => {
  test('names env files, not their templates', () => {
    expect(['/repo/.env', '/repo/.env.local', '/repo/apps/api/.env.production', '.env.*'].every(isEnvFile)).toBe(true)
    expect(['/repo/.env.example', '/repo/.env.dist', 'environment.ts'].some(isEnvFile)).toBe(false)
  })
})

describe('touchesEnv', () => {
  const refused = ['cat .env', 'grep TOKEN .env.local', 'source .env', 'set -a && . ./.env', 'cp .env.example .env', 'head -3 apps/api/.env', 'cat < .env', 'echo A=1 >> .env', 'diff .env .env.local', 'cat .env*', 'bun -e "console.log(process.env)"', 'bun -e \'console.log(JSON.stringify(process.env, null, 2))\'', 'cp .env x', 'sed -i \'s/a/b/\' .env', 'echo "$(cat .env)"', 'echo `cat .env`', 'cat ".env"', 'cat \'.env.local\'', 'cat <<EOF > .env\nA=1\nEOF', 'git commit -m "x" && cat .env', 'git commit -m "x"\ncat .env', 'cat <<EOF\nmentions .env\nEOF\ncat .env', 'bun test 2>&1 | grep KEY .env', 'sudo cat .env']

  for (const command of refused) {
    test(`refuses ${command}`, () => {
      expect(touchesEnv(command)).toBe(true)
    })
  }

  const allowed = ['ev list', 'ev get TOKEN .env.local', 'printf %s "$v" | ev set TOKEN .env', 'bun test | redact', 'ls -la .env*', 'test -f .env && echo yes', 'git check-ignore .env', 'docker compose --env-file .env.prod config --services', 'bun --env-file=.env.test test', 'cat .env.example', 'bun -e "console.log(process.env.HOME)"', 'cat environment.ts', 'git commit -m "feat: move secrets into a .env beside it"', 'git commit -qm \'docs: say .env; then cat .env\'', 'tea issues create --title "the guard denies commands naming .env"', 'sed -i \'20a | ev audit moves values into the .env beside it |\' README.md', 'cat > notes.md <<\'EOF\'\nnever cat .env\ncp .env x\nEOF', 'git commit -F - <<EOF\nfix: the .env guard\nEOF\ngit log -1', 'bun test 2>&1 | tail -3', 'echo "a .env $(date)"']

  for (const command of allowed) {
    test(`lets ${command} through`, () => {
      expect(touchesEnv(command)).toBe(false)
    })
  }
})

describe('touchesEnv, commands that print no value', () => {
  const allowed = ['ls -a | grep -E \'^\\.env\'', 'grep -l GCU_API_TOKEN .env*', 'grep -L KEY .env', 'grep -c KEY .env', 'grep -rl KEY .env.local', 'grep -ql KEY .env', 'grep --files-with-matches KEY .env', 'rg -l KEY .env', 'rg --count KEY .env', 'find . -name \'.env*\'', 'find . -maxdepth 2 -name .env -print', 'git ls-files .env', 'bun -e \'console.log(/\\.env files/.test("x"))\'', 'bun -e \'console.log("the .env files")\'', 'python3 - <<\'EOF\'\nprint(\'the .env files\')\nEOF', 'python3 -c \'print("mentions .env")\'', 'grep -rl KEY .']

  for (const command of allowed) {
    test(`lets ${command} through`, () => {
      expect(touchesEnv(command)).toBe(false)
    })
  }

  const refused = [
    'grep KEY .env',
    'grep -n KEY .env',
    'grep -i -e KEY .env',
    'grep -nl KEY .env | cat .env',
    'grep -ecl .env',
    'grep -m1 KEY .env',
    'rg -L KEY .env',
    'rg -L -n KEY .env',
    'grep -e -l .env',
    'grep -m 1 -e -l .env',
    'rg -r -l KEY .env',
    'rg -n TRUSTED_PROXIES api/.env* compose.yaml',
    'rg -o KEY .env',
    'grep -rn KEY .',
    'grep -rn "commit-message-style" .',
    'grep -l KEY .env && cat .env',
    'find . -name .env -exec cat {} \\;',
    'find . -name \'.env*\' -execdir cat {} +',
    'find . -name .env -fprint /dev/stdout',
    'cat .env',
    'bun -e \'console.log(await Bun.file(".env").text())\'',
    'bun -e \'import { $ } from "bun"; await $`cat .env`\'',
    'bun -e \'Bun.spawn(["cat", ".env"])\'',
    'bun -e \'console.log(require("fs").readFileSync(".env", "utf8"))\'',
    'python3 -c \'print(open(".env").read())\'',
    'python3 - <<\'EOF\'\nprint(open(".env").read())\nEOF',
    'bun - <<\'EOF\'\nconsole.log(await Bun.file(".env").text())\nEOF',
    'bun - <<\'EOF\'\nimport { $ } from "bun"\nawait $`cat .env`\nEOF',
    'awk \'BEGIN { while ((getline line < ".env") > 0) print line }\'',
    'perl -e \'print `cat .env`\'',
  ]

  for (const command of refused) {
    test(`still refuses ${command}`, () => {
      expect(touchesEnv(command)).toBe(true)
    })
  }

  test('refuses a heredoc piped to sh that reads an env file', () => {
    expect(commandsRun('sh <<\'EOF\'\ncat .env\nEOF').some(each => touchesEnv(each))).toBe(true)
    expect(commandsRun('cat > a.sh <<\'EOF\'\ncat .env\nEOF').some(each => touchesEnv(each))).toBe(false)
  })
})

describe('touchesEnv, the shapes that once got through', () => {
  const refused = ['git show HEAD~1:api/.env', 'git show HEAD:.env', 'git diff HEAD -- .env', 'git log -p -- api/.env.local', 'rg KEY .env*', 'bat .env', 'sed -n 1,20p api/.env', 'docker compose exec -T php printenv', 'docker compose exec php env | grep DB', 'docker exec app env', 'docker-compose exec php printenv DATABASE_URL', 'docker compose config', 'docker compose -f compose.yaml config | grep PASSWORD', 'docker inspect app', 'docker container inspect app', 'docker inspect -f \'{{json .Config.Env}}\' app', 'docker compose exec php env | redact; docker compose exec php env', 'cat <<EOF\n$(cat .env)\nEOF', 'docker exec app sh -c "env | sort"', 'docker --context box exec -it app printenv', 'docker compose -p x exec -u root php env']

  for (const command of refused) {
    test(`refuses ${command}`, () => {
      expect(touchesEnv(command)).toBe(true)
    })
  }

  const allowed = ['docker compose exec -T php printenv | redact', 'docker compose exec php env | grep DB | redact', 'docker compose config | redact', 'docker compose config --services', 'docker inspect -f \'{{.State.Status}}\' app', 'docker compose exec php bin/phpunit', 'docker compose ps', 'ev list | redact', 'ev get A .env.local | redact', 'ev show HEAD:.env', 'ev grep ^DB_ .env', 'docker compose exec php composer config --list', 'docker compose exec php bin/console debug:config', 'docker exec app env-check', 'echo \'$(cat .env)\'', 'cat > a.md <<\'EOF\'\nnever cat .env\necho "$(cat .env)"\nEOF\ncat > b.md <<\'EOF\'\ngit show HEAD:.env\nEOF\nbun test']

  for (const command of allowed) {
    test(`lets ${command} through`, () => {
      expect(touchesEnv(command)).toBe(false)
    })
  }
})
