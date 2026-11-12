/**
 * A sandbox for tests that drive code which spawns docker, mkcert, devproxy and the like: fake executables on a PATH of their own, logging what they were asked and answering from files, and a HOME of their own for every path derived from it.
 * Nothing in a sandbox reaches the real Docker, nginx or the user's checkouts: the tools that must never run log to `forbidden.log`, and a test asserts it stays empty.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const DOCKER = `#!/bin/sh
d="$FAKE_DIR"
paused=$(tr '\\n' , < "$d/paused" 2>/dev/null)
printf '%s\\t%s\\tCOMPOSE_FILE=%s\\tCOMPOSE_PROJECT_NAME=%s\\tpaused=%s\\n' "$PWD" "$*" "\${COMPOSE_FILE-}" "\${COMPOSE_PROJECT_NAME-}" "$paused" >> "$d/docker.log"
list() { cat "$d/$1" 2>/dev/null; true; }
case "$1" in
  compose)
    shift
    key=$(basename "$PWD")
    while [ "$1" = -f ] || [ "$1" = -p ] || [ "$1" = --profile ]; do
      [ "$1" = -p ] && key=$2
      shift 2
    done
    sub=$1
    [ -f "$d/delay-$sub" ] && sleep "$(cat "$d/delay-$sub")"
    if [ -f "$d/$sub-fails-$key" ]; then
      echo "$sub failed for $key" >&2
      exit 1
    fi
    case "$sub" in
      ls) if [ -f "$d/compose-ls.json" ]; then cat "$d/compose-ls.json"; else echo '[]'; fi ;;
      config)
        case "$*" in
          *--format*) if [ -f "$d/config-$key.json" ]; then cat "$d/config-$key.json"; else cat "$d/config.json"; fi ;;
          *--services*) list services ;;
        esac ;;
    esac ;;
  network)
    case "$2" in
      inspect) [ -f "$d/network" ] || exit 1 ;;
      create) touch "$d/network" ;;
    esac ;;
  ps)
    case "$*" in
      *status=paused*) list paused ;;
      *status=running*) list running ;;
      *"ps -aq"*) list containers ;;
    esac ;;
  inspect)
    case "$*" in
      *Mounts*) list mounts ;;
      *State.Running*) list test-db-id ;;
    esac ;;
  exec)
    case "$*" in
      *pg_isready*hostname*) [ -s "$d/test-db-id" ] || exit 1; head -c 12 "$d/test-db-id"; echo ;;
      *pg_database*) list databases ;;
      *dropdb*)
        eval "name=\\\${$#}"
        grep -vxF "$name" "$d/databases" > "$d/databases.tmp" 2>/dev/null
        mv "$d/databases.tmp" "$d/databases" 2>/dev/null ;;
    esac ;;
  pause)
    shift
    for id in "$@"; do echo "$id" >> "$d/paused"; done ;;
  unpause)
    shift
    for id in "$@"; do
      grep -vxF "$id" "$d/paused" > "$d/paused.tmp" 2>/dev/null
      mv "$d/paused.tmp" "$d/paused" 2>/dev/null
    done ;;
  volume)
    case "$2" in
      ls) list volumes ;;
      inspect) grep -qxF "$3" "$d/volumes" 2>/dev/null || exit 1 ;;
      create) eval "last=\\\${$#}"; echo "$last" >> "$d/volumes" ;;
      rm)
        if [ -f "$d/volume-rm-fails" ]; then
          echo "volume is in use" >&2
          exit 1
        fi
        shift 2
        for v in "$@"; do
          grep -vxF "$v" "$d/volumes" > "$d/volumes.tmp" 2>/dev/null
          mv "$d/volumes.tmp" "$d/volumes" 2>/dev/null
        done ;;
    esac ;;
  run)
    [ -f "$d/delay-run" ] && sleep "$(cat "$d/delay-run")"
    if [ -f "$d/run-fails" ]; then
      echo "no space left on device" >&2
      exit 1
    fi ;;
esac
exit 0
`

const MKCERT = `#!/bin/sh
echo "mkcert $*" >> "$FAKE_DIR/calls.log"
while [ $# -gt 0 ]; do
  case "$1" in
    -cert-file) mkdir -p "$(dirname "$2")"; echo cert > "$2"; shift ;;
    -key-file) mkdir -p "$(dirname "$2")"; echo key > "$2"; shift ;;
  esac
  shift
done
`

// The shared proxy: logs what it was asked, lists the hosts of `devproxy-hosts` (none by default), fails `up` when `devproxy-fails` exists, and has no config to serve when its config file is gone; `up` creates the proxy network.
const DEVPROXY = `#!/bin/sh
echo "devproxy $*" >> "$FAKE_DIR/calls.log"
[ -f "$XDG_CONFIG_HOME/devproxy/config.ts" ] || exit 1
case "$1" in
  hosts) cat "$FAKE_DIR/devproxy-hosts" 2>/dev/null || echo '[]' ;;
  up)
    [ -f "$FAKE_DIR/devproxy-fails" ] && exit 1
    touch "$FAKE_DIR/network" ;;
esac
exit 0
`

// Logs the notification a detached job ends with, so none reaches the desktop
const NOTIFY_SEND = `#!/bin/sh
echo "notify-send $*" >> "$FAKE_DIR/calls.log"
exit 0
`

const FORBIDDEN = `#!/bin/sh
echo "$(basename "$0") $*" >> "$FAKE_DIR/forbidden.log"
exit 1
`

/** Tools no test may reach, whether the code under test means to or not. */
const FORBIDDEN_TOOLS = ['nginx', 'sudo', 'xdg-open', 'ssh', 'systemctl']

