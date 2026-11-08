// First-boot database role job (legend-zoqc). Run by an operator on the
// private network after migrations, never by the API or worker:
//   node dist/provision-roles.js [--audit]   (migrator image, see docs/deployment.md)
//   pnpm --filter @starter/api exec tsx src/provision-roles.ts [--audit]
//
// --audit changes nothing: it only verifies the provisioned state (deploy.sh
// runs it after every migration).
//
// Reads MIGRATION_DATABASE_URL (owner/admin), APP_DATABASE_URL and
// WORKER_DATABASE_URL. Each may instead be given as NAME_FILE, a path to a
// file holding the URL. Prints role names only, never a URL or password.
// Deliberately does not load .env files: the operator supplies the settings.
import { readFileSync } from "node:fs";
import {
  ProvisionError,
  auditRoles,
  provisionRoles,
} from "./db/provision-roles";

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

// The job runs on the VM next to the database, so hints point there, never
// at local development. Server errors (SQLSTATE) carry PostgreSQL's own
// message, which can name a role or schema but never a password: passwords
// are sent only as verifiers. Anything else gets a fixed text: error messages
// from the network stack or pg can quote the connection string.
const NETWORK: Record<string, string> = {
  ECONNREFUSED:
    "PostgreSQL refused the connection. Check that the postgres service is running and healthy (docker compose ps) and that MIGRATION_DATABASE_URL names its host and port.",
  ENOTFOUND:
    "The PostgreSQL host in MIGRATION_DATABASE_URL could not be resolved. Run the job on the private network next to the postgres service.",
  EAI_AGAIN:
    "The PostgreSQL host in MIGRATION_DATABASE_URL could not be resolved. Run the job on the private network next to the postgres service.",
  ETIMEDOUT:
    "The connection to PostgreSQL timed out. Check that the job runs on the private network next to the postgres service.",
};
const SERVER: Record<string, string> = {
  "28P01":
    "PostgreSQL rejected the migration login; check the user and password in MIGRATION_DATABASE_URL.",
  "3D000": "The database named in MIGRATION_DATABASE_URL does not exist.",
};

function describe(error: unknown) {
  if (error instanceof ProvisionError) return error.message;
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
  return "Unexpected error. Connection strings are not printed; check the URLs and that PostgreSQL is reachable.";
}

const args = process.argv.slice(2);
const audit = args.length === 1 && args[0] === "--audit";

try {
  if (args.length && !audit)
    throw new ProvisionError("Usage: provision-roles [--audit]");
  if (audit) {
    const result = await auditRoles({
      adminUrl: setting("MIGRATION_DATABASE_URL"),
      appUrl: setting("APP_DATABASE_URL"),
      workerUrl: setting("WORKER_DATABASE_URL"),
    });
    console.log(
      `Audit passed for ${result.app} and ${result.worker}; nothing was changed.`,
    );
  } else {
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
  }
} catch (error) {
  console.error(
    `Role ${audit ? "audit" : "provisioning"} failed: ${describe(error)}`,
  );
  process.exitCode = 1;
}
