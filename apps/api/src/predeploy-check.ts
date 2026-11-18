// Pre-deploy check (legend-jtnd, legend-k1np). Run before migrations by
// deploy.sh and first-boot provisioning (migrator image, see docs/deployment.md):
//   node dist/predeploy-check.js
//   pnpm --filter @starter/api exec tsx src/predeploy-check.ts
//
// Changes nothing. Reads MIGRATION_DATABASE_URL, or MIGRATION_DATABASE_URL_FILE,
// a path to a file holding the URL. Prints role and stream counts only, never a
// URL or password. Deliberately does not load .env files.
import { readFileSync } from "node:fs";
import {
  MigrationSettingError,
  migrationTimeouts,
} from "./db/migration-session";
import { PredeployCheckError, runPredeployCheck } from "./db/predeploy-check";

function setting(name: string) {
  const direct = process.env[name];
  const file = process.env[`${name}_FILE`];
  if (direct && file)
    throw new PredeployCheckError(`Set ${name} or ${name}_FILE, not both.`);
  if (file) {
    try {
      return readFileSync(file, "utf8").trim();
    } catch {
      throw new PredeployCheckError(
        `Cannot read the file named by ${name}_FILE.`,
      );
    }
  }
  if (!direct) throw new PredeployCheckError(`${name} is required.`);
  return direct;
}

// Server errors (SQLSTATE) carry PostgreSQL's own message, which never holds a
// password. Anything else gets a fixed text: error messages from the network
// stack or pg can quote the connection string.
const NETWORK: Record<string, string> = {
  ECONNREFUSED:
    "PostgreSQL refused the connection. Check that the postgres service is running and healthy (docker compose ps) and that MIGRATION_DATABASE_URL names its host and port.",
  ENOTFOUND:
    "The PostgreSQL host in MIGRATION_DATABASE_URL could not be resolved. Run the check on the private network next to the postgres service.",
  EAI_AGAIN:
    "The PostgreSQL host in MIGRATION_DATABASE_URL could not be resolved. Run the check on the private network next to the postgres service.",
  ETIMEDOUT:
    "The connection to PostgreSQL timed out. Check that the check runs on the private network next to the postgres service.",
};
const SERVER: Record<string, string> = {
  "28P01":
    "PostgreSQL rejected the migration login; check the user and password in MIGRATION_DATABASE_URL.",
  "3D000": "The database named in MIGRATION_DATABASE_URL does not exist.",
};

function describe(error: unknown) {
  if (error instanceof PredeployCheckError) return error.message;
  const err = error as {
    code?: unknown;
    message?: unknown;
    cause?: { code?: unknown };
  };
  const code = typeof err.code === "string" ? err.code : err.cause?.code;
  if (typeof code === "string" && NETWORK[code]) return NETWORK[code];
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
    const said =
      typeof err.message === "string" ? ` PostgreSQL said: ${err.message}` : "";
    return `${SERVER[code] ?? `PostgreSQL refused an operation (SQLSTATE ${code}).`}${said}`;
  }
  if (typeof err.message === "string" && /timeout/i.test(err.message))
    return NETWORK.ETIMEDOUT;
  return "Unexpected error. Connection strings are not printed; check MIGRATION_DATABASE_URL and that PostgreSQL is reachable.";
}

try {
  // Refuse a bad MIGRATION_*_TIMEOUT here, before the database is touched,
  // rather than at the migrate step (db/migration-session.ts, legend-jluo).
  migrationTimeouts();
  const report = await runPredeployCheck(setting("MIGRATION_DATABASE_URL"), {
    log: (line) => console.log(line),
  });
  const who = report.migrator.superuser ? "superuser" : "BYPASSRLS";
  const outbox = report.outbox.present
    ? `${report.outbox.rows} rows, per-destination sequences intact`
    : "absent";
  const gates =
    report.releaseGates.status === "n/a"
      ? "release gates N/A (new database)"
      : `release gates ok (${report.releaseGates.applied} migrations applied, ${report.releaseGates.ran.length} gate(s) run, ${report.releaseGates.skipped.length} skipped)`;
  console.log(
    `Pre-deploy check passed: migrator ${report.migrator.user} (${who}), outbox ${outbox}, ${gates}.`,
  );
} catch (error) {
  console.error(
    `Pre-deploy check failed: ${error instanceof MigrationSettingError ? error.message : describe(error)}`,
  );
  process.exitCode = 1;
}
