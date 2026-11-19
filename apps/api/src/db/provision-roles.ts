// Restricted database login provisioning (legend-zoqc, PRD §3 F3, TEN-02).
//
// Runs with the migration/owner connection from a trusted operator job, never
// inside the API or worker. It creates (or re-keys) up to three LOGIN roles:
//   - the application login, a member of the NOLOGIN `legend_app` group that
//     migrations grant DML on tenant tables (RLS-forced),
//   - the queue login, which owns only the pg-boss schema and can read the
//     filtered app.active_tenant_registry view, and
//   - the optional maintenance login (legend-usyi), a member of the NOLOGIN
//     `legend_maintenance` group only: no table rights, it may run just the two
//     audit retention functions (SECURITY DEFINER, owned by the table owner), and
//   - the optional payout grantor login (legend-911), a member of the NOLOGIN
//     `legend_payout_grantor` group only: no table rights, it may run just
//     app.payout_grant_issue (SECURITY DEFINER, owned by `legend_payout`), and
//   - the optional frozen-column re-seal login (legend-qwm9r), the only member of
//     the NOLOGIN `legend_sealed_reseal` group (INHERIT, never SET): no table
//     rights, it may run just app.reseal_frozen_sealed.
// None may be a superuser, bypass RLS, own domain tables, or create objects
// outside its own schema. Every run re-verifies that, so the job is safe to
// repeat and doubles as an audit.
//
// PostgreSQL 16 or newer is required: role memberships record INHERIT, SET
// and ADMIN per grant there, and the audit relies on that.
//
// Passwords are sent as SCRAM-SHA-256 verifiers computed here, so the plaintext
// never reaches the server and cannot appear in its statement or error logs.
// This module imports only `pg` and Node built-ins so the root scripts can load
// it through Node type stripping.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { Client, type ClientBase } from "pg";

export const APP_LOGIN = /^legend_runtime_[a-f0-9]{16}$/;
export const WORKER_LOGIN = /^legend_worker_[a-f0-9]{16}$/;
export const MAINT_LOGIN = /^legend_maint_[a-f0-9]{16}$/;
export const GRANTOR_LOGIN = /^legend_grant_[a-f0-9]{16}$/;
export const RESEAL_LOGIN = /^legend_reseal_[a-f0-9]{16}$/;
export const PASSWORD = /^[a-f0-9]{48}$/;
const APP_GROUP = "legend_app";
const MAINT_GROUP = "legend_maintenance";
// The only routines the maintenance group may run (migration 0187).
const MAINT_FUNCTIONS = [
  "app.audit_retention_due_tenants()",
  "app.purge_audit_retention_batch(uuid, integer)",
];
// legend_app may SET ROLE to it (INHERIT FALSE, drizzle/0481): the only role that
// may record an 'ok' observation of a proof file. Reached, never inherited.
const RECON_GROUP = "legend_payout_recon";
// The only role that may run app.reseal_frozen_sealed, which re-seals the four
// frozen sealed columns (legend-4vfmn, legend-49onu, legend-qwm9r). Its one
// member is the dedicated legend_reseal_* login (INHERIT TRUE, SET FALSE, no
// ADMIN); legend_app and the other logins are not members and cannot SET ROLE to
// it (drizzle/0508). It holds no table rights.
const SEALED_RESEAL_GROUP = "legend_sealed_reseal";
const SEALED_RESEAL_FUNCTION =
  "app.reseal_frozen_sealed(text, text, uuid, uuid, text, text)";
const RESEAL_FUNCTIONS = [SEALED_RESEAL_FUNCTION];
const RESEAL_LABEL = "frozen-column re-seal";
const GRANTOR_GROUP = "legend_payout_grantor";
const PAYOUT_OWNER = "legend_payout";
// The only routine the grantor group may run (migration 0419).
const GRANTOR_FUNCTIONS = [
  "app.payout_grant_issue(text, text, uuid, uuid[], character varying, uuid, uuid, character varying, text, text, text)",
];
const QUEUE_SCHEMA = "pgboss";
// Serialises concurrent runs against one database (hashtext is stable).
const LOCK_KEY = "legend.provision-roles";
const MIN_SERVER_VERSION = 160000;
// pg lets query parameters override the URL's authority (user, password,
// host, port, database, options). Only transport settings may appear, so the
// login and endpoint validated below are the ones pg actually uses.
const URL_PARAMS = new Set([
  "sslmode",
  "sslrootcert",
  "sslcert",
  "sslkey",
  "ssl",
  "channel_binding",
  "application_name",
  "connect_timeout",
]);
const APP_TABLE_RIGHTS = ["SELECT", "INSERT", "UPDATE", "DELETE"];
// nextval()/currval() for serial columns; never UPDATE (setval).
const APP_SEQUENCE_RIGHTS = ["USAGE", "SELECT"];
// Catalogs with an owner column: [catalog, owner column, namespace column].
const OWNED_CATALOGS: [string, string, string | null][] = [
  ["pg_class", "relowner", "relnamespace"],
  ["pg_proc", "proowner", "pronamespace"],
  ["pg_type", "typowner", "typnamespace"],
  ["pg_operator", "oprowner", "oprnamespace"],
  ["pg_opclass", "opcowner", "opcnamespace"],
  ["pg_opfamily", "opfowner", "opfnamespace"],
  ["pg_collation", "collowner", "collnamespace"],
  ["pg_conversion", "conowner", "connamespace"],
  ["pg_statistic_ext", "stxowner", "stxnamespace"],
  ["pg_ts_config", "cfgowner", "cfgnamespace"],
  ["pg_ts_dict", "dictowner", "dictnamespace"],
  ["pg_extension", "extowner", null],
  ["pg_event_trigger", "evtowner", null],
  ["pg_foreign_data_wrapper", "fdwowner", null],
  ["pg_foreign_server", "srvowner", null],
  ["pg_largeobject_metadata", "lomowner", null],
  ["pg_publication", "pubowner", null],
];
// Objects no restricted login may reach by any path, PUBLIC included: the
// password verifiers, foreign-server passwords, raw statistics and large
// objects, and functions that read the server's files or control the server.
// An explicit list instead of a per-version copy of PostgreSQL's default
// catalog ACLs: short, reviewable, and the same on every major version.
const SENSITIVE_TABLES = [
  "pg_authid",
  "pg_shadow",
  "pg_user_mapping",
  "pg_statistic",
  "pg_statistic_ext_data",
  "pg_largeobject",
];
// legend-2ywn: built-in functions are not a denylist. The baseline is the
// server's own initial privileges (pg_init_privs, privtype 'i', recorded by
// initdb and not touched by later GRANT/REVOKE): a pg_catalog function whose
// initial ACL leaves out PUBLIC EXECUTE (pg_switch_wal, pg_read_file,
// lo_import, ...) fails the audit when the login can run it, directly or
// through PUBLIC. A function without an initial ACL is PUBLIC by default and
// is never flagged. The same baseline covers extension functions (privtype
// 'e', any schema: pg_stat_statements_reset, pg_buffercache_*, ...) and
// pg_catalog columns (a column whose initial table and column ACLs leave out
// PUBLIC, such as pg_subscription.subconninfo).
// Tables with a tenant_id that are deliberately not under the restrictive
// tenant policy (the same list as apps/api/src/db/rls.test.ts, which explains
// each). The first three must still keep row-level security enabled: their
// write policies are what stop cross-tenant writes (delivery_store_index has
// no policy at all and no app-role grant; it is read only through
// app.resolve_delivery_store: approved for review by CTO pending, WS-08 D3).
const TENANT_RLS_EXCEPTIONS: Record<string, { rowSecurity: boolean }> = {
  "public.tenant_domains": { rowSecurity: true },
  "public.payment_link_tokens": { rowSecurity: true },
  "public.delivery_store_index": { rowSecurity: true },
  // legend-111j: id-only (user, tenant, profile, status) index read only
  // through app.member_profiles_of_user for the cross-tenant identity merge;
  // no policy and no app-role grant (pattern of delivery_store_index).
  "public.member_profile_user_index": { rowSecurity: true },
  "public.session": { rowSecurity: false },
  "public.login_challenges": { rowSecurity: false },
  "public.wa_inbound_messages": { rowSecurity: false },
};
const TENANT_PREDICATE = "(tenant_id = app.require_tenant_id())";

/** An operator-facing failure. Its message never contains a credential. */
export class ProvisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisionError";
  }
}

type Login = { user: string; password: string; url: string };

