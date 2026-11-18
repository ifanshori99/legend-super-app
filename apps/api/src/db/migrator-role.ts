// Production migrator login (legend-jtnd, brief 88).
//
// Migrations 0000..0064 add foreign keys to tables with FORCE ROW LEVEL
// SECURITY. PostgreSQL validates those under the tenant policy, so a
// non-superuser owner without BYPASSRLS fails with "tenant context is
// required". The dedicated migrator login is the owner of the database (and so
// of every table it creates), has BYPASSRLS and CREATEROLE, and is not a
// superuser. The bootstrap superuser creates it once and is never used again
// by a service.
//
// Passwords reach the server only as SCRAM-SHA-256 verifiers. Messages name
// roles only, never a URL or password. This module imports only `pg`, Node
// built-ins and ./provision-roles.
import { Client, type ClientBase } from "pg";
import {
  APP_LOGIN,
  GRANTOR_LOGIN,
  PASSWORD,
  ProvisionError,
  WORKER_LOGIN,
  parseLogin,
  currentDatabase,
  parseUrl,
  quoteVerifier,
  scramSha256Verifier,
  withAdmin,
} from "./provision-roles";

export const MIGRATOR_LOGIN = /^legend_migrator_[a-f0-9]{16}$/;
// Schemas the migrations create objects in. `pgboss` belongs to the queue
// login and is excluded; `public` itself is owned by pg_database_owner.
const MIGRATED_SCHEMAS = ["public", "app", "drizzle"];
const OWNED_SCHEMAS = ["app", "drizzle"];

function decode(value: string, label: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ProvisionError(`The ${label} login has an invalid encoding.`);
  }
}

/**
 * Refuses when the database was migrated by another login: that login still
 * owns the tables, and the migrator could not alter them.
 */
async function assertOwnedByMigrator(client: ClientBase, migrator: string) {
  const owners = await client.query(
    `SELECT ARRAY(
       SELECT DISTINCT o.owner FROM (
         SELECT pg_get_userbyid(c.relowner)::text AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ANY($2::text[])
         UNION ALL
         SELECT pg_get_userbyid(n.nspowner)::text
         FROM pg_namespace n WHERE n.nspname = ANY($3::text[])
       ) o
       WHERE o.owner <> $1
       ORDER BY 1
     ) AS owners`,
    [migrator, MIGRATED_SCHEMAS, OWNED_SCHEMAS],
  );
  const others: string[] = owners.rows[0].owners;
  if (!others.length) return;
  // PostgreSQL refuses REASSIGN OWNED away from the bootstrap superuser (the
  // role that ran initdb, the postgres image's POSTGRES_USER): its objects
  // "are required by the database system". Such a database can only move
  // object by object, or be recreated while it holds no data.
  const system = await client.query(
    "SELECT rolname FROM pg_roles WHERE oid = 10 AND rolname = ANY($1::text[])",
    [others],
  );
  const advice = system.rows.length
    ? `They include ${system.rows[0].rolname}, the bootstrap superuser, which REASSIGN OWNED cannot move away from. If the database holds no data yet, drop and recreate it, then re-run; otherwise, as that superuser, run ALTER TABLE/SEQUENCE/VIEW/FUNCTION/TYPE ... OWNER TO "${migrator}" for each object and ALTER SCHEMA app, drizzle OWNER TO "${migrator}", then re-run.`
    : `As a superuser run ${others.map((old) => `REASSIGN OWNED BY "${old}" TO "${migrator}"`).join("; ")}, then re-run.`;
  throw new ProvisionError(
    `The database was migrated by another login: tables or schemas in ${MIGRATED_SCHEMAS.join(", ")} are owned by ${others.join(", ")}, not ${migrator}. Nothing was changed. ${advice}`,
  );
}

