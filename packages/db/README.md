# db

Read-only SQL against Postgres from the terminal, for Claude Code: the query runs in a `READ ONLY` transaction that is always rolled back, a statement that would write is printed for you to run instead, and the connection URL and its password are never shown.

```sh
bun install -g @kaynooo/db-tools
```

## Connection

- The URL comes from `process.env.DATABASE_URL`, which Bun fills from `.env`, `.env.local` and `.env.<NODE_ENV>` in the working directory. `--env <KEY>` names another key.
- A URL whose host is a service of the compose project (`postgresql://app:pw@database:5432/app` in a Symfony `.env`) is rewritten to where this machine reaches that container: its port published on the loopback, else its address on its network. Doctrine's `serverVersion` and `charset` parameters are dropped.
- Without a URL, `db` reads the compose project's running Postgres service (found by `docker compose ps` from this directory or a parent, told apart by the official image's `PG_MAJOR` or its name), with the credentials of its `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB`. Several such services ask for `--service <name>`, which also picks one over the URL. A MySQL or MariaDB service, or none running, is an error saying so: `db` never starts a stack.
- `--database <name>` reads another database on the same server, `db dbs` lists them.
- Only a local host (`localhost`, `127.0.0.1`, `::1`, a local socket) or a compose service is connected to. Any other host is refused before connecting, exit 2, with the host (never the URL) and the config path in the message, unless it is listed in `~/.config/db/config.json`: `{ "allowedHosts": ["db.example.com"] }`. A missing or empty list allows only local hosts, and a file that is not valid JSON is ignored with a warning. There is no flag to allow a host.

## Commands

| Command | What it does |
| --- | --- |
| `db "<sql>"` / `db query` | runs one read-only statement, as an argument or on stdin |
| `db tables` | tables, views and materialized views outside the system schemas, with an estimated row count |
| `db describe <table>` | columns with type, nullability, default and primary key (`schema.table` to pick a schema) |
| `db dbs` | databases the connection may open, with their size, the one read marked `current` |

Options: `-n <rows>` caps the rows shown (100) and says when more were left out, `--raw` shows the columns masked by default, `--json` prints `{ columns, rows, truncated, masked }`, `-e <KEY>`, `-s <service>` and `-d <database>` pick the connection.

## Safety

- The session opens with `default_transaction_read_only=on`, `lock_timeout=5s` and `idle_in_transaction_session_timeout=60s`, then the statement runs after `SET LOCAL statement_timeout = '30s'` in `BEGIN READ ONLY`, and the transaction is rolled back, so Postgres itself refuses a write the checks below miss. The transaction does not stop side effects outside it (`pg_terminate_backend`, `COPY ... TO PROGRAM`, `dblink`), which the checks below do.
- A select is read through a cursor that stops at one row past `-n`, so a huge table is never loaded whole.
- Before running, the SQL is tokenized (comments, which end at `\r` as well as `\n`, strings and dollar-quoted bodies are ignored; a quoted identifier is read as a name, so `"nextval"('s')` is caught, and a NUL byte or a `U&"..."` identifier is refused). It must start with `SELECT`, `WITH`, `VALUES`, `TABLE`, `SHOW` or `EXPLAIN`, and must not use `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `INTO`, `SET`, `FOR UPDATE` and the like anywhere (so a write hidden in a CTE is caught), nor functions with side effects (`nextval`, `setval`, `set_config`, `pg_terminate_backend`, `pg_sleep`, `pg_ls_*`, `pg_stat_file`, `txid_current`, `*_to_xml`, `lo_*`, `dblink`, ...).
- Such a statement is printed as a `sql` block with the reasons and `db` exits 1 without connecting. Several statements in one string are refused unless each reads, and then run one at a time.
- Columns named like emails, phones, tokens, secrets, passwords or hashes show `***` unless `--raw`. `NULL` stays `NULL`.
- Every message, errors included, is scrubbed of the URL, the password (raw and decoded) and any `scheme://user:password@`.

Exit codes: 0 done, 1 the database refused or was unreachable or the statement was not run because it would write, 2 bad usage.

## Other databases

Only Postgres is supported. MySQL and MariaDB would need `START TRANSACTION READ ONLY` and their own write words, SQLite a read-only connection (`readonly: true`) instead of a transaction, and the `tables` and `describe` queries rewritten per catalog. Bun's `SQL` takes all three URLs.