export function parseUrl(raw: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProvisionError(`The ${label} connection URL is not valid.`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
    throw new ProvisionError(
      `The ${label} connection URL must start with postgresql://.`,
    );
  if (url.hash)
    throw new ProvisionError(
      `The ${label} connection URL must not contain a # fragment.`,
    );
  for (const key of url.searchParams.keys())
    if (!URL_PARAMS.has(key))
      throw new ProvisionError(
        `The ${label} connection URL has a query parameter that is not allowed (${/^[a-z_]{1,40}$/.test(key) ? key : "unrecognised"}); only TLS and timeout settings may follow "?". Put the login, host and database in the URL itself.`,
      );
  return url;
}

export function parseLogin(
  adminUrl: string,
  loginUrl: string,
  pattern: RegExp,
  label: string,
): Login {
  const url = parseUrl(loginUrl, label);
  const admin = parseUrl(adminUrl, "migration");
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
  return { user, password, url: loginUrl };
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
export function quoteVerifier(verifier: string) {
  if (
    !/^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(
      verifier,
    )
  )
    throw new ProvisionError("Could not derive a password verifier.");
  return `'${verifier}'`;
}

async function serverVersion(client: ClientBase): Promise<number> {
  return (
    await client.query(
      "SELECT current_setting('server_version_num')::int AS version",
    )
  ).rows[0].version;
}

export async function currentDatabase(client: ClientBase) {
  const name: string = (await client.query("SELECT current_database() AS name"))
    .rows[0].name;
  // Quoted as an identifier below; refuse anything that could break out.
  if (name.includes('"'))
    throw new ProvisionError("The database name cannot be quoted safely.");
  return name;
}

// An idle open transaction pins pg_snapshot_xmin and stops edge catalog and PIN
// sync for every outlet (legend-9h0kg), so the runtime logins get a timeout.
const IDLE_TX_SETTING = "idle_in_transaction_session_timeout";
const IDLE_TX_TIMEOUT = "5min";

async function setIdleTxTimeout(client: ClientBase, user: string) {
  await client.query(
    `ALTER ROLE "${user}" SET ${IDLE_TX_SETTING} = '${IDLE_TX_TIMEOUT}'`,
  );
}

async function upsertLogin(
  client: ClientBase,
  login: Login,
  label: string,
  idleTxTimeout = false,
) {
  const existing = await client.query(
    "SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin FROM pg_roles WHERE rolname = $1",
    [login.user],
  );
  const verifier = quoteVerifier(scramSha256Verifier(login.password));
  if (!existing.rows.length) {
    await client.query(
      `CREATE ROLE "${login.user}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT VALID UNTIL 'infinity' CONNECTION LIMIT -1 PASSWORD ${verifier}`,
    );
    if (idleTxTimeout) {
      await setIdleTxTimeout(client, login.user);
      await assertNoSettings(client, login.user, label, "required");
    }
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
  // RESET ALL above removes this too, so set it again after the reset.
  if (idleTxTimeout) await setIdleTxTimeout(client, login.user);
  await assertNoSettings(
    client,
    login.user,
    label,
    idleTxTimeout ? "required" : "none",
  );
  return "updated";
}

// A non-superuser admin silently keeps superuser-only settings (for example
// session_replication_role) after RESET ALL, so prove none are left. The idle
// transaction timeout is the one setting provisioning itself sets, and only on
// the application and queue logins (`idleTxTimeout`): there it must be exactly
// IDLE_TX_TIMEOUT and present (`"required"`; the audit uses it too). On any other
// login, including the maintenance login, every setting counts as left over.
async function assertNoSettings(
  client: ClientBase,
  user: string,
  label: string,
  idleTxTimeout: "none" | "required" = "none",
) {
  const { rows } = await client.query<{ config: string }>(
    `SELECT c AS config
     FROM pg_db_role_setting s, unnest(s.setconfig) AS c
     WHERE s.setrole = (SELECT oid FROM pg_roles WHERE rolname = $1)
       AND s.setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))`,
    [user],
  );
  let timeoutSeen = false;
  let left = 0;
  for (const { config } of rows) {
    const at = config.indexOf("=");
    const name = at < 0 ? config : config.slice(0, at);
    const value = at < 0 ? "" : config.slice(at + 1);
    if (
      idleTxTimeout !== "none" &&
      name === IDLE_TX_SETTING &&
      value === IDLE_TX_TIMEOUT
    )
      timeoutSeen = true;
    else left += 1;
  }
  if (left)
    throw new ProvisionError(
      `The ${label} role has role-level settings this login cannot reset; a superuser must run ALTER ROLE ... RESET ALL.`,
    );
  if (idleTxTimeout === "required" && !timeoutSeen)
    throw new ProvisionError(
      `The ${label} role does not have ${IDLE_TX_SETTING} = '${IDLE_TX_TIMEOUT}' after provisioning; re-run provision-roles.sh.`,
    );
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
  // Any role reached directly or through a group (legend_app granted some
  // other role, with or without ADMIN OPTION) widens the login beyond its
  // lane. ADMIN OPTION always rides on a membership, so this also rules out
  // inherited ADMIN.
  const reached = await client.query(
    `SELECT ARRAY(
       SELECT r.rolname::text FROM pg_roles r
       WHERE r.rolname <> $1 AND r.rolname <> ALL($2::text[])
         AND pg_has_role($1, r.oid, 'MEMBER')
       ORDER BY 1
     ) AS roles`,
    [user, allowedGroups],
  );
  if (reached.rows[0].roles.length)
    throw new ProvisionError(
      `The ${label} role is a member of unexpected roles (directly or through a group): ${reached.rows[0].roles.join(", ")}.`,
    );
  // INHERIT is recorded per grant: a membership without it gives the login
  // no privileges. ADMIN would let the login hand the group out.
  const groups = await client.query(
    `SELECT g.rolname, pg_get_userbyid(m.grantor) AS grantor, m.admin_option, m.inherit_option AS inherit
     FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
     WHERE u.rolname = $1`,
    [user],
  );
  const flawed = groups.rows
    .filter(
      (row: { admin_option: boolean; inherit: boolean }) =>
        row.admin_option || !row.inherit,
    )
    .map(
      (row: { rolname: string; grantor: string }) =>
        `${row.rolname} (granted by ${row.grantor})`,
    );
  if (flawed.length)
    throw new ProvisionError(
      `The ${label} role's membership in ${flawed.join(", ")} must have INHERIT and no ADMIN OPTION; a superuser can remove it with REVOKE <group> FROM <login> GRANTED BY <grantor>, then re-run.`,
    );
  // Catalog objects belong to the bootstrap superuser, so no schema is exempt
  // except session temp schemas (a live session's own temp tables): a login
  // owning anything else outside its own schemas is drift.
  const ownedBy = OWNED_CATALOGS.map(
    ([catalog, owner, namespace]) =>
      `EXISTS (SELECT 1 FROM ${catalog} o${namespace ? ` JOIN pg_namespace n ON n.oid = o.${namespace}` : ""}
               WHERE pg_has_role($1, o.${owner}, 'MEMBER')${namespace ? " AND n.nspname <> ALL($2::text[]) AND n.nspname NOT LIKE 'pg\\_temp\\_%' AND n.nspname NOT LIKE 'pg\\_toast%'" : ""})`,
  );
  const owned = await client.query(
    `SELECT ${ownedBy.join(" OR ")} OR EXISTS (
       SELECT 1 FROM pg_namespace n
       WHERE pg_has_role($1, n.nspowner, 'MEMBER') AND n.nspname <> ALL($2::text[])
         AND n.nspname NOT LIKE 'pg\\_temp\\_%' AND n.nspname NOT LIKE 'pg\\_toast\\_temp\\_%'
     ) AS owned`,
    [user, ownSchemas],
  );
  if (owned.rows[0].owned)
    throw new ProvisionError(
      `The ${label} role owns tables, functions, types, schemas or other objects outside its own; it must not own application objects.`,
    );
  // Built-in functions PUBLIC cannot run (pg_read_file, lo_import, ...)
  // reach the server's files or other sessions, outside RLS.
  const functions = await client.query(
    `SELECT ARRAY(
       SELECT DISTINCT p.proname::text FROM pg_proc p
       WHERE p.pronamespace = 'pg_catalog'::regnamespace
         AND has_function_privilege($1, p.oid, 'EXECUTE')
         AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
       ORDER BY 1
     ) AS names`,
    [user],
  );
  if (functions.rows[0].names.length)
    throw new ProvisionError(
      `The ${label} role may run built-in functions PUBLIC cannot: ${functions.rows[0].names.slice(0, 5).join(", ")}${functions.rows[0].names.length > 5 ? ", ..." : ""}.`,
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
 * names per relation, "*" for any relation). TRUNCATE ignores RLS,
 * TRIGGER/REFERENCES are DDL-adjacent and MAINTAIN (PostgreSQL 17+) runs
 * REINDEX/CLUSTER/REFRESH, so none of them may appear. A grant on a single
 * column counts as the privilege on its table. `queueOnly` narrows the check
 * to relations in the queue schema (see assertNoQueueSchemaAccess).
 */
async function assertTableRights(
  client: ClientBase,
  user: string,
  label: string,
  ownSchemas: string[],
  allowed: Record<string, string[]>,
  queueOnly = false,
) {
  const privileges = [
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "TRUNCATE",
    "REFERENCES",
    "TRIGGER",
    ...((await serverVersion(client)) >= 170000 ? ["MAINTAIN"] : []),
  ];
  const rights = await client.query(
    `SELECT format('%I.%I', n.nspname, c.relname) AS relation, p.privilege,
            n.nspname IN ('pg_catalog', 'information_schema') AS system
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN unnest($3::text[]) AS p(privilege)
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND n.nspname <> ALL($2::text[])
       AND ($4::text IS NULL OR n.nspname = $4)
       AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'
       AND CASE
         -- System catalogs: only what goes beyond PUBLIC's own rights (a
         -- grant on pg_authid or one of its columns is a leak, reading
         -- pg_class is not).
         WHEN n.nspname IN ('pg_catalog', 'information_schema') THEN
           (has_table_privilege($1, c.oid, p.privilege)
            AND NOT has_table_privilege('public', c.oid, p.privilege))
           OR EXISTS (
             SELECT 1 FROM pg_attribute a
             WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
               AND CASE WHEN p.privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                        THEN has_column_privilege($1, c.oid, a.attnum, p.privilege)
                             AND NOT has_column_privilege('public', c.oid, a.attnum, p.privilege)
                        ELSE false END)
         WHEN p.privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
           THEN has_any_column_privilege($1, c.oid, p.privilege)
         ELSE has_table_privilege($1, c.oid, p.privilege) END
       -- Extension views such as pg_stat_statements are readable by PUBLIC by
       -- design; that is not a right of this login. Only extension-owned
       -- relations are exempt, never application tables granted to PUBLIC.
       AND NOT (
         p.privilege = 'SELECT'
         AND EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = 0 AND a.privilege_type = 'SELECT')
         AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
       )
     ORDER BY 1, 2`,
    [user, ownSchemas, privileges, queueOnly ? QUEUE_SCHEMA : null],
  );
  // "*" covers application relations only; a system catalog right beyond
  // PUBLIC's is never allowed unless listed by name.
  const extra = rights.rows
    .filter(
      (row: { relation: string; privilege: string; system: boolean }) =>
        !(
          allowed[row.relation] ??
          (row.system ? undefined : allowed["*"]) ??
          []
        ).includes(row.privilege),
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

/**
 * Sequence rights outside `ownSchemas` must stay within `allowed`. UPDATE
 * means setval(), which can push a sequence to its end and break every
 * insert that draws from it.
 */
async function assertSequenceRights(
  client: ClientBase,
  user: string,
  label: string,
  ownSchemas: string[],
  allowed: string[],
) {
  const rights = await client.query(
    `SELECT format('%I.%I', n.nspname, c.relname) AS relation, p.privilege
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) AS p(privilege)
     WHERE c.relkind = 'S'
       AND n.nspname <> ALL($2::text[])
       AND n.nspname NOT LIKE 'pg\\_temp\\_%'
       AND has_sequence_privilege($1, c.oid, p.privilege)
     ORDER BY 1, 2`,
    [user, ownSchemas],
  );
  const extra = rights.rows
    .filter((row: { privilege: string }) => !allowed.includes(row.privilege))
    .map(
      (row: { relation: string; privilege: string }) =>
        `${row.privilege} on ${row.relation}`,
    );
  if (extra.length)
    throw new ProvisionError(
      `The ${label} role has sequence rights it must not have: ${extra.slice(0, 5).join(", ")}${extra.length > 5 ? ", ..." : ""}.`,
    );
}

/**
 * The sensitive tables above and the built-in function baseline, checked on
 * the login's effective rights, so a grant to PUBLIC counts the same as a
 * grant to the login.
 */
async function assertNoSensitive(
  client: ClientBase,
  user: string,
  label: string,
) {
  // The audit below reads the initdb baseline from pg_init_privs. If that
  // baseline is empty or incomplete (for example after a restore that dropped
  // it), the audit would match nothing and pass. Fail closed: require every
  // overload of a few known-revoked functions to have a baseline entry without
  // PUBLIC EXECUTE before trusting it.
  const anchor = await client.query(
    `SELECT a.name
     FROM unnest(ARRAY['pg_read_file', 'lo_import', 'pg_switch_wal']) AS a(name)
     WHERE NOT EXISTS (
             SELECT 1 FROM pg_catalog.pg_proc f
             WHERE f.pronamespace = 'pg_catalog'::regnamespace AND f.proname = a.name)
        OR EXISTS (
             SELECT 1 FROM pg_catalog.pg_proc f
             WHERE f.pronamespace = 'pg_catalog'::regnamespace AND f.proname = a.name
               AND NOT EXISTS (
                 SELECT 1 FROM pg_catalog.pg_init_privs ip
                 WHERE ip.classoid = 'pg_catalog.pg_proc'::regclass
                   AND ip.objoid = f.oid AND ip.objsubid = 0 AND ip.privtype = 'i'
                   AND NOT EXISTS (
                     SELECT 1 FROM pg_catalog.aclexplode(ip.initprivs) x
                     WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE')))
     ORDER BY 1`,
  );
  if (anchor.rows.length)
    throw new ProvisionError(
      `Cannot audit the ${label} role: the built-in function baseline (pg_init_privs) is empty or incomplete for ${anchor.rows.map((row: { name: string }) => row.name).join(", ")}, so sensitive functions could not be told apart. Restore the baseline or re-initialise the cluster, then re-run.`,
    );
  // Same for the extension baseline (privtype 'e', recorded when an extension
  // script runs GRANT/REVOKE): pg_stat_statements_reset() is revoked from
  // PUBLIC by its script, so an installed pg_stat_statements without that entry
  // means the baseline is lost and extension functions could not be told apart.
  const extensionAnchor = await client.query(
    `SELECT f.oid::regprocedure::text AS name
     FROM pg_catalog.pg_proc f
     JOIN pg_catalog.pg_depend d
       ON d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = f.oid AND d.deptype = 'e'
     JOIN pg_catalog.pg_extension e
       ON d.refclassid = 'pg_catalog.pg_extension'::regclass AND e.oid = d.refobjid
     WHERE e.extname = 'pg_stat_statements' AND f.proname = 'pg_stat_statements_reset'
       AND NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_init_privs ip
         WHERE ip.classoid = 'pg_catalog.pg_proc'::regclass
           AND ip.objoid = f.oid AND ip.objsubid = 0 AND ip.privtype = 'e'
           AND NOT EXISTS (
             SELECT 1 FROM pg_catalog.aclexplode(ip.initprivs) x
             WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE'))
     ORDER BY 1`,
  );
  if (extensionAnchor.rows.length)
    throw new ProvisionError(
      `Cannot audit the ${label} role: the extension function baseline (pg_init_privs) is empty or incomplete for ${extensionAnchor.rows.map((row: { name: string }) => row.name).join(", ")}, so sensitive extension functions could not be told apart. Re-create the extension, then re-run.`,
    );
  const reached = await client.query(
    `SELECT ARRAY(
       SELECT format('%s on pg_catalog.%I', p.privilege, c.relname)
       FROM pg_class c
       CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p(privilege)
       WHERE c.relnamespace = 'pg_catalog'::regnamespace AND c.relname = ANY($2::text[])
         AND CASE WHEN p.privilege = 'DELETE'
                  THEN has_table_privilege($1, c.oid, 'DELETE')
                  ELSE has_any_column_privilege($1, c.oid, p.privilege) END
       UNION ALL
       SELECT DISTINCT format('%s on pg_catalog.%I.%I', p.privilege, c.relname, a.attname)
       FROM pg_class c
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) AS p(privilege)
       WHERE c.relnamespace = 'pg_catalog'::regnamespace
         AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND c.relname <> ALL($2::text[])
         AND has_column_privilege($1, c.oid, a.attnum, p.privilege)
         AND NOT EXISTS (
           SELECT 1
           FROM pg_catalog.pg_init_privs ip
           CROSS JOIN LATERAL pg_catalog.aclexplode(ip.initprivs) x
           WHERE ip.classoid = 'pg_catalog.pg_class'::regclass
             AND ip.objoid = c.oid AND ip.privtype = 'i'
             AND ip.objsubid IN (0, a.attnum)
             AND x.grantee = 0 AND x.privilege_type = p.privilege)
       UNION ALL
       SELECT DISTINCT format('EXECUTE on %I.%I', n.nspname, f.proname)
       FROM pg_proc f JOIN pg_namespace n ON n.oid = f.pronamespace
       WHERE (EXISTS (
                SELECT 1 FROM pg_catalog.pg_init_privs ip
                WHERE ip.classoid = 'pg_catalog.pg_proc'::regclass
                  AND ip.objoid = f.oid AND ip.objsubid = 0
                  AND (ip.privtype = 'e'
                       OR (ip.privtype = 'i' AND n.nspname = 'pg_catalog'))
                  AND NOT EXISTS (
                    SELECT 1 FROM pg_catalog.aclexplode(ip.initprivs) x
                    WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE'))
              OR f.proname LIKE 'dblink%')
         AND has_function_privilege($1, f.oid, 'EXECUTE')
       ORDER BY 1
     ) AS objects`,
    [user, SENSITIVE_TABLES],
  );
  const objects: string[] = reached.rows[0].objects;
  if (objects.length)
    throw new ProvisionError(
      `The ${label} role can reach sensitive server objects (directly or through PUBLIC): ${objects.slice(0, 5).join(", ")}${objects.length > 5 ? ", ..." : ""}. Revoke the grant, then re-run.`,
    );
}

/**
 * SET on a parameter only a superuser may change (session_replication_role
 * skips triggers and foreign keys) or ALTER SYSTEM on any parameter is a
 * superuser power. Grants are read from pg_parameter_acl, so a grant on a
 * parameter no loaded module defines yet is caught too (it is refused: the
 * module may make it superuser-only). Only a grant reaches the login: no
 * parameter ACL row means no privilege.
 */
async function assertNoParameterGrants(
  client: ClientBase,
  user: string,
  label: string,
) {
  // pg_parameter_acl exists from PostgreSQL 15.
  if ((await serverVersion(client)) < 150000) return;
  const granted = await client.query(
    `SELECT ARRAY(
       SELECT format('%s on %s (granted to %s)', x.privilege_type, a.parname,
                     CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END)
       FROM pg_catalog.pg_parameter_acl a
       CROSS JOIN LATERAL pg_catalog.aclexplode(a.paracl) x
       -- parname is stored in lower case; pg_settings keeps names like DateStyle.
       LEFT JOIN pg_catalog.pg_settings s ON pg_catalog.lower(s.name) = a.parname
       WHERE (x.grantee = 0 OR pg_catalog.pg_has_role($1, x.grantee, 'MEMBER'))
         AND (x.privilege_type = 'ALTER SYSTEM' OR s.context IS NULL
              OR s.context NOT IN ('user', 'backend'))
       ORDER BY 1
     ) AS grants`,
    [user],
  );
  const grants: string[] = granted.rows[0].grants;
  if (grants.length)
    throw new ProvisionError(
      `The ${label} role may change server settings it must not: ${grants.slice(0, 5).join(", ")}${grants.length > 5 ? ", ..." : ""}. As a superuser run REVOKE SET ON PARAMETER <parameter> FROM <role|PUBLIC> (or REVOKE ALTER SYSTEM ON PARAMETER ...), then re-run.`,
    );
}

/**
 * TEN-02: every table with a tenant_id (outside the queue schema, or inside
 * it when the application can reach it) enables and forces row-level
 * security and keeps a restrictive policy, for every command and every role,
 * that matches app.require_tenant_id() on reads and writes. Only the
 * documented exceptions are exempt; those that keep row-level security may
 * only have permissive write policies (for the login) limited to the tenant,
 * as the migrations create them.
 */
async function assertTenantRls(client: ClientBase, user: string) {
  const tables = await client.query(
    `SELECT format('%I.%I', n.nspname, c.relname) AS relation,
            c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
            EXISTS (
              SELECT 1 FROM pg_policy p
              WHERE p.polrelid = c.oid AND NOT p.polpermissive AND p.polcmd = '*'
                AND p.polroles = '{0}'::oid[]
                AND pg_get_expr(p.polqual, p.polrelid) = $2
                AND pg_get_expr(p.polwithcheck, p.polrelid) = $2
            ) AS policy,
            -- Permissive write policies the login can use whose expressions
            -- are not exactly the tenant predicate (the documented exceptions
            -- rely on these alone to stop cross-tenant writes). UPDATE and ALL
            -- may omit WITH CHECK: USING then also checks the new row.
            ARRAY(
              SELECT format('%I', p.polname) FROM pg_catalog.pg_policy p
              WHERE p.polrelid = c.oid AND p.polpermissive AND p.polcmd IN ('a', 'w', 'd', '*')
                AND ('0'::oid = ANY(p.polroles)
                     OR EXISTS (SELECT 1 FROM unnest(p.polroles) AS r(oid) WHERE pg_has_role($1, r.oid, 'MEMBER')))
                AND NOT CASE p.polcmd
                  WHEN 'a' THEN pg_get_expr(p.polwithcheck, p.polrelid) IS NOT DISTINCT FROM $2
                  WHEN 'd' THEN pg_get_expr(p.polqual, p.polrelid) IS NOT DISTINCT FROM $2
                  ELSE pg_get_expr(p.polqual, p.polrelid) IS NOT DISTINCT FROM $2
                    AND (p.polwithcheck IS NULL OR pg_get_expr(p.polwithcheck, p.polrelid) = $2)
                END
              ORDER BY 1
            ) AS loose
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
     WHERE c.relkind IN ('r', 'p')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'
       -- A grant on a single column reaches the table as much as a table grant.
       AND (n.nspname <> $3
            OR has_table_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, DELETE')
            OR has_any_column_privilege($1, c.oid, 'SELECT, INSERT, UPDATE'))
     ORDER BY 1`,
    [user, TENANT_PREDICATE, QUEUE_SCHEMA],
  );
  type Row = {
    relation: string;
    enabled: boolean;
    forced: boolean;
    policy: boolean;
    loose: string[];
  };
  const broken = (tables.rows as Row[]).flatMap((row) => {
    const exception = TENANT_RLS_EXCEPTIONS[row.relation];
    if (exception)
      return exception.rowSecurity
        ? [
            ...(row.enabled
              ? []
              : [`${row.relation} (row-level security disabled)`]),
            ...row.loose.map(
              (policy) =>
                `${row.relation} (write policy ${policy} is not limited to the tenant)`,
            ),
          ]
        : [];
    const problems = [
      ...(row.enabled ? [] : ["row-level security disabled"]),
      ...(row.forced ? [] : ["not forced"]),
      ...(row.policy ? [] : ["no restrictive tenant_isolation policy"]),
    ];
    return problems.length ? [`${row.relation} (${problems.join(", ")})`] : [];
  });
  if (broken.length)
    throw new ProvisionError(
      `Tenant tables must enable and force row-level security with the restrictive tenant policy (TEN-02); these do not: ${broken.slice(0, 5).join("; ")}${broken.length > 5 ? "; ..." : ""}. As the migration owner: for "disabled" run ALTER TABLE <table> ENABLE ROW LEVEL SECURITY, for "not forced" ALTER TABLE <table> FORCE ROW LEVEL SECURITY; for a missing or altered policy drop the table's tenant_access and tenant_isolation policies, then run SELECT app.enforce_tenant_rls('<table>'::regclass) (never on tenant_domains, payment_link_tokens or delivery_store_index, which only need RLS enabled). For a write policy "not limited to the tenant" on tenant_domains, payment_link_tokens or delivery_store_index run DROP POLICY <policy> ON <table>, or, for one the migrations created (tenant_domain_*, payment_link_tokens_* or delivery_store_index_*), ALTER POLICY <policy> ON <table> so each of its USING and WITH CHECK expressions is (tenant_id = app.require_tenant_id()). Then re-run.`,
    );
}

/**
 * Default privileges (ALTER DEFAULT PRIVILEGES) are applied to every table,
 * sequence or schema created later, for example by the next migration, so
 * they get the same limits as existing objects: `allowedTable` and
 * `allowedSequence` for grants this login inherits (none through PUBLIC),
 * never CREATE on schemas. Grants inside `ownSchemas` to the login itself are
 * its own business.
 */
async function assertDefaultPrivileges(
  client: ClientBase,
  user: string,
  label: string,
  ownSchemas: string[],
  allowedTable: string[],
  allowedSequence: string[],
) {
  const rows = await client.query(
    `SELECT a.grantee = 0 AS public,
            CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
            pg_get_userbyid(d.defaclrole) AS owner,
            COALESCE(n.nspname::text, '') AS schema,
            d.defaclobjtype AS type, a.privilege_type AS privilege
     FROM pg_default_acl d
     LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
     CROSS JOIN LATERAL aclexplode(d.defaclacl) a
     WHERE d.defaclobjtype IN ('r', 'S', 'n')
       AND a.grantee <> d.defaclrole
       AND CASE WHEN a.grantee = 0 THEN true ELSE pg_has_role($1, a.grantee, 'MEMBER') END
     ORDER BY 3, 4, 5, 6`,
    [user],
  );
  type Row = {
    public: boolean;
    grantee: string;
    owner: string;
    schema: string;
    type: string;
    privilege: string;
  };
  const extra = (rows.rows as Row[])
    .filter((row) => {
      if (row.type === "n") return row.privilege === "CREATE";
      if (!row.public && ownSchemas.includes(row.schema)) return false;
      const allowed = row.type === "S" ? allowedSequence : allowedTable;
      return row.public || !allowed.includes(row.privilege);
    })
    .map(
      (row) =>
        `${row.privilege} on new ${{ n: "schemas", S: "sequences" }[row.type] ?? "tables"} created by ${row.owner}${row.schema ? ` in ${row.schema}` : ""} (granted to ${row.grantee})`,
    );
  if (extra.length)
    throw new ProvisionError(
      `The ${label} role would get default privileges it must not have: ${extra.slice(0, 5).join(", ")}${extra.length > 5 ? ", ..." : ""}. Remove them with ALTER DEFAULT PRIVILEGES ... REVOKE, then re-run.`,
    );
}

/**
 * Opens one admin connection and runs `work` in a single transaction under
 * an advisory lock, so concurrent runs serialise. `commit: false` always
 * rolls back (audit mode).
 */
export async function withAdmin<T>(
  adminUrl: string,
  work: (client: ClientBase) => Promise<T>,
  commit = true,
) {
  const client = new Client({
    connectionString: adminUrl,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    const version = await serverVersion(client);
    if (version < MIN_SERVER_VERSION)
      throw new ProvisionError(
        `PostgreSQL 16 or newer is required; this server reports version ${Math.floor(version / 10000)}.`,
      );
    await client.query("BEGIN");
    // Catalog text (pg_get_expr) is compared exactly; a search_path that
    // includes app would print app.require_tenant_id() without its schema.
    await client.query("SET LOCAL search_path = pg_catalog");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      LOCK_KEY,
    ]);
    const result = await work(client);
    await client.query(commit ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

/**
 * After the transaction commits, sign in with the URL exactly as given and
 * confirm who PostgreSQL says we are. This is the check that cannot be fooled
 * by URL parsing differences.
 */
async function verifyIdentity(login: Login, label: string, database: string) {
  const client = new Client({
    connectionString: login.url,
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    const row = (
      await client.query(
        `SELECT current_user AS current, session_user AS session, current_database() AS database,
                (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS elevated`,
      )
    ).rows[0];
    if (
      row.current !== login.user ||
      row.session !== login.user ||
      row.database !== database ||
      row.elevated !== false
    )
      throw new ProvisionError(
        `The ${label} URL does not sign in as ${login.user} on ${database}; refusing it.`,
      );
  } catch (error) {
    if (error instanceof ProvisionError) throw error;
    const code = (error as { code?: unknown }).code;
    throw new ProvisionError(
      `Could not sign in with the ${label} URL as ${login.user}${typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? ` (SQLSTATE ${code})` : ""}; check its password and host.`,
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function assertGroup(client: ClientBase, name = APP_GROUP) {
  const group = await client.query(
    "SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin FROM pg_roles WHERE rolname = $1",
    [name],
  );
  if (!group.rows.length)
    throw new ProvisionError(
      `Run the migrations first: the ${name} group role does not exist.`,
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
      `The ${name} group role must be NOLOGIN without elevated attributes.`,
    );
}

/**
 * Normalise existing memberships of `group`: drop any grant without INHERIT,
 * with ADMIN OPTION, or (when `set` is given) with a different SET option, then
 * grant cleanly. PostgreSQL keeps one row per grantor; a
 * superuser can revoke each by name, anyone can revoke their own. Rows it
 * cannot revoke stay and make assertRestricted refuse with the grantor named.
 */
async function grantGroup(
  client: ClientBase,
  group: string,
  user: string,
  set?: boolean,
) {
  const admin = await client.query(
    "SELECT current_user AS name, rolsuper FROM pg_roles WHERE rolname = current_user",
  );
  const rows = await client.query(
    `SELECT pg_get_userbyid(m.grantor) AS grantor, m.admin_option,
            m.inherit_option AS inherit, m.set_option AS "set"
     FROM pg_auth_members m
     WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = $1)
       AND m.member = (SELECT oid FROM pg_roles WHERE rolname = $2)`,
    [group, user],
  );
  for (const row of rows.rows as {
    grantor: string;
    admin_option: boolean;
    inherit: boolean;
    set: boolean;
  }[]) {
    if (
      !row.admin_option &&
      row.inherit &&
      (set === undefined || row.set === set)
    )
      continue;
    if (row.grantor === admin.rows[0].name)
      await client.query(`REVOKE ${group} FROM "${user}"`);
    else if (admin.rows[0].rolsuper && !row.grantor.includes('"'))
      await client.query(
        `REVOKE ${group} FROM "${user}" GRANTED BY "${row.grantor}"`,
      );
  }
  await client.query(
    `GRANT ${group} TO "${user}" WITH INHERIT TRUE${set === false ? ", SET FALSE" : ""}`,
  );
}

async function provisionApp(client: ClientBase, login: Login) {
  await assertGroup(client);
  // Before PostgreSQL 15 every role could create in `public`. Revoking is a
  // no-op on newer servers and is verified below either way.
  await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
  const outcome = await upsertLogin(client, login, "application", true);
  await grantGroup(client, APP_GROUP, login.user);
  await auditApp(client, login.user);
  return outcome;
}

// The proof-read role (drizzle/0481) is reached by SET ROLE only: the login must
// not inherit it, and neither the login, legend_app nor PUBLIC may run the two
// functions that record an observation without the caller's door (observe_ok and
// observe_difference are for the recon role only; the internal function takes
// the five-argument signature with p_by_recon, legend-tiw2h).
async function assertReconRoleReachedOnly(client: ClientBase, user: string) {
  const result = await client.query(
    `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $2::text)
              AND pg_has_role($1::text, $2::text, 'USAGE') AS inherits,
            ARRAY(
              SELECT f.sig || ' for ' || g.grantee
                FROM (VALUES ('app.payout_recon_evidence_observe_ok(uuid, uuid)'),
                             ('app.payout_recon_evidence_observe_difference(uuid, uuid, text, text)'),
                             ('app.payout_recon_evidence_observe_internal(uuid, uuid, text, text, boolean)')) AS f(sig)
                CROSS JOIN (VALUES ($1::text), ('legend_app'), ('public')) AS g(grantee)
               WHERE to_regprocedure(f.sig) IS NOT NULL
                 AND has_function_privilege(g.grantee, to_regprocedure(f.sig), 'EXECUTE')
               ORDER BY 1
            ) AS executable`,
    [user, RECON_GROUP],
  );
  const { inherits, executable } = result.rows[0];
  if (inherits)
    throw new ProvisionError(
      `The application role inherits ${RECON_GROUP}; it may only reach it with SET ROLE (membership INHERIT FALSE, SET TRUE).`,
    );
  if (executable.length)
    throw new ProvisionError(
      `The application role can run proof observation functions outside ${RECON_GROUP}: ${executable.join(", ")}.`,
    );
}

// The frozen-column re-seal role (drizzle/0508, legend-qwm9r) is held by one
// dedicated login only (legend_reseal_*, INHERIT TRUE, SET FALSE, no ADMIN). No
// other role may be a member that can use it, neither legend_app nor any other
// login (a SET-only member could choose its own tenant GUC and reach other
// tenants' frozen rows), and nobody else may run app.reseal_frozen_sealed.
// `logins` are the other logins of this deploy, checked for a direct EXECUTE.
// With `resealUser` (the login of this deploy's RESEAL_DATABASE_URL) that exact
// login must be the only reseal-shaped member: a stale legend_reseal_* left from
// an earlier key is refused.
async function assertSealedResealRoleReachedOnly(
  client: ClientBase,
  logins: string[],
  resealUser?: string,
) {
  const members = await client.query<{
    member: string;
    superuser: boolean;
    self: boolean;
    admin_option: boolean;
    inherit: boolean;
    set: boolean;
  }>(
    `SELECT u.rolname AS member, u.rolsuper AS superuser, u.rolname = current_user AS self,
            m.admin_option, m.inherit_option AS inherit, m.set_option AS "set"
     FROM pg_auth_members m JOIN pg_roles u ON u.oid = m.member
     WHERE m.roleid = $1::regrole
     ORDER BY 1`,
    [SEALED_RESEAL_GROUP],
  );
  // The reseal login must have exactly INHERIT. Anyone else may not use the
  // group at all (a bare ADMIN-only row of the migration owner, which created
  // the role, grants no power and is the one thing left alone).
  const flawed = members.rows
    .filter((row) =>
      RESEAL_LOGIN.test(row.member)
        ? (resealUser !== undefined && row.member !== resealUser) ||
          row.admin_option ||
          !row.inherit ||
          row.set
        : !row.superuser &&
          (row.inherit ||
            row.set ||
            (row.admin_option &&
              !row.self &&
              !/^legend_migrator_[a-f0-9]{16}$/.test(row.member))),
    )
    .map((row) => row.member);
  if (flawed.length)
    throw new ProvisionError(
      `${SEALED_RESEAL_GROUP} has members it must not have or with options it must not hold: ${flawed.slice(0, 5).join(", ")}${flawed.length > 5 ? ", ..." : ""}. Only ${RESEAL_LABEL} login (legend_reseal_<16 hex>) may be a member, with INHERIT and neither SET nor ADMIN OPTION; as a superuser run REVOKE ${SEALED_RESEAL_GROUP} FROM <role>, then re-run.`,
    );

  const result = await client.query(
    `SELECT ARRAY(
              SELECT f.sig || ' for ' || g.grantee
                FROM (VALUES ('app.reseal_frozen_sealed(text, text, uuid, uuid, text, text)')) AS f(sig)
                CROSS JOIN (SELECT unnest($1::text[]) AS grantee) AS g
               WHERE to_regprocedure(f.sig) IS NOT NULL
                 AND has_function_privilege(g.grantee, to_regprocedure(f.sig), 'EXECUTE')
               ORDER BY 1
            ) AS executable`,
    [["legend_app", "public", ...logins]],
  );
  const { executable } = result.rows[0];
  if (executable.length)
    throw new ProvisionError(
      `The frozen-column re-seal function can be run outside ${SEALED_RESEAL_GROUP}: ${executable.join(", ")}.`,
    );

  // The group itself: its only power is the one function. A table or sequence
  // right (MAINTAIN included, PostgreSQL 17+), or EXECUTE on any other function,
  // would widen what the reseal login reaches. Functions open to PUBLIC (trigger
  // functions, extensions) add nothing through the group; the PUBLIC check of
  // SECURITY DEFINER functions covers those.
  const relationRights = `SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER${(await serverVersion(client)) >= 170000 ? ", MAINTAIN" : ""}`;
  const group = await client.query(
    `SELECT ARRAY(
              SELECT format('%I.%I', n.nspname, c.relname)
                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
                 AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'
                 AND (  (c.relkind IN ('r', 'p', 'v', 'm', 'f')
                         AND (has_table_privilege($1::text, c.oid, $3::text)
                              OR has_any_column_privilege($1::text, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')))
                     OR (c.relkind = 'S'
                         AND has_sequence_privilege($1::text, c.oid, 'USAGE, SELECT, UPDATE')))
               ORDER BY 1
            ) AS relations,
            ARRAY(
              SELECT p.oid::regprocedure::text
                FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
                 AND p.oid <> to_regprocedure($2::text)
                 AND NOT EXISTS (SELECT 1 FROM pg_depend d
                                  WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
                 AND has_function_privilege($1::text, p.oid, 'EXECUTE')
                 AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
               ORDER BY 1
            ) AS functions,
            COALESCE((SELECT p.prosecdef AND COALESCE(p.proconfig::text[] @> ARRAY['search_path=pg_catalog, pg_temp'], false)
                        FROM pg_proc p WHERE p.oid = to_regprocedure($2::text)), true) AS function_ok,
            -- The function runs as its owner on FORCE RLS tables (orders,
            -- pos_order_tenders): the owner must be a superuser or BYPASSRLS
            -- role (the migration owner), or the update would match no row.
            COALESCE((SELECT r.rolsuper OR r.rolbypassrls
                        FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                       WHERE p.oid = to_regprocedure($2::text)), true) AS owner_ok`,
    [SEALED_RESEAL_GROUP, SEALED_RESEAL_FUNCTION, relationRights],
  );
  const { relations, functions, function_ok, owner_ok } = group.rows[0];
  if (relations.length)
    throw new ProvisionError(
      `${SEALED_RESEAL_GROUP} holds table or sequence rights it must not have: ${relations.slice(0, 5).join(", ")}${relations.length > 5 ? ", ..." : ""}.`,
    );
  if (functions.length)
    throw new ProvisionError(
      `${SEALED_RESEAL_GROUP} can run functions other than ${SEALED_RESEAL_FUNCTION}: ${functions.slice(0, 5).join(", ")}${functions.length > 5 ? ", ..." : ""}.`,
    );
  if (!function_ok)
    throw new ProvisionError(
      `${SEALED_RESEAL_FUNCTION} must be SECURITY DEFINER with search_path pinned to pg_catalog, pg_temp.`,
    );
  if (!owner_ok)
    throw new ProvisionError(
      `${SEALED_RESEAL_FUNCTION} must be owned by a superuser or BYPASSRLS role (the migration owner): it updates FORCE ROW LEVEL SECURITY tables as its owner.`,
    );
  // The group's effective rights get the audit of a login (it is audited as one:
  // system catalogs, built-in functions outside the initdb baseline, MAINTAIN,
  // sequences, CREATE on schemas, parameter grants), because the reseal login
  // inherits every one of them and no other check looks at the group alone.
  await assertRestricted(
    client,
    SEALED_RESEAL_GROUP,
    SEALED_RESEAL_GROUP,
    [],
    [],
  );
  await assertTableRights(
    client,
    SEALED_RESEAL_GROUP,
    SEALED_RESEAL_GROUP,
    [],
    {},
  );
  await assertSequenceRights(
    client,
    SEALED_RESEAL_GROUP,
    SEALED_RESEAL_GROUP,
    [],
    [],
  );
  await assertNoSensitive(client, SEALED_RESEAL_GROUP, SEALED_RESEAL_GROUP);
  await assertNoParameterGrants(
    client,
    SEALED_RESEAL_GROUP,
    SEALED_RESEAL_GROUP,
  );
}

/**
 * A SECURITY DEFINER function runs as its owner, so one in schema app that
 * kept PUBLIC's default EXECUTE lets every login (the application and queue
 * logins included) act as that owner. Every migration revokes EXECUTE from
 * PUBLIC and grants it to the one role that needs it; a function that did not
 * is drift or a missed revoke, and the audit refuses it.
 */
async function assertSecurityDefinerNotPublic(client: ClientBase) {
  const open = await client.query(
    `SELECT ARRAY(
       SELECT p.oid::regprocedure::text
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'app'
         AND p.prosecdef
         AND has_function_privilege('public', p.oid, 'EXECUTE')
       ORDER BY 1
     ) AS names`,
  );
  const names: string[] = open.rows[0].names;
  if (names.length)
    throw new ProvisionError(
      `SECURITY DEFINER functions in schema app can be run by every login through PUBLIC: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ", ..." : ""}. Revoke EXECUTE from PUBLIC, then re-run.`,
    );
}

/**
 * The queue schema belongs to the queue login alone. The application login
 * must reach nothing in it: no table or column right, no sequence right, no
 * USAGE or CREATE on the schema, and no default privilege that would hand it
 * rights on objects the queue owner creates later (pg-boss creates its tables
 * at run time). Anything here is drift, so the "*" allowance for application
 * tables never covers it.
 */
async function assertNoQueueSchemaAccess(client: ClientBase, user: string) {
  await assertTableRights(client, user, "application", [], {}, true);
  const sequences = await client.query(
    `SELECT format('%I.%I', n.nspname, c.relname) AS relation, p.privilege
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) AS p(privilege)
     WHERE c.relkind = 'S' AND n.nspname = $2
       AND has_sequence_privilege($1, c.oid, p.privilege)
     ORDER BY 1, 2`,
    [user, QUEUE_SCHEMA],
  );
  if (sequences.rows.length)
    throw new ProvisionError(
      `The application role has sequence rights in the queue schema it must not have: ${sequences.rows
        .slice(0, 5)
        .map(
          (row: { relation: string; privilege: string }) =>
            `${row.privilege} on ${row.relation}`,
        )
        .join(
          ", ",
        )}${sequences.rows.length > 5 ? ", ..." : ""}. Revoke them, then re-run.`,
    );
  const schema = await client.query(
    `SELECT p.privilege
     FROM pg_namespace n
     CROSS JOIN unnest(ARRAY['USAGE', 'CREATE']) AS p(privilege)
     WHERE n.nspname = $2 AND has_schema_privilege($1, n.oid, p.privilege)
     ORDER BY 1`,
    [user, QUEUE_SCHEMA],
  );
  if (schema.rows.length)
    throw new ProvisionError(
      `The application role has rights on the queue schema ${QUEUE_SCHEMA} it must not have: ${schema.rows
        .map(
          (row: { privilege: string }) => `${row.privilege} on ${QUEUE_SCHEMA}`,
        )
        .join(", ")}. Revoke them, then re-run.`,
    );
  const defaults = await client.query(
    `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
            pg_get_userbyid(d.defaclrole) AS owner,
            COALESCE(n.nspname::text, '') AS schema,
            d.defaclobjtype AS type, a.privilege_type AS privilege
     FROM pg_default_acl d
     LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
     CROSS JOIN LATERAL aclexplode(d.defaclacl) a
     WHERE a.grantee <> d.defaclrole
       AND (a.grantee = 0 OR pg_has_role($1, a.grantee, 'USAGE'))
       -- A global default for functions or types always lists the built-in
       -- PUBLIC EXECUTE/USAGE next to any other grantee: not a new grant.
       AND NOT (a.grantee = 0 AND d.defaclnamespace = 0 AND d.defaclobjtype IN ('f', 'T'))
       AND (n.nspname = $2
            OR d.defaclrole IN (SELECT nspowner FROM pg_namespace WHERE nspname = $2))
     ORDER BY 2, 3, 4, 5`,
    [user, QUEUE_SCHEMA],
  );
  type Default = {
    grantee: string;
    owner: string;
    schema: string;
    type: string;
    privilege: string;
  };
  if (defaults.rows.length)
    throw new ProvisionError(
      `The application role would get default privileges on the queue schema ${QUEUE_SCHEMA} it must not have: ${(
        defaults.rows as Default[]
      )
        .slice(0, 5)
        .map(
          (row) =>
            `${row.privilege} on new ${{ n: "schemas", S: "sequences", f: "functions", T: "types" }[row.type] ?? "tables"} created by ${row.owner}${row.schema ? ` in ${row.schema}` : ` (default privileges in every schema, including ${QUEUE_SCHEMA})`} (granted to ${row.grantee})`,
        )
        .join(
          ", ",
        )}${defaults.rows.length > 5 ? ", ..." : ""}. Remove them with ALTER DEFAULT PRIVILEGES ... REVOKE, then re-run.`,
    );
}

async function auditApp(client: ClientBase, user: string) {
  await assertRestricted(
    client,
    user,
    "application",
    [APP_GROUP, RECON_GROUP],
    [],
  );
  await assertReconRoleReachedOnly(client, user);
  await assertTableRights(client, user, "application", [], {
    "*": APP_TABLE_RIGHTS,
  });
  await assertSequenceRights(
    client,
    user,
    "application",
    [],
    APP_SEQUENCE_RIGHTS,
  );
  await assertDefaultPrivileges(
    client,
    user,
    "application",
    [],
    APP_TABLE_RIGHTS,
    APP_SEQUENCE_RIGHTS,
  );
  await assertNoSensitive(client, user, "application");
  await assertNoParameterGrants(client, user, "application");
  await assertTenantRls(client, user);
  await assertNoQueueSchemaAccess(client, user);
}

async function auditWorker(client: ClientBase, user: string) {
  await assertRestricted(client, user, "queue", [], [QUEUE_SCHEMA]);
  await assertTableRights(client, user, "queue", [QUEUE_SCHEMA], {
    "app.active_tenant_registry": ["SELECT"],
  });
  await assertSequenceRights(client, user, "queue", [QUEUE_SCHEMA], []);
  await assertDefaultPrivileges(client, user, "queue", [QUEUE_SCHEMA], [], []);
  await assertNoSensitive(client, user, "queue");
  await assertNoParameterGrants(client, user, "queue");
}

/**
 * The maintenance group runs the two audit retention functions and nothing
 * else (migration 0187): both are SECURITY DEFINER with a pinned search_path,
 * owned by the owner of audit_logs (so RLS applies to the owner, not to the
 * login), executable by the group but never by PUBLIC or legend_app.
 */
async function assertMaintenanceFunctions(client: ClientBase, user: string) {
  const functions = await client.query(
    `SELECT f.signature, p.oid IS NOT NULL AS found,
            COALESCE(p.prosecdef, false) AS secdef,
            COALESCE(p.proconfig::text[] @> ARRAY['search_path=pg_catalog, pg_temp'], false) AS pinned,
            COALESCE(p.proowner = t.relowner, false) AS owned_by_table_owner,
            COALESCE(has_function_privilege($1, p.oid, 'EXECUTE'), false) AS login_can,
            COALESCE(has_function_privilege('public', p.oid, 'EXECUTE'), false) AS public_can,
            COALESCE(has_function_privilege($3, p.oid, 'EXECUTE'), false) AS app_can
     FROM unnest($2::text[]) AS f(signature)
     LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.signature)
     CROSS JOIN (SELECT relowner FROM pg_class WHERE oid = 'public.audit_logs'::regclass) t
     ORDER BY 1`,
    [user, MAINT_FUNCTIONS, APP_GROUP],
  );
  type Row = {
    signature: string;
    found: boolean;
    secdef: boolean;
    pinned: boolean;
    owned_by_table_owner: boolean;
    login_can: boolean;
    public_can: boolean;
    app_can: boolean;
  };
  const problems = (functions.rows as Row[]).flatMap((row) => {
    if (!row.found) return [`${row.signature} does not exist`];
    return [
      ...(row.secdef ? [] : ["is not SECURITY DEFINER"]),
      ...(row.pinned ? [] : ["has no pinned search_path"]),
      ...(row.owned_by_table_owner
        ? []
        : ["is not owned by the owner of audit_logs"]),
      ...(row.login_can ? [] : ["cannot be run by the login"]),
      ...(row.public_can || row.app_can
        ? ["can be run by PUBLIC or legend_app"]
        : []),
    ].map((problem) => `${row.signature} ${problem}`);
  });
  if (problems.length)
    throw new ProvisionError(
      `The maintenance functions are not as the migrations define them: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? "; ..." : ""}. Run the migrations, then re-run.`,
    );
  // Nothing else in the app schema may be reachable beyond PUBLIC's rights.
  const extra = await client.query(
    `SELECT ARRAY(
       SELECT p.oid::regprocedure::text
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'app'
         AND has_function_privilege($1, p.oid, 'EXECUTE')
         AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
         AND p.oid <> ALL(ARRAY(SELECT to_regprocedure(x)::oid FROM unnest($2::text[]) AS x))
       ORDER BY 1
     ) AS names`,
    [user, MAINT_FUNCTIONS],
  );
  if (extra.rows[0].names.length)
    throw new ProvisionError(
      `The maintenance role may run functions beyond its two: ${extra.rows[0].names.slice(0, 5).join(", ")}${extra.rows[0].names.length > 5 ? ", ..." : ""}.`,
    );
  // The check above skips PUBLIC's rights, but a SECURITY DEFINER function
  // runs as its owner: one that kept PUBLIC's default EXECUTE (or got a direct
  // grant) lets the login act beyond its two functions. Any schema the login
  // can reach counts, not only app: PUBLIC keeps USAGE on schema public.
  const secdef = await client.query(
    `SELECT ARRAY(
       SELECT p.oid::regprocedure::text
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND has_schema_privilege($1, n.oid, 'USAGE')
         AND p.prosecdef
         AND has_function_privilege($1, p.oid, 'EXECUTE')
         AND p.oid <> ALL(ARRAY(SELECT to_regprocedure(x)::oid FROM unnest($2::text[]) AS x))
       ORDER BY 1
     ) AS names`,
    [user, MAINT_FUNCTIONS],
  );
  if (secdef.rows[0].names.length)
    throw new ProvisionError(
      `The maintenance role may run SECURITY DEFINER functions beyond its two: ${secdef.rows[0].names.slice(0, 5).join(", ")}${secdef.rows[0].names.length > 5 ? ", ..." : ""}. Revoke EXECUTE from PUBLIC and the role, then re-run.`,
    );
  const schema = await client.query(
    "SELECT has_schema_privilege($1, 'app', 'USAGE') AS usage",
    [user],
  );
  if (!schema.rows[0].usage)
    throw new ProvisionError(
      `The maintenance role has no USAGE on schema app; run the migrations, then re-run.`,
    );
}

async function auditMaintenance(client: ClientBase, user: string) {
  await assertRestricted(client, user, "maintenance", [MAINT_GROUP], []);
  // No table or sequence right at all: the functions do the work as the owner.
  await assertTableRights(client, user, "maintenance", [], {});
  await assertSequenceRights(client, user, "maintenance", [], []);
  await assertDefaultPrivileges(client, user, "maintenance", [], [], []);
  await assertNoSensitive(client, user, "maintenance");
  await assertNoParameterGrants(client, user, "maintenance");
  await assertMaintenanceFunctions(client, user);
}

async function provisionMaintenance(client: ClientBase, login: Login) {
  await assertGroup(client, MAINT_GROUP);
  const outcome = await upsertLogin(client, login, "maintenance");
  await grantGroup(client, MAINT_GROUP, login.user);
  await auditMaintenance(client, login.user);
  return outcome;
}

/**
 * The grantor group runs app.payout_grant_issue and nothing else (migration
 * 0419): SECURITY DEFINER with a pinned search_path, owned by `legend_payout`,
 * executable by the group but never by PUBLIC or legend_app.
 */
async function assertGrantorFunctions(client: ClientBase, user: string) {
  const functions = await client.query(
    `SELECT f.signature, p.oid IS NOT NULL AS found,
            COALESCE(p.prosecdef, false) AS secdef,
            COALESCE(p.proconfig::text[] @> ARRAY['search_path=pg_catalog, pg_temp'], false) AS pinned,
            COALESCE(pg_get_userbyid(p.proowner) = $4, false) AS owned_by_payout,
            COALESCE(has_function_privilege($1, p.oid, 'EXECUTE'), false) AS login_can,
            COALESCE(has_function_privilege('public', p.oid, 'EXECUTE'), false) AS public_can,
            COALESCE(has_function_privilege($3, p.oid, 'EXECUTE'), false) AS app_can
     FROM unnest($2::text[]) AS f(signature)
     LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.signature)
     ORDER BY 1`,
    [user, GRANTOR_FUNCTIONS, APP_GROUP, PAYOUT_OWNER],
  );
  type Row = {
    signature: string;
    found: boolean;
    secdef: boolean;
    pinned: boolean;
    owned_by_payout: boolean;
    login_can: boolean;
    public_can: boolean;
    app_can: boolean;
  };
  const problems = (functions.rows as Row[]).flatMap((row) => {
    if (!row.found) return [`${row.signature} does not exist`];
    return [
      ...(row.secdef ? [] : ["is not SECURITY DEFINER"]),
      ...(row.pinned ? [] : ["has no pinned search_path"]),
      ...(row.owned_by_payout ? [] : [`is not owned by ${PAYOUT_OWNER}`]),
      ...(row.login_can ? [] : ["cannot be run by the login"]),
      ...(row.public_can || row.app_can
        ? ["can be run by PUBLIC or legend_app"]
        : []),
    ].map((problem) => `${row.signature} ${problem}`);
  });
  if (problems.length)
    throw new ProvisionError(
      `The payout grantor function is not as the migrations define it: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? "; ..." : ""}. Run the migrations, then re-run.`,
    );
  // Any SECURITY DEFINER function the login can run beyond the one, in any
  // schema it can reach (PUBLIC keeps USAGE on schema public), lets it act as
  // that function's owner.
  const secdef = await client.query(
    `SELECT ARRAY(
       SELECT p.oid::regprocedure::text
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND has_schema_privilege($1, n.oid, 'USAGE')
         AND p.prosecdef
         AND has_function_privilege($1, p.oid, 'EXECUTE')
         AND p.oid <> ALL(ARRAY(SELECT to_regprocedure(x)::oid FROM unnest($2::text[]) AS x))
       ORDER BY 1
     ) AS names`,
    [user, GRANTOR_FUNCTIONS],
  );
  if (secdef.rows[0].names.length)
    throw new ProvisionError(
      `The payout grantor role may run functions beyond payout_grant_issue: ${secdef.rows[0].names.slice(0, 5).join(", ")}${secdef.rows[0].names.length > 5 ? ", ..." : ""}. Revoke EXECUTE from PUBLIC and the role, then re-run.`,
    );
  // Same for the rest of the app schema, SECURITY DEFINER or not: only the
  // functions PUBLIC may run anyway can stay.
  const extra = await client.query(
    `SELECT ARRAY(
       SELECT p.oid::regprocedure::text
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'app'
         AND has_function_privilege($1, p.oid, 'EXECUTE')
         AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
         AND p.oid <> ALL(ARRAY(SELECT to_regprocedure(x)::oid FROM unnest($2::text[]) AS x))
       ORDER BY 1
     ) AS names`,
    [user, GRANTOR_FUNCTIONS],
  );
  if (extra.rows[0].names.length)
    throw new ProvisionError(
      `The payout grantor role may run functions beyond payout_grant_issue: ${extra.rows[0].names.slice(0, 5).join(", ")}${extra.rows[0].names.length > 5 ? ", ..." : ""}.`,
    );
  const schema = await client.query(
    "SELECT has_schema_privilege($1, 'app', 'USAGE') AS usage",
    [user],
  );
  if (!schema.rows[0].usage)
    throw new ProvisionError(
      `The payout grantor role has no USAGE on schema app; run the migrations, then re-run.`,
    );
}

async function auditGrantor(client: ClientBase, user: string) {
  await assertRestricted(client, user, "payout grantor", [GRANTOR_GROUP], []);
  // No table or sequence right at all: the function does the work as its owner.
  await assertTableRights(client, user, "payout grantor", [], {});
  await assertSequenceRights(client, user, "payout grantor", [], []);
  await assertDefaultPrivileges(client, user, "payout grantor", [], [], []);
  await assertNoSensitive(client, user, "payout grantor");
  await assertNoParameterGrants(client, user, "payout grantor");
  await assertGrantorFunctions(client, user);
}

async function provisionGrantor(client: ClientBase, login: Login) {
  await assertGroup(client, GRANTOR_GROUP);
  const outcome = await upsertLogin(client, login, "payout grantor");
  await grantGroup(client, GRANTOR_GROUP, login.user);
  await auditGrantor(client, login.user);
  return outcome;
}

/**
 * The reseal group runs app.reseal_frozen_sealed and nothing else (migration
 * 0508): SECURITY DEFINER with a pinned search_path, executable by the group
 * (so by its login) but never by PUBLIC or legend_app.
 */
async function assertResealFunctions(client: ClientBase, user: string) {
  const functions = await client.query(
    `SELECT f.signature, p.oid IS NOT NULL AS found,
            COALESCE(p.prosecdef, false) AS secdef,
            COALESCE(p.proconfig::text[] @> ARRAY['search_path=pg_catalog, pg_temp'], false) AS pinned,
            COALESCE(has_function_privilege($1, p.oid, 'EXECUTE'), false) AS login_can,
            COALESCE(has_function_privilege('public', p.oid, 'EXECUTE'), false) AS public_can,
            COALESCE(has_function_privilege($3, p.oid, 'EXECUTE'), false) AS app_can
     FROM unnest($2::text[]) AS f(signature)
     LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.signature)
     ORDER BY 1`,
    [user, RESEAL_FUNCTIONS, APP_GROUP],
  );
  type Row = {
    signature: string;
    found: boolean;
    secdef: boolean;
    pinned: boolean;
    login_can: boolean;
    public_can: boolean;
    app_can: boolean;
  };
  const problems = (functions.rows as Row[]).flatMap((row) => {
    if (!row.found) return [`${row.signature} does not exist`];
    return [
      ...(row.secdef ? [] : ["is not SECURITY DEFINER"]),
      ...(row.pinned ? [] : ["has no pinned search_path"]),
      ...(row.login_can ? [] : ["cannot be run by the login"]),
      ...(row.public_can || row.app_can
        ? ["can be run by PUBLIC or legend_app"]
        : []),
    ].map((problem) => `${row.signature} ${problem}`);
  });
  if (problems.length)
    throw new ProvisionError(
      `The frozen-column re-seal function is not as the migrations define it: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? "; ..." : ""}. Run the migrations, then re-run.`,
    );
  // Any other SECURITY DEFINER function the login can run, in any schema it can
  // reach (PUBLIC keeps USAGE on schema public), lets it act as that owner.
  const secdef = await client.query(
    `SELECT ARRAY(
       SELECT p.oid::regprocedure::text
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND has_schema_privilege($1, n.oid, 'USAGE')
         AND p.prosecdef
         AND has_function_privilege($1, p.oid, 'EXECUTE')
         AND p.oid <> ALL(ARRAY(SELECT to_regprocedure(x)::oid FROM unnest($2::text[]) AS x))
       ORDER BY 1
     ) AS names`,
    [user, RESEAL_FUNCTIONS],
  );
  if (secdef.rows[0].names.length)
    throw new ProvisionError(
      `The frozen-column re-seal role may run functions beyond reseal_frozen_sealed: ${secdef.rows[0].names.slice(0, 5).join(", ")}${secdef.rows[0].names.length > 5 ? ", ..." : ""}. Revoke EXECUTE from PUBLIC and the role, then re-run.`,
    );
  // Same for the rest of the app schema, SECURITY DEFINER or not.
  const extra = await client.query(
    `SELECT ARRAY(
       SELECT p.oid::regprocedure::text
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'app'
         AND has_function_privilege($1, p.oid, 'EXECUTE')
         AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
         AND p.oid <> ALL(ARRAY(SELECT to_regprocedure(x)::oid FROM unnest($2::text[]) AS x))
       ORDER BY 1
     ) AS names`,
    [user, RESEAL_FUNCTIONS],
  );
  if (extra.rows[0].names.length)
    throw new ProvisionError(
      `The frozen-column re-seal role may run functions beyond reseal_frozen_sealed: ${extra.rows[0].names.slice(0, 5).join(", ")}${extra.rows[0].names.length > 5 ? ", ..." : ""}.`,
    );
  const schema = await client.query(
    "SELECT has_schema_privilege($1, 'app', 'USAGE') AS usage",
    [user],
  );
  if (!schema.rows[0].usage)
    throw new ProvisionError(
      `The frozen-column re-seal role has no USAGE on schema app; run the migrations, then re-run.`,
    );
}

async function auditReseal(client: ClientBase, user: string) {
  await assertRestricted(client, user, RESEAL_LABEL, [SEALED_RESEAL_GROUP], []);
  // No table or sequence right at all: the function does the work as its owner.
  await assertTableRights(client, user, RESEAL_LABEL, [], {});
  await assertSequenceRights(client, user, RESEAL_LABEL, [], []);
  await assertDefaultPrivileges(client, user, RESEAL_LABEL, [], [], []);
  await assertNoSensitive(client, user, RESEAL_LABEL);
  await assertNoParameterGrants(client, user, RESEAL_LABEL);
  await assertResealFunctions(client, user);
}

async function provisionReseal(client: ClientBase, login: Login) {
  await assertGroup(client, SEALED_RESEAL_GROUP);
  const outcome = await upsertLogin(client, login, RESEAL_LABEL);
  // INHERIT so the login runs the group's one function; never SET, so it cannot
  // SET ROLE to the group and pick its own tenant.
  await grantGroup(client, SEALED_RESEAL_GROUP, login.user, false);
  return outcome;
}

async function assertRegistry(client: ClientBase) {
  const registry = await client.query(
    "SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'app' AND c.relname = 'active_tenant_registry'",
  );
  if (registry.rows[0]?.relkind !== "v")
    throw new ProvisionError(
      "Run the migrations first: the trusted app.active_tenant_registry view does not exist.",
    );
}

async function provisionWorker(client: ClientBase, login: Login) {
  await assertRegistry(client);
  const outcome = await upsertLogin(client, login, "queue", true);
  const owner = await queueSchemaOwner(client);
  if (owner && owner !== login.user)
    throw new ProvisionError(
      `The pg-boss schema is owned by ${owner}, not ${login.user}. To change the queue login, rename the existing role so it keeps the queue's tables: as the migration owner run ALTER ROLE "${owner}" RENAME TO "${login.user}", then re-run (the job re-keys the password from worker.env).`,
    );
  if (!owner) {
    // A non-superuser CREATEROLE admin may only hand an object to a role it
    // can SET ROLE to, and creating a role grants ADMIN without SET, so grant
    // SET (never INHERIT) first.
    const admin = await client.query(
      "SELECT rolsuper FROM pg_roles WHERE rolname = current_user",
    );
    if (!admin.rows[0].rolsuper)
      await client.query(
        `GRANT "${login.user}" TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`,
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
  await auditWorker(client, login.user);
  return outcome;
}

async function queueSchemaOwner(
  client: ClientBase,
): Promise<string | undefined> {
  const owner = await client.query(
    "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1",
    [QUEUE_SCHEMA],
  );
  return owner.rows[0]?.owner;
}

export type ProvisionResult = {
  app: { user: string; outcome: "created" | "updated" };
  worker?: { user: string; outcome: "created" | "updated" };
  maintenance?: { user: string; outcome: "created" | "updated" };
  grantor?: { user: string; outcome: "created" | "updated" };
  reseal?: { user: string; outcome: "created" | "updated" };
};

/**
 * Creates or re-keys the restricted logins in one transaction, verifies them,
 * then signs in with each URL to confirm the identity PostgreSQL sees.
 * Idempotent: a second run with the same URLs succeeds and changes only the
 * stored verifier salt.
 */
export async function provisionRoles(options: {
  adminUrl: string;
  appUrl: string;
  workerUrl?: string;
  maintenanceUrl?: string;
  grantorUrl?: string;
  resealUrl?: string;
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
  const maintenance = options.maintenanceUrl
    ? parseLogin(
        options.adminUrl,
        options.maintenanceUrl,
        MAINT_LOGIN,
        "maintenance",
      )
    : undefined;
  const grantor = options.grantorUrl
    ? parseLogin(
        options.adminUrl,
        options.grantorUrl,
        GRANTOR_LOGIN,
        "payout grantor",
      )
    : undefined;
  const reseal = options.resealUrl
    ? parseLogin(
        options.adminUrl,
        options.resealUrl,
        RESEAL_LOGIN,
        RESEAL_LABEL,
      )
    : undefined;
  const { result, database } = await withAdmin(
    options.adminUrl,
    async (client) => {
      const result: ProvisionResult = {
        app: { user: app.user, outcome: await provisionApp(client, app) },
      };
      if (worker)
        result.worker = {
          user: worker.user,
          outcome: await provisionWorker(client, worker),
        };
      if (maintenance)
        result.maintenance = {
          user: maintenance.user,
          outcome: await provisionMaintenance(client, maintenance),
        };
      if (grantor)
        result.grantor = {
          user: grantor.user,
          outcome: await provisionGrantor(client, grantor),
        };
      if (reseal)
        result.reseal = {
          user: reseal.user,
          outcome: await provisionReseal(client, reseal),
        };
      await assertSealedResealRoleReachedOnly(
        client,
        [
          app.user,
          ...(worker ? [worker.user] : []),
          ...(maintenance ? [maintenance.user] : []),
          ...(grantor ? [grantor.user] : []),
        ],
        reseal?.user,
      );
      // After the group audit, so drift on the group alone names the group.
      if (reseal) await auditReseal(client, reseal.user);
      return { result, database: await currentDatabase(client) };
    },
  );
  await verifyIdentity(app, "application", database);
  if (worker) await verifyIdentity(worker, "queue", database);
  if (maintenance) await verifyIdentity(maintenance, "maintenance", database);
  if (grantor) await verifyIdentity(grantor, "payout grantor", database);
  if (reseal) await verifyIdentity(reseal, RESEAL_LABEL, database);
  return result;
}

async function assertLogin(client: ClientBase, user: string, label: string) {
  const role = await client.query(
    `SELECT rolcanlogin AND rolinherit AND rolconnlimit = -1
            AND (rolvaliduntil IS NULL OR rolvaliduntil = 'infinity') AS usable
     FROM pg_roles WHERE rolname = $1`,
    [user],
  );
  if (!role.rows.length)
    throw new ProvisionError(
      `The ${label} login ${user} does not exist yet; run deploy/single-vm/provision-roles.sh before starting the services.`,
    );
  if (!role.rows[0].usable)
    throw new ProvisionError(
      `The ${label} login ${user} cannot log in, does not inherit its group, or has a connection limit or expiry; re-run provision-roles.sh.`,
    );
  await assertNoSettings(
    client,
    user,
    label,
    label === "maintenance" ||
      label === "payout grantor" ||
      label === RESEAL_LABEL
      ? "none"
      : "required",
  );
}

/**
 * Verifies the provisioned state without changing anything (deploy.sh runs
 * it after every migration): both logins exist, keep their limits, and the
 * URLs sign in as them. Fails with the same messages as provisioning.
 */
export async function auditRoles(options: {
  adminUrl: string;
  appUrl: string;
  workerUrl: string;
  maintenanceUrl?: string;
  grantorUrl?: string;
  resealUrl?: string;
}) {
  const app = parseLogin(
    options.adminUrl,
    options.appUrl,
    APP_LOGIN,
    "application",
  );
  const worker = parseLogin(
    options.adminUrl,
    options.workerUrl,
    WORKER_LOGIN,
    "queue",
  );
  const maintenance = options.maintenanceUrl
    ? parseLogin(
        options.adminUrl,
        options.maintenanceUrl,
        MAINT_LOGIN,
        "maintenance",
      )
    : undefined;
  const grantor = options.grantorUrl
    ? parseLogin(
        options.adminUrl,
        options.grantorUrl,
        GRANTOR_LOGIN,
        "payout grantor",
      )
    : undefined;
  const reseal = options.resealUrl
    ? parseLogin(
        options.adminUrl,
        options.resealUrl,
        RESEAL_LOGIN,
        RESEAL_LABEL,
      )
    : undefined;
  const database = await withAdmin(
    options.adminUrl,
    async (client) => {
      await assertGroup(client);
      await assertGroup(client, SEALED_RESEAL_GROUP);
      await assertRegistry(client);
      await assertLogin(client, app.user, "application");
      const member = await client.query(
        "SELECT pg_has_role($1, $2, 'USAGE') AS member",
        [app.user, APP_GROUP],
      );
      if (!member.rows[0].member)
        throw new ProvisionError(
          `The application login ${app.user} does not inherit ${APP_GROUP}; re-run provision-roles.sh.`,
        );
      await auditApp(client, app.user);
      await assertLogin(client, worker.user, "queue");
      if ((await queueSchemaOwner(client)) !== worker.user)
        throw new ProvisionError(
          `The pg-boss schema is not owned by ${worker.user}; re-run provision-roles.sh.`,
        );
      const registry = await client.query(
        "SELECT has_table_privilege($1, 'app.active_tenant_registry', 'SELECT') AS granted",
        [worker.user],
      );
      if (!registry.rows[0].granted)
        throw new ProvisionError(
          `The queue login ${worker.user} cannot read app.active_tenant_registry; re-run provision-roles.sh.`,
        );
      await auditWorker(client, worker.user);
      if (maintenance) {
        await assertGroup(client, MAINT_GROUP);
        await assertLogin(client, maintenance.user, "maintenance");
        const member = await client.query(
          "SELECT pg_has_role($1, $2, 'USAGE') AS member",
          [maintenance.user, MAINT_GROUP],
        );
        if (!member.rows[0].member)
          throw new ProvisionError(
            `The maintenance login ${maintenance.user} does not inherit ${MAINT_GROUP}; re-run provision-roles.sh.`,
          );
        await auditMaintenance(client, maintenance.user);
      }
      if (grantor) {
        await assertGroup(client, GRANTOR_GROUP);
        await assertLogin(client, grantor.user, "payout grantor");
        const member = await client.query(
          "SELECT pg_has_role($1, $2, 'USAGE') AS member",
          [grantor.user, GRANTOR_GROUP],
        );
        if (!member.rows[0].member)
          throw new ProvisionError(
            `The payout grantor login ${grantor.user} does not inherit ${GRANTOR_GROUP}; re-run provision-roles.sh.`,
          );
        await auditGrantor(client, grantor.user);
      }
      await assertSealedResealRoleReachedOnly(
        client,
        [
          app.user,
          worker.user,
          ...(maintenance ? [maintenance.user] : []),
          ...(grantor ? [grantor.user] : []),
        ],
        reseal?.user,
      );
      if (reseal) {
        await assertLogin(client, reseal.user, RESEAL_LABEL);
        const member = await client.query(
          "SELECT pg_has_role($1, $2, 'USAGE') AS member",
          [reseal.user, SEALED_RESEAL_GROUP],
        );
        if (!member.rows[0].member)
          throw new ProvisionError(
            `The frozen-column re-seal login ${reseal.user} does not inherit ${SEALED_RESEAL_GROUP}; re-run provision-roles.sh.`,
          );
        await auditReseal(client, reseal.user);
      }
      await assertSecurityDefinerNotPublic(client);
      return currentDatabase(client);
    },
    false,
  );
  await verifyIdentity(app, "application", database);
  await verifyIdentity(worker, "queue", database);
  if (maintenance) await verifyIdentity(maintenance, "maintenance", database);
  if (grantor) await verifyIdentity(grantor, "payout grantor", database);
  if (reseal) await verifyIdentity(reseal, RESEAL_LABEL, database);
  return {
    app: app.user,
    worker: worker.user,
    ...(maintenance ? { maintenance: maintenance.user } : {}),
    ...(grantor ? { grantor: grantor.user } : {}),
    ...(reseal ? { reseal: reseal.user } : {}),
  };
}

/** Local development and test harness entry point (scripts/*.mjs). */
export async function provisionAppRole(adminUrl: string, appUrl: string) {
  await provisionRoles({
    adminUrl,
    appUrl,
    workerUrl: process.env.WORKER_DATABASE_URL || undefined,
    maintenanceUrl: process.env.MAINTENANCE_DATABASE_URL || undefined,
    // Optional only for this development and test harness; the deploy job
    // (provision-roles.ts) requires it (legend-786te).
    grantorUrl: process.env.PAYOUT_GRANTOR_DATABASE_URL || undefined,
    resealUrl: process.env.RESEAL_DATABASE_URL || undefined,
  });
}

/** Queue login only, for callers that manage the application login apart. */
export async function provisionWorkerRole(adminUrl: string, workerUrl: string) {
  const worker = parseLogin(adminUrl, workerUrl, WORKER_LOGIN, "queue");
  const database = await withAdmin(adminUrl, async (client) => {
    await provisionWorker(client, worker);
    return currentDatabase(client);
  });
  await verifyIdentity(worker, "queue", database);
}
