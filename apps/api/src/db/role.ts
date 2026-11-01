import { Pool, type PoolConfig } from "pg";

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
