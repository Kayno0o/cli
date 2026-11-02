# db

Read-only SQL against Postgres, MySQL and MariaDB from the terminal, for Claude Code: the query runs in a `READ ONLY` transaction that is always rolled back, a statement that would write is printed for you to run instead (unless the database is a `_test` one), and the connection URL and its password are never shown.

```sh
bun install -g @kaynooo/cli-db
```

## Connection

- The URL comes from `process.env.DATABASE_URL`, which Bun fills from `.env`, `.env.local` and `.env.<NODE_ENV>` in the working directory. `--env <KEY>` names another key. The scheme picks the engine: `postgres://` and `postgresql://` for Postgres, `mysql://`, `mysql2://` and `mariadb://` for MySQL and MariaDB. Any other scheme is refused (exit 2).
- A URL whose host is a service of the compose project (`postgresql://app:pw@database:5432/app` in a Symfony `.env`) is rewritten to where this machine reaches that container: its port published on the loopback, else its address on its network. Doctrine's `serverVersion` and `charset` parameters are dropped.
- Without a URL, `db` reads the compose project's running database service (found by `docker compose ps` from this directory or a parent, told apart by the official image's `PG_MAJOR`, `MYSQL_MAJOR` or `MARIADB_MAJOR` or its name). Several such services ask for `--service <name>`, which also picks one over the URL. `db` never starts a stack.
- `--container <name>` (`-c`) reads a running container by name or id, in any compose project or none (a worktree stack, `booki-docker--shot-igesa-db-1`), found with `docker inspect`. It picks the container over the URL, and cannot be combined with `--service`.
- The credentials of `--service` and `--container` come from the container's environment, never printed: `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB` for Postgres; `MYSQL_USER`, `MYSQL_PASSWORD` and `MYSQL_DATABASE` for MySQL and MariaDB, else `root` with `MYSQL_ROOT_PASSWORD`, each also as `MARIADB_*`. A password kept in a `*_FILE` variable is refused with a hint to give the URL.
- `--database <name>` reads another database on the same server, `db dbs` lists them.
- Only a local host (`localhost`, `127.0.0.1`, `::1`, a local socket) or a compose service is connected to. Any other host is refused before connecting, exit 2, with the host (never the URL) and the config path in the message, unless it is listed in `~/.config/db/config.json`: `{ "allowedHosts": ["db.example.com"] }`. A missing or empty list allows only local hosts, and a file that is not valid JSON is ignored with a warning. There is no flag to allow a host.
- MySQL 8 logs in without TLS by fetching the server's RSA key, which `db` allows only for a loopback host and a docker network address (`172.16.0.0/12`). A MySQL 8 elsewhere (an allowed remote host, a docker pool in `192.168.0.0/16`) needs TLS or an account on `mysql_native_password`.

## Commands

| Command | What it does |
| --- | --- |
| `db "<sql>"` / `db query` | runs one read-only statement, as an argument or on stdin |
| `db tables` | tables and views with an estimated row count (Postgres: outside the system schemas, MySQL: the connected database) |
| `db describe <table>` | columns with type, nullability, default and primary key (`schema.table` to pick a schema, the database on MySQL) |
| `db dbs` | databases the connection may open, with their size, the one read marked `current` |

Options: `-n <rows>` caps the rows shown (100) and says when more were left out, `--raw` shows the columns masked by default, `--json` prints `{ columns, rows, truncated, masked }`, `-e <KEY>`, `-s <service>`, `-c <container>` and `-d <database>` pick the connection.

## Safety

