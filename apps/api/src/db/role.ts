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

const PRIVILEGED_OR_RLS_OWNER_SQL = `EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE
          (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication)
          AND (pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER') OR pg_catalog.pg_has_role(session_user, r.oid, 'MEMBER'))) OR
        EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relrowsecurity AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND (pg_catalog.pg_has_role(current_user, c.relowner, 'MEMBER') OR pg_catalog.pg_has_role(session_user, c.relowner, 'MEMBER')))`;

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
