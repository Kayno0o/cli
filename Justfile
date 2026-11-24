# release packages with ft itself: `just release ft patch` bumps packages/ft, pushes main and its ft-v* tag atomically, then waits for CI and the registry; `just release kit,check patch` sends both in one push
release package level:
    bun packages/ft/src/cli.ts release {{ level }} --package {{ package }}

check:
    bun run check

lint:
    bun run lint

test:
    bun run test

# release every package changed since its last tag, in one push: `just release-all patch` prints the plan via `fg release --changed --dry-run`; `just release-all patch go=1` releases
release-all level go="":
    #!/usr/bin/env sh
    set -eu
    if [ "{{ go }}" = "go=1" ] || [ "{{ go }}" = "1" ]; then
      bun packages/ft/src/cli.ts release {{ level }} --changed
    else
      bun packages/ft/src/cli.ts release {{ level }} --changed --dry-run
    fi
