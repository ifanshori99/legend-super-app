import { Pool, type ClientBase, type PoolConfig, type PoolClient } from "pg";
import type { ConstructorOptions } from "pg-boss";

/** Check every new physical connection before any application query can run. */
export function createAppPool(
  connectionString: string,
  options: PoolConfig = {},
) {
  return new Pool({
    ...options,
    connectionString,
    verify(client, done) {
      client.query(
        `SELECT
        NOT pg_has_role(current_user, 'legend_app', 'MEMBER') OR
        EXISTS (SELECT 1 FROM pg_roles r WHERE
          (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication)
          AND (pg_has_role(current_user, r.oid, 'MEMBER') OR pg_has_role(session_user, r.oid, 'MEMBER'))) OR
        EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relrowsecurity AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND (pg_has_role(current_user, c.relowner, 'MEMBER') OR pg_has_role(session_user, c.relowner, 'MEMBER')))
        AS unsafe`,
        (error, result) => {
          if (error) return done(error);
          if (result.rows[0]?.unsafe !== false)
            return done(
              new Error("Unsafe database role for application access"),
            );
          done();
        },
      );
    },
  });
}

const UNSAFE_QUEUE_ROLE_SQL = `SELECT
        pg_has_role(current_user, 'legend_app', 'MEMBER') OR
        pg_has_role(session_user, 'legend_app', 'MEMBER') OR
        EXISTS (SELECT 1 FROM pg_roles r WHERE
          (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication)
          AND (pg_has_role(current_user, r.oid, 'MEMBER') OR pg_has_role(session_user, r.oid, 'MEMBER'))) OR
        EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relrowsecurity AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND (pg_has_role(current_user, c.relowner, 'MEMBER') OR pg_has_role(session_user, c.relowner, 'MEMBER')))
        AS unsafe`;

/**
 * Refuse privileged, bypass-capable, RLS-owning, or application-role logins
 * before any queue query runs. Errors never carry the connection string.
 */
export async function assertQueueRole(client: Pick<ClientBase, "query">) {
  const result = await client.query(UNSAFE_QUEUE_ROLE_SQL);
  if (result.rows[0]?.unsafe !== false)
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
