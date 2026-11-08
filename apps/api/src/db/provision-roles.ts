// Restricted database login provisioning (legend-zoqc, PRD §3 F3, TEN-02).
//
// Runs with the migration/owner connection from a trusted operator job, never
// inside the API or worker. It creates (or re-keys) two LOGIN roles:
//   - the application login, a member of the NOLOGIN `legend_app` group that
//     migrations grant DML on tenant tables (RLS-forced), and
//   - the queue login, which owns only the pg-boss schema and can read the
//     filtered app.active_tenant_registry view.
// Neither may be a superuser, bypass RLS, own domain tables, or create objects
// outside its own schema. Every run re-verifies that, so the job is safe to
// repeat and doubles as an audit.
//
// Passwords are sent as SCRAM-SHA-256 verifiers computed here, so the plaintext
// never reaches the server and cannot appear in its statement or error logs.
// This module imports only `pg` and Node built-ins so the root scripts can load
// it through Node type stripping.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { Client, type ClientBase } from "pg";

const APP_LOGIN = /^legend_runtime_[a-f0-9]{16}$/;
const WORKER_LOGIN = /^legend_worker_[a-f0-9]{16}$/;
const PASSWORD = /^[a-f0-9]{48}$/;
const APP_GROUP = "legend_app";
const QUEUE_SCHEMA = "pgboss";
// Serialises concurrent runs against one database (hashtext is stable).
const LOCK_KEY = "legend.provision-roles";

/** An operator-facing failure. Its message never contains a credential. */
export class ProvisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisionError";
  }
}

type Login = { user: string; password: string };

function parseLogin(
  adminUrl: string,
  loginUrl: string,
  pattern: RegExp,
  label: string,
): Login {
  let url: URL;
  let admin: URL;
  try {
    url = new URL(loginUrl);
    admin = new URL(adminUrl);
  } catch {
    throw new ProvisionError(`The ${label} connection URL is not valid.`);
  }
  if (url.host !== admin.host || url.pathname !== admin.pathname)
    throw new ProvisionError(
      `The ${label} and migration URLs must point to the same database.`,
    );
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (user === decodeURIComponent(admin.username))
    throw new ProvisionError(
      `The ${label} URL uses the migration login; it needs its own restricted login.`,
    );
  if (!pattern.test(user) || !PASSWORD.test(password))
    throw new ProvisionError(
      `The ${label} login has an invalid name or password format.`,
    );
  return { user, password };
}

/**
 * PostgreSQL stores a client-supplied SCRAM verifier as is (RFC 5802/7677,
 * the same derivation libpq's PQencryptPasswordConn performs). Passwords are
 * validated hex, so SASLprep is the identity.
 */