// Roles are cluster-wide. A non-superuser CREATEROLE login (PostgreSQL 16+)
// may grant, alter or re-key only roles it holds ADMIN OPTION on, which it
// gets implicitly for roles it creates itself. legend_app (drizzle/0001) and
// this deploy's restricted logins may already exist, created by another login
// (an earlier attempt, a superuser). Give the migrator ADMIN on exactly those,
// like the implicit grant: no INHERIT, no SET, so it gains none of their
// privileges and can only manage them. Logins of other databases on the same
// server are never touched: only names from this deploy's env files count.
async function grantAdminOnExistingRoles(
  client: ClientBase,
  migrator: string,
  names: string[],
) {
  const roles = await client.query(
    `SELECT r.rolname FROM pg_roles r
      WHERE r.rolname = ANY($1::text[])
        AND NOT EXISTS (
          SELECT 1 FROM pg_auth_members m
           WHERE m.roleid = r.oid AND m.admin_option
             AND m.member = (SELECT oid FROM pg_roles WHERE rolname = $2))
      ORDER BY 1`,
    [names, migrator],
  );
  // Names are APP_GROUP or validated against APP_LOGIN/WORKER_LOGIN.
  for (const { rolname } of roles.rows as { rolname: string }[])
    await client.query(
      `GRANT "${rolname}" TO "${migrator}" WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`,
    );
}

/**
 * The migrator manages roles but inherits none of them: every membership it
 * holds is ADMIN OPTION only. One exception, made by provisionWorker: SET
 * (never INHERIT) on the queue login, so a non-superuser migrator can hand it
 * the pgboss schema. Checked before any change, so a refusal changes nothing.
 */
async function assertManagesOnly(client: ClientBase, migrator: string) {
  const wider = await client.query(
    `SELECT pg_get_userbyid(m.roleid)::text AS role
       FROM pg_auth_members m
      WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = $1)
        AND (m.inherit_option
             OR (m.set_option AND pg_get_userbyid(m.roleid) !~ $2))
      ORDER BY 1`,
    [migrator, WORKER_LOGIN.source],
  );
  if (wider.rows.length)
    throw new ProvisionError(
      `The migrator login ${migrator} is a member of ${wider.rows.map((r) => r.role).join(", ")} with INHERIT or SET. Nothing was changed. As a superuser, revoke that membership (the migrator should hold ADMIN OPTION only), then re-run.`,
    );
}

/**
 * Creates or updates the migrator login and makes it the database owner, in
 * one transaction under the same advisory lock as the restricted logins, then
 * signs in with `migratorUrl` and confirms what PostgreSQL says. Idempotent.
 */
