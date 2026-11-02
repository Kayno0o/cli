.PHONY: build

build:
	bun run build

# v0.0.X, v0.X.0, vX.0.0: bump, then push the branch and its new tag in one atomic push; a rejected push drops the bump so a retry starts clean
patch minor major:
	npm version $@
	tag=$$(git tag --points-at HEAD); git push --atomic origin HEAD "$$tag" || { git tag -d "$$tag"; git reset --keep HEAD~1; exit 1; }
