// First-boot database role job (legend-zoqc). Run by an operator on the
// private network after migrations, never by the API or worker:
//   node dist/provision-roles.js [--audit | --migrator]   (migrator image, see docs/deployment.md)
//   pnpm --filter @starter/api exec tsx src/provision-roles.ts [--audit | --migrator]
//
// --audit changes nothing: it only verifies the provisioned state (deploy.sh
// runs it after every migration).
//
// --migrator runs once at first boot, before any migration (legend-jtnd): the
// bootstrap superuser (BOOTSTRAP_DATABASE_USER, BOOTSTRAP_DATABASE_PASSWORD)
// creates the legend_migrator_* login named by MIGRATION_DATABASE_URL and makes
// it the database owner, with BYPASSRLS and CREATEROLE, not a superuser.
//
// Reads MIGRATION_DATABASE_URL (owner/admin), APP_DATABASE_URL and
// WORKER_DATABASE_URL and PAYOUT_GRANTOR_DATABASE_URL (the payout step grant
// login, legend-911; required since legend-786te), plus the optional
// MAINTENANCE_DATABASE_URL (the audit retention login, legend-usyi; skipped
// when absent). Each may instead be given as NAME_FILE, a path to a
// file holding the URL (--migrator reads MIGRATION_DATABASE_URL and the two
// BOOTSTRAP_DATABASE_* settings only). Prints role names only, never a URL or password.
// Deliberately does not load .env files: the operator supplies the settings.
import { readFileSync } from "node:fs";
import { provisionMigrator } from "./db/migrator-role";
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

// Optional setting: absent means "not provisioned", not an error.
function optionalSetting(name: string) {
  return process.env[name] || process.env[`${name}_FILE`]
    ? setting(name)
    : undefined;
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
const migrator = args.length === 1 && args[0] === "--migrator";

try {
  if (args.length && !audit && !migrator)
    throw new ProvisionError("Usage: provision-roles [--audit | --migrator]");
  if (migrator) {
    const result = await provisionMigrator({
      bootstrap: {
        user: setting("BOOTSTRAP_DATABASE_USER"),
        password: setting("BOOTSTRAP_DATABASE_PASSWORD"),
      },
      migratorUrl: setting("MIGRATION_DATABASE_URL"),
      // Optional: the restricted logins of this deploy, so the migrator can
      // re-key them if they already exist (never logins of other databases).
      appUrl: process.env.APP_DATABASE_URL || undefined,
      workerUrl: process.env.WORKER_DATABASE_URL || undefined,
    });
    console.log(
      `Migrator login ${result.user} ${result.outcome}: owns the database, BYPASSRLS, CREATEROLE, not superuser.`,
    );
  } else if (audit) {
    const result = await auditRoles({
      adminUrl: setting("MIGRATION_DATABASE_URL"),
      appUrl: setting("APP_DATABASE_URL"),
      workerUrl: setting("WORKER_DATABASE_URL"),
      maintenanceUrl: optionalSetting("MAINTENANCE_DATABASE_URL"),
      grantorUrl: setting("PAYOUT_GRANTOR_DATABASE_URL"),
    });
    console.log(
      `Audit passed for ${[result.app, result.worker, result.maintenance, result.grantor].filter(Boolean).join(", ")}; nothing was changed.`,
    );
  } else {
    const result = await provisionRoles({
      adminUrl: setting("MIGRATION_DATABASE_URL"),
      appUrl: setting("APP_DATABASE_URL"),
      workerUrl: setting("WORKER_DATABASE_URL"),
      maintenanceUrl: optionalSetting("MAINTENANCE_DATABASE_URL"),
      grantorUrl: setting("PAYOUT_GRANTOR_DATABASE_URL"),
    });
    console.log(
      `Application login ${result.app.user} ${result.app.outcome}: member of legend_app only, no BYPASSRLS, owns nothing, no DDL.`,
    );
    if (result.worker)
      console.log(
        `Queue login ${result.worker.user} ${result.worker.outcome}: owns only the pgboss schema, reads app.active_tenant_registry only.`,
      );
    if (result.maintenance)
      console.log(
        `Maintenance login ${result.maintenance.user} ${result.maintenance.outcome}: member of legend_maintenance only, no table rights, runs only the two audit retention functions.`,
      );
    if (result.grantor)
      console.log(
        `Payout grantor login ${result.grantor.user} ${result.grantor.outcome}: member of legend_payout_grantor only, no table rights, runs only app.payout_grant_issue.`,
      );
    console.log("Restricted database roles are ready.");
  }
} catch (error) {
  console.error(
    `Role ${audit ? "audit" : "provisioning"} failed: ${describe(error)}`,
  );
  process.exitCode = 1;
}
