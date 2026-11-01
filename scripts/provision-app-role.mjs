import { Client } from "pg";

// The provisioning connection is an owner/admin connection. Never use it in
// the API process. A generated login is deliberately separate from the owner.
export async function provisionAppRole(adminUrl, appUrl) {
  const url = new URL(appUrl);
  const admin = new URL(adminUrl);
  if (url.host !== admin.host || url.pathname !== admin.pathname)
    throw new Error(
      "Application and migration URLs must point to the same database.",
    );
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (
    !/^legend_runtime_[a-f0-9]{16}$/.test(user) ||
    !/^[a-f0-9]{48}$/.test(password)
  )
    throw new Error("The managed application login has invalid credentials.");
  const client = new Client({
    connectionString: adminUrl,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    const existing = await client.query(
      "SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin FROM pg_roles WHERE rolname = $1",
      [user],
    );
    if (existing.rows.length) {
      const r = existing.rows[0];
      if (
        r.rolsuper ||
        r.rolbypassrls ||
        r.rolcreatedb ||
        r.rolcreaterole ||
        r.rolreplication ||
        !r.rolcanlogin
      )
        throw new Error(
          "The managed application role already exists with unsafe privileges.",
        );
    } else {
      // Identifiers/password are generated hexadecimal and validated above.
      await client.query(
        `CREATE ROLE "${user}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}'`,
      );
    }
    await client.query(`GRANT legend_app TO "${user}"`);
  } finally {
    await client.end();
  }
  if (process.env.WORKER_DATABASE_URL)
    await provisionWorkerRole(adminUrl, process.env.WORKER_DATABASE_URL);
}

// Queue credentials own only the pg-boss schema and can enumerate active tenant
// IDs through a filtered view. They must never be used for tenant domain data.
export async function provisionWorkerRole(adminUrl, workerUrl) {
  const url = new URL(workerUrl);
  const admin = new URL(adminUrl);
  if (url.host !== admin.host || url.pathname !== admin.pathname)
    throw new Error(
      "Worker and migration URLs must point to the same database.",
    );
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (
    !/^legend_worker_[a-f0-9]{16}$/.test(user) ||
    !/^[a-f0-9]{48}$/.test(password)
  )
    throw new Error("The managed worker login has invalid credentials.");
  const client = new Client({
    connectionString: adminUrl,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    const registry = await client.query(
      "SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'app' AND c.relname = 'active_tenant_registry'",
    );
    if (registry.rows[0]?.relkind !== "v")
      throw new Error(
        "Cannot provision worker: trusted app.active_tenant_registry view does not exist.",
      );
    const existing = await client.query(
      "SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin FROM pg_roles WHERE rolname = $1",
      [user],
    );
    if (existing.rows.length) {
      const r = existing.rows[0];
      if (
        r.rolsuper ||
        r.rolbypassrls ||
        r.rolcreatedb ||
        r.rolcreaterole ||
        r.rolreplication ||
        !r.rolcanlogin
      )
        throw new Error(
          "The managed worker role already exists with unsafe privileges.",
        );
    } else {
      await client.query(
        `CREATE ROLE "${user}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}'`,
      );
    }
    const unsafe = await client.query(
      `SELECT EXISTS (SELECT 1 FROM pg_roles r WHERE (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolname = 'legend_app') AND pg_has_role($1, r.oid, 'MEMBER')) AS unsafe`,
      [user],
    );
    if (unsafe.rows[0].unsafe)
      throw new Error("The worker role inherits unsafe privileges.");
    const owner = await client.query(
      "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'pgboss'",
    );
    if (owner.rows.length && owner.rows[0].owner !== user)
      throw new Error("The pg-boss schema is owned by a different role.");
    if (!owner.rows.length)
      await client.query(`CREATE SCHEMA pgboss AUTHORIZATION "${user}"`);
    await client.query("REVOKE ALL ON app.active_tenant_registry FROM PUBLIC");
    await client.query(`GRANT USAGE ON SCHEMA app TO "${user}"`);
    await client.query(
      `GRANT SELECT ON app.active_tenant_registry TO "${user}"`,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}