export function scramSha256Verifier(password: string, iterations = 4096) {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

// Identifiers are validated against APP_LOGIN/WORKER_LOGIN before use, and the
// verifier alphabet is base64 plus `$:-`, so neither can break out of quotes.
function quoteVerifier(verifier: string) {
  if (
    !/^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(
      verifier,
    )
  )
    throw new ProvisionError("Could not derive a password verifier.");
  return `'${verifier}'`;
}

async function currentDatabase(client: ClientBase) {
  const name: string = (await client.query("SELECT current_database() AS name"))
    .rows[0].name;
  // Quoted as an identifier below; refuse anything that could break out.
  if (name.includes('"'))
    throw new ProvisionError("The database name cannot be quoted safely.");
  return name;
}

async function upsertLogin(client: ClientBase, login: Login, label: string) {
  const existing = await client.query(
    "SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin FROM pg_roles WHERE rolname = $1",
    [login.user],
  );
  const verifier = quoteVerifier(scramSha256Verifier(login.password));
  if (!existing.rows.length) {
    await client.query(
      `CREATE ROLE "${login.user}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT PASSWORD ${verifier}`,
    );
    return "created";
  }
  const r = existing.rows[0];
  if (
    r.rolsuper ||
    r.rolbypassrls ||
    r.rolcreatedb ||
    r.rolcreaterole ||
    r.rolreplication ||
    !r.rolcanlogin
  )
    throw new ProvisionError(
      `The ${label} role already exists with unsafe privileges; fix or drop it by hand.`,
    );
  // Re-key on every run so the database always matches the env file (this is
  // also how a password is rotated), and undo drift that would stop the login
  // working or change its behaviour: NOINHERIT, an expiry, a connection limit,
  // or role-level settings such as search_path or role.
  await client.query(
    `ALTER ROLE "${login.user}" INHERIT VALID UNTIL 'infinity' CONNECTION LIMIT -1 PASSWORD ${verifier}`,
  );
  await client.query(`ALTER ROLE "${login.user}" RESET ALL`);
  await client.query(
    `ALTER ROLE "${login.user}" IN DATABASE "${await currentDatabase(client)}" RESET ALL`,
  );
  return "updated";
}

/**
 * Fails unless `user` is a plain login whose only power comes from the listed
 * group roles, which owns nothing outside `ownSchemas`, and which can create
 * objects only inside `ownSchemas`.
 */
async function assertRestricted(
  client: ClientBase,
  user: string,
  label: string,
  allowedGroups: string[],
  ownSchemas: string[],
) {
  const unsafe = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_roles r
       WHERE (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
         AND pg_has_role($1, r.oid, 'MEMBER')
     ) AS unsafe`,
    [user],
  );
  if (unsafe.rows[0].unsafe)
    throw new ProvisionError(
      `The ${label} role has or inherits superuser, BYPASSRLS, CREATEDB, CREATEROLE or REPLICATION.`,
    );
  // Predefined roles (pg_read_server_files, pg_execute_server_program,
  // pg_write_all_data, ...) grant powers outside RLS. pg_database_owner only
  // matches the database owner, which these logins never are.
  const predefined = await client.query(
    `SELECT ARRAY(
       SELECT r.rolname::text FROM pg_roles r
       WHERE r.rolname LIKE 'pg\\_%' AND pg_has_role($1, r.oid, 'MEMBER')
       ORDER BY 1
     ) AS roles`,
    [user],
  );
  if (predefined.rows[0].roles.length)
    throw new ProvisionError(
      `The ${label} role has or inherits predefined roles: ${predefined.rows[0].roles.join(", ")}.`,
    );
  const groups = await client.query(
    "SELECT g.rolname FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = $1",
    [user],
  );
  const extra = groups.rows
    .map((row: { rolname: string }) => row.rolname)
    .filter((name: string) => !allowedGroups.includes(name));
  if (extra.length)
    throw new ProvisionError(
      `The ${label} role is a member of unexpected roles: ${extra.join(", ")}.`,
    );
  const owned = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE pg_has_role($1, c.relowner, 'MEMBER')
         AND n.nspname <> ALL($2::text[])
         AND n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'
     ) OR EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE pg_has_role($1, p.proowner, 'MEMBER') AND n.nspname <> ALL($2::text[])
         AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     ) OR EXISTS (
       SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE pg_has_role($1, t.typowner, 'MEMBER') AND n.nspname <> ALL($2::text[])
         AND n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'
     ) OR EXISTS (
       SELECT 1 FROM pg_namespace n
       WHERE pg_has_role($1, n.nspowner, 'MEMBER') AND n.nspname <> ALL($2::text[])
         AND n.nspname NOT LIKE 'pg\\_temp\\_%' AND n.nspname NOT LIKE 'pg\\_toast\\_temp\\_%'
     ) AS owned`,
    [user, ownSchemas],
  );
  if (owned.rows[0].owned)
    throw new ProvisionError(
      `The ${label} role owns tables, functions, types or schemas outside its own; it must not own application objects.`,
    );
  const ddl = await client.query(
    `SELECT has_database_privilege($1, current_database(), 'CREATE') AS database_create,
            ARRAY(
              SELECT n.nspname::text FROM pg_namespace n
              WHERE has_schema_privilege($1, n.oid, 'CREATE')
                AND n.nspname <> ALL($2::text[])
                AND n.nspname NOT LIKE 'pg\\_temp\\_%' AND n.nspname NOT LIKE 'pg\\_toast\\_temp\\_%'
              ORDER BY 1
            ) AS schemas`,
    [user, ownSchemas],
  );
  const { database_create: databaseCreate, schemas } = ddl.rows[0];
  if (databaseCreate || schemas.length)
    throw new ProvisionError(
      `The ${label} role can create objects (${[
        ...(databaseCreate ? ["database"] : []),
        ...schemas.map((schema: string) => `schema ${schema}`),
      ].join(", ")}); revoke CREATE before provisioning.`,
    );
}

/**
 * Table rights outside `ownSchemas` must stay within `allowed` (privilege
 * names per relation, "*" for any relation). TRUNCATE ignores RLS, and
 * TRIGGER/REFERENCES are DDL-adjacent, so none of them may appear.
 */
async function assertTableRights(
  client: ClientBase,
  user: string,
  label: string,
  ownSchemas: string[],
  allowed: Record<string, string[]>,
) {
  const rights = await client.query(
    `SELECT format('%I.%I', n.nspname, c.relname) AS relation, p.privilege
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS p(privilege)
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND n.nspname <> ALL($2::text[])
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'
       AND has_table_privilege($1, c.oid, p.privilege)
     ORDER BY 1, 2`,
    [user, ownSchemas],
  );
  const extra = rights.rows
    .filter(
      (row: { relation: string; privilege: string }) =>
        !(allowed[row.relation] ?? allowed["*"] ?? []).includes(row.privilege),
    )
    .map(
      (row: { relation: string; privilege: string }) =>
        `${row.privilege} on ${row.relation}`,
    );
  if (extra.length)
    throw new ProvisionError(
      `The ${label} role has table rights it must not have: ${extra.slice(0, 5).join(", ")}${extra.length > 5 ? ", ..." : ""}.`,
    );
}

