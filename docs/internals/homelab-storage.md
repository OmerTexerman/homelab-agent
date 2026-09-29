# Homelab storage (`homelab.sqlite`)

Fork-owned durable state lives in its own SQLite database,
`<stateDir>/homelab.sqlite` (in production `~/.t3/userdata/homelab.sqlite`),
next to upstream's `state.sqlite`. The fork is moving its JSON stores and its
fork tables in `state.sqlite` here, one owner at a time:

| Phase | Owner      | Id range | Moves                                                                 |
| ----- | ---------- | -------- | --------------------------------------------------------------------- |
| P3    | foundation | 1–99     | nothing; adds `homelab_migrations`, `homelab_imports`, `homelab_meta` |
| P4    | runtime    | 100–199  | `thread-runtimes.json`, `project-runtime-lifecycle.json`              |
| P5    | knowledge  | 200–299  | `homelab-graph.json`, `project_memory_entries` (FTS5 search)          |
| P6    | secrets    | 300–399  | `homelab-secrets.json` metadata                                       |

A separate file keeps the two migration histories apart. Upstream's Effect
migrator skips every id at or below the latest applied one, and upstream syncs
keep adding ids to `state.sqlite`, so fork tables there have to be renumbered
around upstream's. `homelab.sqlite` has none of that.

## Code

All of it is in `apps/server/src/homelabPersistence/`:

- `HomelabSql.ts`: the `HomelabSql` service, which is upstream's `node:sqlite`
  client (`@t3tools/shared/nodeSqliteClient`) under a distinct tag. Fork code
  uses `yield* HomelabSql` and never `SqlClient.SqlClient`, which stays bound
  to `state.sqlite`, so a fork repository can't reach upstream tables by
  accident. Building the layer opens the file with WAL, foreign keys, and a
  5 s busy timeout, runs the FTS5 probe, then runs migrations. Any failure
  stops server startup. The file also exports `withHomelabTransaction` and
  `HomelabSqlMemory` for tests.
- `Migrations.ts`: the registry and runner. Applied ids go in
  `homelab_migrations`.
- `JsonImport.ts`: `importJsonOnce`.
- `HomelabMetaRepository.ts`: the reference repository, a service plus a layer
  over `homelab_meta`.

`HomelabSqlLive` is provided in `apps/server/src/homelab/serverLayers.ts`,
inside `HomelabRuntimeServicesLive`, so every fork service in that layer and
every upstream consumer after it can use `HomelabSql`.

## Migrations

- Each owner adds migrations only in its own range. Add a file under
  `Migrations/` and an `[id, name, migration]` entry to the registry, sorted
  by id. Tests check that ids increase, fall inside a range, and names are
  unique.
- Ids are permanent once shipped. Never renumber or reuse one.
- The runner applies every registered id that isn't recorded yet, not just
  ids above the maximum, so P4 can add id 101 after P5 has shipped 200. On an
  existing database, a new lower id then runs after higher ones, so a
  migration may depend only on tables from its own range.
- An older release that meets ids it doesn't know leaves them alone, which is
  what makes rollback work.
- Migrations `yield* SqlClient.SqlClient`, which the runner binds to the
  homelab client. All pending migrations run in one transaction.

## Schema changes are additive for one release

Change the schema by expanding first and contracting later. A release adds
tables, columns, and indexes, and the previous release must still work on the
result. Drops, renames, and changes to what a column means wait until the
release after that. Because of this rule, `release.sh has-new-migrations`
doesn't count `homelab.sqlite` migrations: an unhealthy release that ran one
can still be rolled back automatically.

## Importing a JSON store once

```ts
const result =
  yield *
  importJsonOnce({
    source: "thread-runtimes.json", // stable marker key, never reused
    path: NodePath.join(stateDir, "thread-runtimes.json"),
    decode: ThreadRuntimesFile, // Schema for the parsed JSON value
    apply: (file) => repo.insertAll(file.runtimes), // returns the row count
  });
// { status: "imported", rows, sourceSha256 } | { status: "already-imported", importedAt } | { status: "missing" }
```