export async function provisionMigrator(options: {
  bootstrap: { user: string; password: string };
  migratorUrl: string;
  appUrl?: string;
  workerUrl?: string;
  grantorUrl?: string;
}): Promise<{ user: string; outcome: "created" | "updated" }> {
  const { bootstrap } = options;
  const restricted = [
    options.appUrl &&
      parseLogin(options.migratorUrl, options.appUrl, APP_LOGIN, "application")
        .user,
    options.workerUrl &&
      parseLogin(options.migratorUrl, options.workerUrl, WORKER_LOGIN, "queue")
        .user,
    options.grantorUrl &&
      parseLogin(
        options.migratorUrl,
        options.grantorUrl,
        GRANTOR_LOGIN,
        "payout grantor",
      ).user,
  ].filter((name): name is string => !!name);
  const url = parseUrl(options.migratorUrl, "migration");
  const user = decode(url.username, "migration");
  const password = decode(url.password, "migration");
  if (!MIGRATOR_LOGIN.test(user) || !PASSWORD.test(password))
    throw new ProvisionError(
      "The migration login has an invalid name or password format; it must be legend_migrator_<16 hex> with a 48 hex password.",
    );
  if (!bootstrap.user || !bootstrap.password)
    throw new ProvisionError(
      "The bootstrap superuser name and password are required.",
    );
  if (user === bootstrap.user)
    throw new ProvisionError(
      "The migration login is the bootstrap superuser; it needs its own legend_migrator_<16 hex> login.",
    );

  // Same host, port, database and transport settings as the migrator URL,
  // with the bootstrap credentials in place of the migrator's. Encoded so any
  // character in the bootstrap password survives the URL round trip.
  const bootstrapUrl = new URL(options.migratorUrl);
  bootstrapUrl.username = encodeURIComponent(bootstrap.user);
  bootstrapUrl.password = encodeURIComponent(bootstrap.password);

  let committed: { outcome: "created" | "updated"; database: string };
  try {
    committed = await withAdmin(bootstrapUrl.toString(), async (client) => {
      const me = await client.query(
        "SELECT rolsuper FROM pg_roles WHERE rolname = current_user",
      );
      if (!me.rows[0]?.rolsuper)
        throw new ProvisionError(
          "The bootstrap login is not a superuser; check POSTGRES_USER in compose.env.",
        );
      const database = await currentDatabase(client);
      await assertOwnedByMigrator(client, user);
      await assertManagesOnly(client, user);
      const verifier = quoteVerifier(scramSha256Verifier(password));
      const attributes = `LOGIN NOSUPERUSER BYPASSRLS CREATEROLE NOCREATEDB NOREPLICATION INHERIT VALID UNTIL 'infinity' CONNECTION LIMIT -1 PASSWORD ${verifier}`;
      const existing = await client.query(
        "SELECT 1 FROM pg_roles WHERE rolname = $1",
        [user],
      );
      const outcome = existing.rows.length ? "updated" : "created";
      await client.query(
        `${outcome === "created" ? "CREATE" : "ALTER"} ROLE "${user}" ${attributes}`,
      );
      // Undo drift from role-level settings such as search_path or role.
      await client.query(`ALTER ROLE "${user}" RESET ALL`);
      await client.query(
        `ALTER ROLE "${user}" IN DATABASE "${database}" RESET ALL`,
      );
      await client.query(`ALTER DATABASE "${database}" OWNER TO "${user}"`);
      // legend_payout (drizzle/0410) owns the trusted payout functions; the
      // migrator needs ADMIN on it to hand them over (GRANT .. SET TRUE for the
      // length of one migration, REVOKE SET OPTION at its end).
      await grantAdminOnExistingRoles(client, user, [
        "legend_app",
        "legend_payout",
        // The grantor group and login (legend-fwx7l): a bootstrap superuser may
        // have created them, and the non-superuser migrator re-keys the login
        // and adds it to the group only with ADMIN on both.
        "legend_payout_grantor",
        // The proof-read role (drizzle/0481): the migrator grants it to legend_app.
        "legend_payout_recon",
        ...restricted,
      ]);
      return { outcome, database } as const;
    });
  } catch (error) {
    // Fixed text: a bad bootstrap password fails while connecting, before any
    // of our own checks, and the generic hint would name the migration login.
    if ((error as { code?: unknown }).code === "28P01")
      throw new ProvisionError(
        "PostgreSQL rejected the bootstrap superuser login; check POSTGRES_USER and POSTGRES_PASSWORD in compose.env.",
      );
    throw error;
  }
  await verifyMigrator(options.migratorUrl, user, committed.database);
  return { user, outcome: committed.outcome };
}

/**
 * After the transaction commits, sign in with the URL exactly as given and
 * confirm who PostgreSQL says we are and what the login may do.
 */
async function verifyMigrator(url: string, user: string, database: string) {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    const row = (
      await client.query(
        `SELECT current_user AS current, session_user AS session, current_database() AS database,
                r.rolbypassrls, r.rolsuper, r.rolcreaterole,
                (SELECT datdba FROM pg_database WHERE datname = current_database()) = r.oid AS owner
         FROM pg_roles r WHERE r.rolname = current_user`,
      )
    ).rows[0];
    if (
      row?.current !== user ||
      row.session !== user ||
      row.database !== database ||
      row.rolbypassrls !== true ||
      row.rolsuper !== false ||
      row.rolcreaterole !== true ||
      row.owner !== true
    )
      throw new ProvisionError(
        `The migration URL does not sign in as ${user} on ${database} with BYPASSRLS and CREATEROLE, not superuser, owning the database; refusing it.`,
      );
  } catch (error) {
    if (error instanceof ProvisionError) throw error;
    const code = (error as { code?: unknown }).code;
    throw new ProvisionError(
      `Could not sign in with the migration URL as ${user}${typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? ` (SQLSTATE ${code})` : ""}; check its password and host.`,
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}