async function withAdmin<T>(
  adminUrl: string,
  work: (client: ClientBase) => Promise<T>,
) {
  const client = new Client({
    connectionString: adminUrl,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      LOCK_KEY,
    ]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function provisionApp(client: ClientBase, login: Login) {
  const group = await client.query(
    "SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin FROM pg_roles WHERE rolname = $1",
    [APP_GROUP],
  );
  if (!group.rows.length)
    throw new ProvisionError(
      `Run the migrations first: the ${APP_GROUP} group role does not exist.`,
    );
  const g = group.rows[0];
  if (
    g.rolsuper ||
    g.rolbypassrls ||
    g.rolcreatedb ||
    g.rolcreaterole ||
    g.rolreplication ||
    g.rolcanlogin
  )
    throw new ProvisionError(
      `The ${APP_GROUP} group role must be NOLOGIN without elevated attributes.`,
    );
  // Before PostgreSQL 15 every role could create in `public`. Revoking is a
  // no-op on newer servers and is verified below either way.
  await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
  const outcome = await upsertLogin(client, login, "application");
  await client.query(`GRANT ${APP_GROUP} TO "${login.user}"`);
  await assertRestricted(client, login.user, "application", [APP_GROUP], []);
  await assertTableRights(client, login.user, "application", [], {
    "*": ["SELECT", "INSERT", "UPDATE", "DELETE"],
  });
  return outcome;
}

async function provisionWorker(client: ClientBase, login: Login) {
  const registry = await client.query(
    "SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'app' AND c.relname = 'active_tenant_registry'",
  );
  if (registry.rows[0]?.relkind !== "v")
    throw new ProvisionError(
      "Run the migrations first: the trusted app.active_tenant_registry view does not exist.",
    );
  const outcome = await upsertLogin(client, login, "queue");
  const owner = await client.query(
    "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1",
    [QUEUE_SCHEMA],
  );
  if (owner.rows.length && owner.rows[0].owner !== login.user)
    throw new ProvisionError(
      "The pg-boss schema is owned by a different role.",
    );
  if (!owner.rows.length) {
    // A non-superuser CREATEROLE admin may only hand an object to a role it
    // can SET ROLE to. On PostgreSQL 16+ creating a role grants ADMIN without
    // SET, so grant SET (never INHERIT) first. Older servers need membership.
    const admin = await client.query(
      "SELECT rolsuper, current_setting('server_version_num')::int AS version FROM pg_roles WHERE rolname = current_user",
    );
    if (!admin.rows[0].rolsuper)
      await client.query(
        admin.rows[0].version >= 160000
          ? `GRANT "${login.user}" TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`
          : `GRANT "${login.user}" TO CURRENT_USER`,
      );
    await client.query(
      `CREATE SCHEMA ${QUEUE_SCHEMA} AUTHORIZATION "${login.user}"`,
    );
  }
  await client.query("REVOKE ALL ON app.active_tenant_registry FROM PUBLIC");
  await client.query(`GRANT USAGE ON SCHEMA app TO "${login.user}"`);
  await client.query(
    `GRANT SELECT ON app.active_tenant_registry TO "${login.user}"`,
  );
  await assertRestricted(client, login.user, "queue", [], [QUEUE_SCHEMA]);
  await assertTableRights(client, login.user, "queue", [QUEUE_SCHEMA], {
    "app.active_tenant_registry": ["SELECT"],
  });
  return outcome;
}

export type ProvisionResult = {
  app: { user: string; outcome: "created" | "updated" };
  worker?: { user: string; outcome: "created" | "updated" };
};

/**
 * Creates or re-keys the restricted logins in one transaction, then verifies
 * them. Idempotent: a second run with the same URLs succeeds and changes only
 * the stored verifier salt.
 */
export async function provisionRoles(options: {
  adminUrl: string;
  appUrl: string;
  workerUrl?: string;
}): Promise<ProvisionResult> {
  const app = parseLogin(
    options.adminUrl,
    options.appUrl,
    APP_LOGIN,
    "application",
  );
  const worker = options.workerUrl
    ? parseLogin(options.adminUrl, options.workerUrl, WORKER_LOGIN, "queue")
    : undefined;
  return withAdmin(options.adminUrl, async (client) => {
    const result: ProvisionResult = {
      app: { user: app.user, outcome: await provisionApp(client, app) },
    };
    if (worker)
      result.worker = {
        user: worker.user,
        outcome: await provisionWorker(client, worker),
      };
    return result;
  });
}

/** Local development and test harness entry point (scripts/*.mjs). */
export async function provisionAppRole(adminUrl: string, appUrl: string) {
  await provisionRoles({
    adminUrl,
    appUrl,
    workerUrl: process.env.WORKER_DATABASE_URL || undefined,
  });
}

/** Queue login only, for callers that manage the application login apart. */
export async function provisionWorkerRole(adminUrl: string, workerUrl: string) {
  const worker = parseLogin(adminUrl, workerUrl, WORKER_LOGIN, "queue");
  await withAdmin(adminUrl, (client) => provisionWorker(client, worker));
}
