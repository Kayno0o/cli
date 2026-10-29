# db

Read-only SQL against Postgres from the terminal, for Claude Code: the query runs in a `READ ONLY` transaction that is always rolled back, a statement that would write is printed for you to run instead, and the connection URL and its password are never shown.

```sh
bun install -g @kaynooo/db-tools
```

The connection URL comes from `process.env.DATABASE_URL`, which Bun fills from `.env`, `.env.local` and `.env.<NODE_ENV>` in the working directory. `--env <KEY>` names another key.

## Commands

| Command | What it does |
| --- | --- |
| `db "<sql>"` / `db query` | runs one read-only statement, as an argument or on stdin |
| `db tables` | tables, views and materialized views outside the system schemas, with an estimated row count |
| `db describe <table>` | columns with type, nullability, default and primary key (`schema.table` to pick a schema) |

Options: `-n <rows>` caps the rows shown (100) and says how many were left out, `--raw` shows the columns masked by default, `--json` prints `{ columns, rows, total, omitted, masked }`, `-e <KEY>` picks the environment key.

## Safety

- The statement runs after `SET LOCAL statement_timeout = '30s'` in `BEGIN READ ONLY`, and the transaction is rolled back, so Postgres itself refuses a write the checks below miss.
- Before running, the SQL is tokenized (comments, strings, quoted identifiers and dollar-quoted bodies are ignored). It must start with `SELECT`, `WITH`, `VALUES`, `TABLE`, `SHOW` or `EXPLAIN`, and must not use `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `INTO`, `SET`, `FOR UPDATE` and the like anywhere (so a write hidden in a CTE is caught), nor functions with side effects (`nextval`, `setval`, `set_config`, `pg_terminate_backend`, `lo_*`, `dblink`, ...).
- Such a statement is printed as a `sql` block with the reasons and `db` exits 3 without connecting. Several statements in one string are refused unless each reads, and then run one at a time.
- Columns named like emails, phones, tokens, secrets, passwords or hashes show `***` unless `--raw`. `NULL` stays `NULL`.
- Every message, errors included, is scrubbed of the URL, the password (raw and decoded) and any `scheme://user:password@`.

Exit codes: 0 done, 1 the database refused or was unreachable, 2 bad usage, 3 the statement was not run because it would write.

## Other databases

Only Postgres is supported. MySQL and MariaDB would need `START TRANSACTION READ ONLY` and their own write words, SQLite a read-only connection (`readonly: true`) instead of a transaction, and the `tables` and `describe` queries rewritten per catalog. Bun's `SQL` takes all three URLs.
