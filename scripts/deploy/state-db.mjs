// Read-only helpers over a Homelab Agent database, used by release.sh.
// `snapshot` works on state.sqlite and homelab.sqlite alike.
// Safe while the live server has the database open (WAL + read-only handle).
//
//   node state-db.mjs snapshot <db> <out>   consistent copy via VACUUM INTO
//   node state-db.mjs running-turns <db>    count provider turns in flight
import * as NodeSqlite from "node:sqlite";

const [command, dbPath, outPath] = process.argv.slice(2);
if (!command || !dbPath) {
  console.error("usage: state-db.mjs <snapshot|running-turns> <db> [out]");
  process.exit(2);
}

const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
try {
  if (command === "snapshot") {
    if (!outPath) throw new Error("snapshot requires an output path");
    db.exec(`VACUUM INTO '${outPath.replaceAll("'", "''")}'`);
  } else if (command === "running-turns") {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM projection_thread_sessions WHERE status = 'running' AND active_turn_id IS NOT NULL",
      )
      .get();
    console.log(String(row?.n ?? 0));
  } else {
    throw new Error(`unknown command: ${command}`);
  }
} finally {
  db.close();
}
