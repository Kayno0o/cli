# release one package with ft itself: `just release ft patch` bumps packages/ft, pushes main and its ft-v* tag atomically, then waits for CI and the registry
release package level:
    bun packages/ft/src/cli.ts release {{ level }} --package {{ package }}

check:
    bun run check

lint:
    bun run lint

test:
    bun run test

# release every package changed since its last tag: `just release-all patch` prints the plan, `just release-all patch go=1` releases
release-all level go="":
    #!/usr/bin/env sh
    set -eu
    for dir in packages/*/; do
      name=$(basename "$dir")
      tag=$(git describe --tags --match "$name-v*" --abbrev=0 2>/dev/null || true)
      if [ -z "$tag" ]; then range="HEAD"; else range="$tag..HEAD"; fi
      [ -n "$(git log --oneline "$range" -- "$dir" | head -1)" ] || continue
      if [ "{{ go }}" = "go=1" ] || [ "{{ go }}" = "1" ]; then
        bun packages/ft/src/cli.ts release {{ level }} --package "$name"
      else
        echo "would release $name {{ level }} (since ${tag:-the start})"
      fi
    done
