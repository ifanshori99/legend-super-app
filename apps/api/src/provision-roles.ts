// First-boot database role job (legend-zoqc). Run by an operator on the
// private network after migrations, never by the API or worker:
//   node dist/provision-roles.js          (migrator image, see docs/deployment.md)
//   pnpm --filter @starter/api exec tsx src/provision-roles.ts   (from source)
//
// Reads MIGRATION_DATABASE_URL (owner/admin), APP_DATABASE_URL and
// WORKER_DATABASE_URL. Each may instead be given as NAME_FILE, a path to a
// file holding the URL. Prints role names only, never a URL or password.
// Deliberately does not load .env files: the operator supplies the settings.
import { readFileSync } from "node:fs";
import { databaseError } from "./db/connection";
import { ProvisionError, provisionRoles } from "./db/provision-roles";

function setting(name: string) {
  const direct = process.env[name];
  const file = process.env[`${name}_FILE`];
  if (direct && file)
    throw new ProvisionError(`Set ${name} or ${name}_FILE, not both.`);
  if (file) {
    try {
      return readFileSync(file, "utf8").trim();
    } catch {
      throw new ProvisionError(`Cannot read the file named by ${name}_FILE.`);
    }
  }
  if (!direct) throw new ProvisionError(`${name} is required.`);
  return direct;
}

// Server errors (SQLSTATE) carry PostgreSQL's own message, which can name a
// role or schema but never a password: passwords are sent only as verifiers.
// Anything else falls back to the generic text that never prints a URL.
function describe(error: unknown) {
  if (error instanceof ProvisionError) return error.message;
  const err = error as { code?: unknown; message?: unknown };
  if (
    typeof err.code === "string" &&
    /^[0-9A-Z]{5}$/.test(err.code) &&
    typeof err.message === "string"
  )
    return `${databaseError(error)} PostgreSQL said: ${err.message}`;
  return databaseError(error);
}

try {
  const result = await provisionRoles({
    adminUrl: setting("MIGRATION_DATABASE_URL"),
    appUrl: setting("APP_DATABASE_URL"),
    workerUrl: setting("WORKER_DATABASE_URL"),
  });
  console.log(
    `Application login ${result.app.user} ${result.app.outcome}: member of legend_app only, no BYPASSRLS, owns nothing, no DDL.`,
  );
  if (result.worker)
    console.log(
      `Queue login ${result.worker.user} ${result.worker.outcome}: owns only the pgboss schema, reads app.active_tenant_registry only.`,
    );
  console.log("Restricted database roles are ready.");
} catch (error) {
  console.error(`Role provisioning failed: ${describe(error)}`);
  process.exitCode = 1;
}