- Postgres: the session opens with `default_transaction_read_only=on`, `lock_timeout=5s` and `idle_in_transaction_session_timeout=60s`, then the statement runs after `SET LOCAL statement_timeout = '30s'` in `BEGIN READ ONLY`, and the transaction is rolled back, so Postgres itself refuses a write the checks below miss. The transaction does not stop side effects outside it (`pg_terminate_backend`, `COPY ... TO PROGRAM`, `dblink`), which the checks below do.
- MySQL and MariaDB: the statement runs in `START TRANSACTION READ ONLY` on one reserved connection, under a 30 second statement timeout (`max_execution_time`, or `max_statement_time` on MariaDB), and the transaction is rolled back. A select is wrapped in `select * from (...) limit n + 1` to stop one row past `-n`, and read whole only when the wrapping does not parse or repeats a column name (errors 1064 and 1060); any other error is reported as is.
- A Postgres select is read through a cursor that stops at one row past `-n`, so a huge table is never loaded whole.
- Before running, the SQL is tokenized the way its engine reads it (Postgres: nested comments, dollar-quoted bodies, `E'...'` escapes; MySQL: `#` comments, `--` only before a blank, backslash escapes, double quotes as strings, comments that do not nest, `/*! ... */` and `/*M! ... */` run). A quoted identifier is read as a name, so `"nextval"('s')` is caught, and a NUL byte or a `U&"..."` identifier is refused. It must start with `SELECT`, `WITH`, `VALUES`, `TABLE`, `SHOW`, `EXPLAIN`, `DESCRIBE` or `DESC`, and must not use `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `INTO`, `SET`, `FOR UPDATE` and the like anywhere (so a write hidden in a CTE is caught), nor start with `REPLACE`, `LOAD`, `RENAME`, `FLUSH`, `PREPARE`, `EXECUTE` and the like, nor `SET GLOBAL`, `SET PERSIST`, `SET @@...`, nor functions with side effects (`nextval`, `setval`, `set_config`, `pg_terminate_backend`, `pg_sleep`, `pg_ls_*`, `lo_*`, `dblink`, `sleep`, `benchmark`, `get_lock`, `load_file`, ...).
- Such a statement is printed as a `sql` block with the reasons and `db` exits 1 without running it. Several statements in one string are refused unless each reads, and then run one at a time.
- Columns named like emails, phones, tokens, secrets, passwords or hashes show `***` unless `--raw`. `NULL` stays `NULL`.
- Every message, errors included, is scrubbed of the URL, the password (raw and decoded) and any `scheme://user:password@`.

## Writes on a test database

A write runs, and commits, on every route (`DATABASE_URL`, `-s`, `-c`) when the database it is connected to has a name ending in `_test` (case-sensitive). Any other write is printed as SQL for you to run, as above.

- The name is not read from the SQL text: the URL's database is checked before connecting, then the server is asked (`select current_database()`, `select database()`) inside the write transaction, and the statement is rolled back unrun when the answer does not end in `_test`.
- Only one statement runs, and it must start like plain DML or DDL (`INSERT`, `UPDATE`, `DELETE`, `REPLACE`, `MERGE`, `TRUNCATE`, `CREATE`, `ALTER`, `DROP`, `RENAME`, `WITH`, `SELECT`, `COMMENT`, `REFRESH`). `USE`, `SET`, `CALL`, `DO`, `COPY`, `PREPARE`, `GRANT`, `LOAD DATA` and psql meta-commands such as `\c` start something else and are printed instead.
- On MySQL and MariaDB a name qualified with another database (`prod.users`, `` `prod`.users ``, in any position, `information_schema.x` included) is refused, only the connected database may qualify. A table alias used as a qualifier (`update users u set u.a = 1`) is refused the same way: drop the alias.
- Whatever reaches past the database stays refused: `CREATE`, `ALTER` or `DROP` of a `DATABASE`, `SCHEMA` (MySQL), `USER`, `ROLE`, `SERVER`, `TABLESPACE`, `EXTENSION`, `SYSTEM`; `INTO OUTFILE`, `DUMPFILE`, `INFILE`; the FEDERATED engine; and every function with a side effect outside the database (`dblink`, `pg_read_file`, `sleep`, `load_file`, `pg_terminate_backend`...), `nextval` and `setval` excepted.
- Output: `ran on <database>, <n> rows affected`, then the rows a `RETURNING` gave; `--json` prints `{ database, affected, columns, rows, truncated, masked }`.

Exit codes: 0 done, 1 the database refused or was unreachable or the statement was not run because it would write, 2 bad usage.

## Other databases

SQLite is not supported: a `sqlite://` URL is refused.
