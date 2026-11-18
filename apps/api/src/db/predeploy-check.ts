// Read-only checks run before migrations (legend-jtnd, legend-k1np). Used by
// deploy.sh and first-boot provisioning through dist/predeploy-check.js.
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
  ReleaseGateError,
  type ReleaseGateReport,
  runReleaseGates,
} from "./release-gates";

/** An operator-facing failure. Its message never contains a credential. */
export class PredeployCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PredeployCheckError";
  }
}

export type PredeployReport = {
  migrator: { user: string; superuser: boolean; bypassRls: boolean };
  outbox: { present: boolean; rows: number; oldSchemeStreams: number };
  releaseGates: ReleaseGateReport;
};

export type PredeployOptions = {
  log?: (line: string) => void;
  migrationsFolder?: string;
  preflightDir?: string;
};

/**
 * Where the migrations and the rilis1-*.sql gates live. Env wins. Otherwise
 * derive from this file: src/db/ in the repo (tsx, tests), dist/ in the
 * migrator image (WORKDIR /app holds dist/, drizzle/ and scripts/preflight/).
 */
function releaseGatePaths(options: PredeployOptions) {
  const here = dirname(fileURLToPath(import.meta.url));
  const inRepo = basename(here) === "db";
  return {
    migrationsFolder:
      options.migrationsFolder ||
      process.env.LEGEND_MIGRATIONS_DIR ||
      resolve(here, inRepo ? "../../drizzle" : "../drizzle"),
    preflightDir:
      options.preflightDir ||
      process.env.LEGEND_PREFLIGHT_DIR ||
      resolve(
        here,
        inRepo ? "../../../../scripts/preflight" : "../scripts/preflight",
      ),
  };
}

/**
 * Checks that the migration login can migrate (legend-jtnd) and that no
 * outbox stream still uses the old shared per-aggregate sequence (legend-k1np).
 * Then runs the release gate 1 data checks and the migration drift check
 * (legend-1100, db/release-gates.ts). Changes nothing: one connection,
 * read-only transactions that are always rolled back.
 */
export async function runPredeployCheck(
  migrationUrl: string,
  options: PredeployOptions = {},
): Promise<PredeployReport> {
  try {
    new URL(migrationUrl);
  } catch {
    throw new PredeployCheckError(
      "The MIGRATION_DATABASE_URL connection URL is not valid.",
    );
  }
  const client = new Client({
    connectionString: migrationUrl,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    const base = await baseChecks(client);
    try {
      const releaseGates = await runReleaseGates(client, {
        ...releaseGatePaths(options),
        log: options.log,
      });
      return { ...base, releaseGates };
    } catch (error) {
      if (error instanceof ReleaseGateError)
        throw new PredeployCheckError(error.message);
      throw error;
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function baseChecks(
  client: Client,
): Promise<Omit<PredeployReport, "releaseGates">> {
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL search_path = pg_catalog");

    const role = (
      await client.query(
        `SELECT current_user::text AS name, rolsuper, rolbypassrls, rolcreaterole,
                (SELECT datdba FROM pg_database WHERE datname = current_database()) = oid AS owner
           FROM pg_roles WHERE rolname = current_user`,
      )
    ).rows[0];
    if (!role)
      throw new PredeployCheckError(
        "The migration login could not be found in pg_roles.",
      );
    const migrator = {
      user: String(role.name),
      superuser: role.rolsuper === true,
      bypassRls: role.rolbypassrls === true,
    };
    if (!(
      role.rolsuper ||
      (role.rolbypassrls && role.rolcreaterole && role.owner)
    ))
      throw new PredeployCheckError(
        `The migration login ${migrator.user} is neither a superuser nor the database owner with BYPASSRLS and CREATEROLE (legend-jtnd). Migrations add foreign keys to tables with FORCE ROW LEVEL SECURITY, which fail with "tenant context is required" for such a login. Create the migrator login with deploy/single-vm/provision-roles.sh --env-file ... --migrator and put it in MIGRATION_DATABASE_URL.`,
      );

    const present =
      (
        await client.query(
          "SELECT to_regclass('public.domain_event_outbox') AS rel",
        )
      ).rows[0].rel !== null;
    if (!present)
      return {
        migrator,
        outbox: { present: false, rows: 0, oldSchemeStreams: 0 },
      };

    const rows = Number(
      (
        await client.query(
          "SELECT count(*) AS n FROM public.domain_event_outbox",
        )
      ).rows[0].n,
    );
    const old = (
      await client.query(
        `SELECT count(*) AS streams, array_agg(DISTINCT destination::text ORDER BY destination::text) AS destinations
           FROM (
             SELECT destination
               FROM public.domain_event_outbox
              GROUP BY tenant_id, destination, aggregate_type, aggregate_id
             HAVING min(sequence) <> 1 OR max(sequence) <> count(*)
           ) AS broken`,
      )
    ).rows[0];
    const oldSchemeStreams = Number(old.streams);
    if (oldSchemeStreams > 0) {
      const destinations: string[] = old.destinations ?? [];
      throw new PredeployCheckError(
        `The outbox holds ${oldSchemeStreams} stream(s) with old-scheme sequences (legend-k1np), for destination(s): ${destinations.join(", ")}. Sequences are now allocated per destination, so these streams would break consumer ordering. Write and test a backfill, or confirm the consumers start clean and empty the outbox, before enabling the relay.`,
      );
    }
    return { migrator, outbox: { present: true, rows, oldSchemeStreams: 0 } };
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
  }
}