- If a marker row for `source` exists, the call does nothing.
- If the file is missing, it records nothing and returns `missing`.
- If the file can't be read or decoded (invalid JSON or a schema mismatch), it
  fails with `HomelabImportReadError` or `HomelabImportDecodeError`. No marker
  is written and the database is untouched, so the next start retries.
- Otherwise `apply` and the `homelab_imports` marker (source, path, sha256,
  time, rows) commit in one transaction. If `apply` fails, its rows and the
  marker roll back together.
- The JSON file is only ever read. It is never moved, rewritten, or deleted.
  A release rolled back to before the import keeps reading stale-but-intact
  JSON instead of an empty store. Writes made after the import exist only in
  SQLite. If that release rolls forward again, the marker keeps the import
  from running twice, so anything the old code wrote to the JSON meanwhile
  is not picked up.

Call it once while the owning service's layer is being built, before the
service reads its tables. After the import, the service reads and writes
SQLite only.

## Adding a store (P4–P6)

1. Add the migrations for your tables in your range.
2. Write a repository following `HomelabMetaRepository.ts`: a
   `Context.Service` tag, a layer that captures `HomelabSql` once, and
   `SqlSchema` statements with errors mapped through `toPersistenceSqlError`.
   Repository calls made inside `withHomelabTransaction` join that transaction.
3. Call `importJsonOnce` from the service layer for the JSON file being
   replaced, and switch the service's reads and writes to the repository.
4. Test the import with the patterns in `JsonImport.test.ts`: real files,
   `HomelabSqlMemory`, a decode failure, and an injected `apply` failure.
5. Search tables (P5) use FTS5. `probeFts5` checks for it at startup, and Node
   24 has it.

## Secrets (P6)

Migration 300 adds three tables. Secret values stay in upstream's encrypted
`ServerSecretStore`; only metadata is here.

- `homelab_secrets`: `key` (primary key), `label`, `summary`,
  `value_updated_at` (when the stored value last changed, the revision runtimes
  record in their secrets manifest), `created_at`, `updated_at`.
- `homelab_secret_scopes`: `(secret_key, project_id)`, the project allowlist.
  No rows means global.
- `homelab_secret_requests`: one row per key with an open (`pending`) or last
  `declined` request: `requested_at`, `requested_by_thread_id`, `declined_at`,
  `declined_by`. Saving a value deletes the row; a new request replaces it.

`HomelabSecretRegistryLive` imports `homelab-secrets.json` once (legacy
`requestedAt` becomes a pending request row, reserved key names are skipped
with a warning). After that:

- If the JSON file's sha256 no longer matches the import marker (a rolled-back
  release wrote to it), SQLite stays authoritative and writable, the mismatch
  is logged as an error, and the file is listed in `DegradedStateFiles`.
  Secrets that release added are not picked up; re-enter them in Settings,
  then move the JSON file aside to clear the warning.
- If the file can't be read or decoded, the registry lists what SQLite has and
  refuses writes, so a later successful import never has to merge.

The JSON file is never written, moved, or deleted.

## Backups and smoke

- `scripts/deploy/release.sh snapshot-db <out> [homelab-out]` writes
  `VACUUM INTO` copies of both databases, which is safe while the server is
  running. The homelab copy is skipped when the file doesn't exist.
- The Proxmox backup (`deploy/proxmox/homelab-agent-deploy.sh`) excludes the
  live `homelab.sqlite`, `-wal`, and `-shm` files and ships
  `userdata/homelab.backup.sqlite` in their place, as it does for
  `state.sqlite`.
- `scripts/prod-smoke.ts --seed-from` copies `homelab.sqlite` with
  `VACUUM INTO` when it exists, so the smoke runs homelab migrations against
  production data.
- To restore, stop the service, then copy `homelab.backup.sqlite` over
  `homelab.sqlite` and delete the live `-wal` and `-shm` files.
