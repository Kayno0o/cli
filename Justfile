# release packages with ft itself: `just release ft patch` bumps packages/ft, pushes main and its ft-v* tag atomically, then waits for CI and the registry; `just release kit,check patch` sends both in one push
release package level:
    bun packages/ft/src/cli.ts release {{ level }} --package {{ package }}

check:
    bun run check

lint:
    bun run lint

test:
    bun run test

# release every package changed since its last tag, in one push: `just release-all patch` prints the plan, `just release-all patch go=1` releases
release-all level go="":
    #!/usr/bin/env sh
    set -eu
    changed=""
    for dir in packages/*/; do
      name=$(basename "$dir")
      tag=$(git describe --tags --match "$name-v*" --abbrev=0 2>/dev/null || true)
      if [ -z "$tag" ]; then range="HEAD"; else range="$tag..HEAD"; fi
      [ -n "$(git log --oneline "$range" -- "$dir" | head -1)" ] || continue
      echo "$name changed since ${tag:-the start}"
      changed="${changed:+$changed,}$name"
    done
    [ -n "$changed" ] || { echo "nothing changed since the last tags"; exit 0; }
    if [ "{{ go }}" = "go=1" ] || [ "{{ go }}" = "1" ]; then
      bun packages/ft/src/cli.ts release {{ level }} --package "$changed"
    else
      bun packages/ft/src/cli.ts release {{ level }} --package "$changed" --dry-run
    fi
