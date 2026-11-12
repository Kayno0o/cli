import { describe, expect, test } from 'bun:test'
import { commitSources, gcLine, HEREDOC_OPENER, heredocBody, inlineMessage } from '../src/commit'
import { ADD_ALL, COMMIT_ALL, CONFIG_OVERRIDE, gitViolation, PUSH, STASH, subcommandOf, TAGS_APART } from '../src/git'
import { REMOTE, remoteViolation } from '../src/remote'

describe('remoteViolation', () => {
  test.each([
    'ssh prod uptime',
    'scp a.txt host:/tmp',
    'mosh host',
    'rsync -a dist/ user@host:/srv',
    'nc example.com 80',
    'git clone ssh://git@host/repo.git',
    'docker --context prod ps',
    'DOCKER_CONTEXT=prod docker ps',
    'docker context use prod',
    'GIT_SSH_COMMAND="ssh -i k" git fetch',
    'kubectl --server https://k8s get pods',
    'ssh-wrapper=1 true && ssh prod',
  ])('refuses %p', (command) => {
    expect(remoteViolation(command)).toBe(REMOTE)
  })

  test.each([
    'ls',
    'rsync -a dist/ ./out/',
    'nc -l 8080',
    'nc localhost 80',
    'docker ps',
    'docker --context default ps',
    'git fetch origin',
    'echo ssh prod',
  ])('lets %p through', (command) => {
    expect(remoteViolation(command)).toBeNull()
  })
})

describe('gitViolation', () => {
  test.each([
    ['git stash', STASH],
    ['git stash pop', STASH],
    ['git add .', ADD_ALL],
    ['git add -A', ADD_ALL],
    ['git commit -am "x"', COMMIT_ALL],
    ['git commit -a -m x', COMMIT_ALL],
    ['git push origin main', PUSH],
    ['git push --tags', PUSH],
    ['gp', PUSH],
    ['gp --repos --dry-run', PUSH],
    ['git -c alias.x=!sh status', CONFIG_OVERRIDE],
    ['git -c core.sshCommand=x fetch', CONFIG_OVERRIDE],
    ['git config alias.st status', CONFIG_OVERRIDE],
  ])('%p is refused', (command, message) => {
    expect(gitViolation(command)).toBe(message)
  })

  test.each([
    'git status',
    'git add src/a.ts',
    'git commit -m "x"',
    'git diff --stat',
    'git stash list',
  ])('%p goes ahead', (command) => {
    expect(gitViolation(command)).toBeNull()
  })

  test('a push the user asked for goes ahead, its tags still go with the branch', () => {
    expect(gitViolation('git push origin main', true)).toBeNull()
    expect(gitViolation('git push --tags', true)).toBe(TAGS_APART)
  })

  test('gp is a push, what follows its -- being the push\'s flags', () => {
    expect(gitViolation('gp --repos', true)).toBeNull()
    expect(gitViolation('gp -- --tags', true)).toBe(TAGS_APART)
    expect(gitViolation('gp -- --atomic --tags', true)).toBeNull()
    expect(gitViolation('gp --tags', true)).toBeNull()
  })

  test('subcommandOf skips the options before the subcommand', () => {
    expect(subcommandOf(['-C', 'dir', 'status', '-s'])).toEqual({ name: 'status', rest: ['-s'] })
  })
})

describe('commit messages', () => {
  test('inlineMessage joins the -m values', () => {
    expect(inlineMessage(['feat: x', 'body'])).toBe('feat: x\n\nbody')
  })

  test('commitSources reads each commit of the command', () => {
    expect(commitSources('git commit -m "a" && git commit -F msg.txt').map(source => source.file)).toEqual([null, 'msg.txt'])
    expect(commitSources('git commit --amend --no-edit')[0]?.isReused).toBeFalsy()
    expect(commitSources('git commit --trailer "A: b" -m x')[0]?.hasTrailerFlag).toBe(true)
    expect(commitSources('git status')).toEqual([])
  })

  test('commitSources reads -u<mode> and -S<key> as one option, whatever letters they hold', () => {
    expect(commitSources('git commit -unormal -m "fix: x"')[0]?.parts).toEqual(['fix: x'])
    expect(commitSources('git commit -S3AA5C34 -m "fix: x"')[0]?.isReused).toBeFalsy()
    expect(commitSources('git commit -m "fix: x" -Sfoos')[0]?.hasTrailerFlag).toBeFalsy()
  })

  test('heredocBody takes the text up to the terminator', () => {
    const text = 'cat <<\'EOF\'\nline\nEOF\nrest'

    expect(HEREDOC_OPENER.test(text)).toBe(true)
    expect(heredocBody(text, HEREDOC_OPENER)?.body).toBe('line')
  })

  test('gcLine turns a plain commit into the gc call', () => {
    expect(gcLine('git add a.ts && git commit -m "feat: x"')).toBe('gc \'feat: x\' -- a.ts')
    expect(gcLine('git status')).toBeNull()
  })
})
