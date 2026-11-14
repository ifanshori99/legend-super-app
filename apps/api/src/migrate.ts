// Applies committed SQL in apps/api/drizzle. Runs standalone (no API env
// needed beyond a connection string): `pnpm db:migrate` in development, and
// `node dist/migrate.js` in the Docker migrator image once per release.
import "./load-env";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { databaseUrl } from "./db/connection";
import {
  type MigrationTimeouts,
  migrationError,
  migrationTimeouts,
  runMigrations,
} from "./db/migration-session";

// src/migrate.ts and dist/migrate.js both sit one level below apps/api.
const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

let pool: Pool | undefined;
let timeouts: MigrationTimeouts | undefined;
try {
  // Bounded lock wait, unbounded statements by default (db/migration-session.ts).
  timeouts = migrationTimeouts();
  pool = new Pool({
    connectionString: databaseUrl(
      process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL,
    ),
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  pool.on("error", () =>
    console.error("The PostgreSQL migration connection was interrupted."),
  );
  // Standalone entrypoint: read EDGE_MODE directly, the API env is not loaded.
  await runMigrations(pool, migrationsFolder, timeouts, {
    edgeMode: process.env.EDGE_MODE === "true",
  });
  console.log("PostgreSQL migrations applied.");
} catch (error) {
  console.error(migrationError(error, timeouts));
  process.exitCode = 1;
} finally {
  await pool?.end();
}