export interface DockerCall {
  cwd: string
  args: string
  composeFile: string
  composeProject: string
  /** The containers paused when it ran. */
  paused: string[]
}

export interface Sandbox {
  /** A HOME of its own, with ~/Workspace, the config and the caches under it. */
  home: string
  /** The directory the fakes read their answers from and log to. */
  state: string
  /** The environment a child process runs in. */
  env: Record<string, string>
  /** Fills in what a fake answers or makes it fail: one id or name per line, a file named `<verb>-fails-<dir>` making that compose verb fail in that directory. */
  seed: (file: string, text: string) => void
  /** What a fake wrote back, such as the volumes left or the containers still paused. */
  read: (file: string) => string
  dockerCalls: () => DockerCall[]
  /** Everything the mkcert, devproxy and notify-send fakes were asked, one per line. */
  calls: () => string[]
  /** What a forbidden tool was asked; empty when nothing reached one. */
  forbidden: () => string[]

  remove: () => void
}

// The programs a sandbox fakes, or takes away to see wt without them: the real ones stay off its PATH.
const NOT_FROM_SYSTEM = new Set(['docker', 'mkcert', 'devproxy', 'notify-send', 'osascript', ...FORBIDDEN_TOOLS])

let systemBin: string | undefined

// The system's programs (git, cp, ss...) linked into one folder less NOT_FROM_SYSTEM, once per test process, so a host with a real notify-send or mkcert behaves as one without.
function systemTools(): string {
  if (systemBin !== undefined)
    return systemBin

  const dir = mkdtempSync(join(tmpdir(), 'sandbox-system-'))

  process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

  // A name in both, /bin being /usr/bin on most systems, links once; the set, as existsSync reads a dangling link as absent
  const linked = new Set(NOT_FROM_SYSTEM)

  for (const from of ['/usr/bin', '/bin']) {
    for (const name of existsSync(from) ? readdirSync(from) : []) {
      if (!linked.has(name))
        symlinkSync(join(from, name), join(dir, name))

      linked.add(name)
    }
  }

  systemBin = dir

  return dir
}

function lines(file: string): string[] {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
}

export function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'sandbox-'))
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const state = join(root, 'state')

  for (const dir of [bin, state, join(home, 'Workspace')])
    mkdirSync(dir, { recursive: true })

  const install = (name: string, script: string) => {
    writeFileSync(join(bin, name), script)
    chmodSync(join(bin, name), 0o755)
  }

  install('docker', DOCKER)
  install('mkcert', MKCERT)

  install('devproxy', DEVPROXY)
  install('notify-send', NOTIFY_SEND)

  for (const name of FORBIDDEN_TOOLS)
    install(name, FORBIDDEN)

  for (const file of ['docker.log', 'calls.log', 'forbidden.log', 'paused'])
    writeFileSync(join(state, file), '')

  mkdirSync(join(home, '.config', 'devproxy'), { recursive: true })
  writeFileSync(join(home, '.config', 'devproxy', 'config.ts'), 'export default {}\n')

  // The fakes first, then the system's tools less the ones faked
  const path = `${bin}:${systemTools()}:${dirname(process.execPath)}`
  const env = { PATH: path, HOME: home, FAKE_DIR: state, XDG_CACHE_HOME: join(home, '.cache'), XDG_CONFIG_HOME: join(home, '.config') }

  return {
    home,
    state,
    env,
    seed: (file, text) => writeFileSync(join(state, file), text),
    read: file => existsSync(join(state, file)) ? readFileSync(join(state, file), 'utf8') : '',
    dockerCalls: () => lines(join(state, 'docker.log')).map((line) => {
      const [cwd = '', args = '', composeFile = '', composeProject = '', paused = ''] = line.split('\t')

      return { cwd, args, composeFile: composeFile.slice('COMPOSE_FILE='.length), composeProject: composeProject.slice('COMPOSE_PROJECT_NAME='.length), paused: paused.slice('paused='.length).split(',').filter(Boolean) }
    }),
    calls: () => lines(join(state, 'calls.log')),
    forbidden: () => lines(join(state, 'forbidden.log')),

    remove: () => rmSync(root, { recursive: true, force: true }),
  }
}
