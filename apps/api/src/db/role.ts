import { Pool, type ClientBase, type PoolConfig, type PoolClient } from "pg";
import type { ConstructorOptions } from "pg-boss";

/**
 * Every function and catalog is schema-qualified, and the guard runs in its own
 * transaction with `SET LOCAL search_path`, so neither a shadowing function,
 * relation or operator in a schema the login can write to, nor an owner URL
 * `options=-c search_path=...`, can change the answer. `SET LOCAL` ends with
 * the transaction: the session's own search_path is untouched afterwards.
 */
const GUARD_SEARCH_PATH_SQL = "SET LOCAL search_path TO pg_catalog, pg_temp";

/**
 * `includeSession: false` looks at `current_user` only: the development and
 * test grantor fallback runs as the owner's session after `SET LOCAL ROLE`,
 * where `session_user` is the owner by design.
 */
const privilegedOrRlsOwnerSql = (includeSession: boolean) => {
  const member = (role: string) =>
    includeSession
      ? `(pg_catalog.pg_has_role(current_user, ${role}, 'MEMBER') OR pg_catalog.pg_has_role(session_user, ${role}, 'MEMBER'))`
      : `pg_catalog.pg_has_role(current_user, ${role}, 'MEMBER')`;
  return `EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE
          (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication)
          AND ${member("r.oid")}) OR
        EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relrowsecurity AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND ${member("c.relowner")})`;
};

const PRIVILEGED_OR_RLS_OWNER_SQL = privilegedOrRlsOwnerSql(true);

const UNSAFE_APP_ROLE_SQL = `SELECT
        NOT pg_catalog.pg_has_role(current_user, 'legend_app', 'MEMBER') OR
        ${PRIVILEGED_OR_RLS_OWNER_SQL}
        AS unsafe`;

const UNSAFE_QUEUE_ROLE_SQL = `SELECT
        pg_catalog.pg_has_role(current_user, 'legend_app', 'MEMBER') OR
        pg_catalog.pg_has_role(session_user, 'legend_app', 'MEMBER') OR
        ${PRIVILEGED_OR_RLS_OWNER_SQL}
        AS unsafe`;

// The maintenance login (legend-usyi) may only run the audit retention
// functions through `legend_maintenance`: it is no application login, holds no
// elevated attribute and owns no RLS table.
const UNSAFE_MAINTENANCE_ROLE_SQL = `SELECT
        session_user::text !~ '^legend_maint_[a-f0-9]{16}$' OR
        pg_catalog.pg_has_role(current_user, 'legend_app', 'MEMBER') OR
        pg_catalog.pg_has_role(session_user, 'legend_app', 'MEMBER') OR
        NOT pg_catalog.pg_has_role(current_user, 'legend_maintenance', 'MEMBER') OR
        NOT pg_catalog.pg_has_role(session_user, 'legend_maintenance', 'MEMBER') OR
        ${PRIVILEGED_OR_RLS_OWNER_SQL}
        AS unsafe`;

// The payout grantor login (legend-911) may only run app.payout_grant_issue
// through `legend_payout_grantor`: it is no application login, holds no
// elevated attribute and owns no RLS table.
const UNSAFE_GRANTOR_ROLE_SQL = `SELECT
        session_user::text !~ '^legend_grant_[a-f0-9]{16}$' OR
        pg_catalog.pg_has_role(current_user, 'legend_app', 'MEMBER') OR
        pg_catalog.pg_has_role(session_user, 'legend_app', 'MEMBER') OR
        NOT pg_catalog.pg_has_role(current_user, 'legend_payout_grantor', 'MEMBER') OR
        NOT pg_catalog.pg_has_role(session_user, 'legend_payout_grantor', 'MEMBER') OR
        ${PRIVILEGED_OR_RLS_OWNER_SQL}
        AS unsafe`;

// Development and test only (no PAYOUT_GRANTOR_DATABASE_URL): the pool runs on
// DATABASE_URL, and every issue transaction starts with SET LOCAL ROLE
// legend_payout_grantor. The check runs under that role, so what counts is the
// effective role, not the owner login behind it.
const UNSAFE_GRANTOR_FALLBACK_SQL = `SELECT
        current_user::text <> 'legend_payout_grantor' OR
        pg_catalog.pg_has_role(current_user, 'legend_app', 'MEMBER') OR
        ${privilegedOrRlsOwnerSql(false)}
        AS unsafe`;

