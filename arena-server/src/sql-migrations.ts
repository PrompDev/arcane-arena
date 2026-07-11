const LATEST_SCHEMA_VERSION = 1;

export function applySqlMigrations(storage: DurableObjectStorage): void {
  const sql = storage.sql;

  sql.exec(`
    CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
      id INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const currentVersion = sql
    .exec<{ version: number }>(
      "SELECT COALESCE(MAX(id), 0) AS version FROM _sql_schema_migrations",
    )
    .one().version;

  if (currentVersion < 1) {
    storage.transactionSync(() => {
      sql.exec(`
        CREATE TABLE IF NOT EXISTS arena_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          room TEXT NOT NULL,
          state_json TEXT NOT NULL,
          saved_at INTEGER NOT NULL
        )
      `);
      sql.exec(
        "INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (?, ?)",
        1,
        Date.now(),
      );
    });
  }

  const appliedVersion = sql
    .exec<{ version: number }>(
      "SELECT COALESCE(MAX(id), 0) AS version FROM _sql_schema_migrations",
    )
    .one().version;

  if (appliedVersion !== LATEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported arena schema version: ${appliedVersion}`);
  }
}
