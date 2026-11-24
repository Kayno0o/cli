# @kaynooo/cli-sf

Interactive picker and runner for Symfony `bin/console` commands across local projects and Docker Compose PHP containers.

## Install

```sh
bun add -g @kaynooo/cli-sf
```

## Usage

```sh
sf                           # pick a command interactively (or list off a terminal)
sf cache:clear               # run a command directly
sf -s app cache:clear        # target a specific compose PHP service
sf -                         # rerun the last command with its arguments
```

## Options

| Flag | Description |
| --- | --- |
| `-s`, `--service <name>` | compose service running PHP (overrides auto-detection and `config.jsonc#sf.service`) |
