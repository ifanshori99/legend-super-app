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
}
