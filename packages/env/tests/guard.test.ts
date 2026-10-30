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