/** Run a guard query inside its own transaction; true only when unsafe is false. */
async function isSafeRole(client: Pick<ClientBase, "query">, sql: string) {
  await client.query("BEGIN");
  try {
    await client.query(GUARD_SEARCH_PATH_SQL);
    const result = await client.query(sql);
    await client.query("COMMIT");
    return result.rows[0]?.unsafe === false;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

/** Check every new physical connection before any application query can run. */
export function createAppPool(
  connectionString: string,
  options: PoolConfig = {},
) {
  return new Pool({
    ...options,
    connectionString,
    verify(client, done) {
      isSafeRole(client, UNSAFE_APP_ROLE_SQL).then(
        (safe) =>
          done(
            safe
              ? undefined
              : new Error("Unsafe database role for application access"),
          ),
        (error: unknown) =>
          done(error instanceof Error ? error : new Error(String(error))),
      );
    },
  });
}

/**
 * Refuse privileged, bypass-capable, RLS-owning, or application-role logins
 * before any queue query runs. Errors never carry the connection string.
 */
export async function assertQueueRole(client: Pick<ClientBase, "query">) {
  if (!(await isSafeRole(client, UNSAFE_QUEUE_ROLE_SQL)))
    throw new Error("Unsafe database role for queue access");
}

/** pg `verify` callback for the queue (pg-boss and registry) login pool. */
export function verifyQueueConnection(
  client: PoolClient,
  done: (error?: Error) => void,
) {
  assertQueueRole(client).then(
    () => done(),
    (error: unknown) =>
      done(error instanceof Error ? error : new Error(String(error))),
  );
}

/**
 * pg-boss hands its options straight to `new pg.Pool(config)`, but its type
 * omits pg's `verify`; extend it locally so every pg-boss pool is guarded.
 */
export function queueBossOptions(
  connectionString: string,
): ConstructorOptions & Pick<PoolConfig, "verify"> {
  return {
    connectionString,
    createSchema: false,
    verify: verifyQueueConnection,
  };
}

/**
 * Refuse an application login, a privileged, bypass-capable or RLS-owning
 * login, or one that is not a member of `legend_maintenance`, before any
 * maintenance query runs. Errors never carry the connection string.
 */
export async function assertMaintenanceRole(client: Pick<ClientBase, "query">) {
  if (!(await isSafeRole(client, UNSAFE_MAINTENANCE_ROLE_SQL)))
    throw new Error("Unsafe database role for maintenance access");
}

/** pg `verify` callback for the audit retention (maintenance login) pool. */
export function verifyMaintenanceConnection(
  client: PoolClient,
  done: (error?: Error) => void,
) {
  assertMaintenanceRole(client).then(
    () => done(),
    (error: unknown) =>
      done(error instanceof Error ? error : new Error(String(error))),
  );
}

/**
 * Refuse an application login, a privileged, bypass-capable or RLS-owning
 * login, or one that is not a member of `legend_payout_grantor`, before any
 * grant is issued. Errors never carry the connection string.
 */
export async function assertGrantorRole(client: Pick<ClientBase, "query">) {
  if (!(await isSafeRole(client, UNSAFE_GRANTOR_ROLE_SQL)))
    throw new Error("Unsafe database role for payout grantor access");
}

/**
 * Development and test fallback: the connection must be able to become
 * `legend_payout_grantor`, and that role must be safe. Same transaction as the
 * guard, so `SET LOCAL ROLE` ends with it.
 */
export async function assertGrantorFallbackRole(
  client: Pick<ClientBase, "query">,
) {
  await client.query("BEGIN");
  try {
    await client.query(GUARD_SEARCH_PATH_SQL);
    await client.query("SET LOCAL ROLE legend_payout_grantor");
    const result = await client.query(UNSAFE_GRANTOR_FALLBACK_SQL);
    await client.query("COMMIT");
    if (result.rows[0]?.unsafe !== false)
      throw new Error("Unsafe database role for payout grantor access");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

/**
 * Pool for the payout grantor login, every new connection checked before use.
 * `fallbackRole` (development and test only, when PAYOUT_GRANTOR_DATABASE_URL
 * is unset) accepts a pool on DATABASE_URL whose issue transactions run `SET
 * LOCAL ROLE legend_payout_grantor`; the caller must do that SET LOCAL. Never
 * share the application pool: a payout transaction holds one of its
 * connections while it issues the grant.
 */
export function createGrantorPool(
  connectionString: string,
  options: PoolConfig = {},
  { fallbackRole = false }: { fallbackRole?: boolean } = {},
) {
  return new Pool({
    ...options,
    connectionString,
    verify(client, done) {
      (fallbackRole
        ? assertGrantorFallbackRole(client)
        : assertGrantorRole(client)
      ).then(
        () => done(),
        (error: unknown) =>
          done(error instanceof Error ? error : new Error(String(error))),
      );
    },
  });
}
