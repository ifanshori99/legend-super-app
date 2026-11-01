// Called by the development/test bootstrap as the migration owner, never by the app.
import { Pool } from "pg";
import { cafeLegendFixtures } from "@starter/shared/core";
import { databaseUrl } from "./connection";

if (
  (process.env.DEPLOYMENT_MODE ?? "development") !== "development" ||
  (process.env.DATA_CLASSIFICATION ?? "synthetic") !== "synthetic" ||
  process.env.NODE_ENV === "production"
) {
  throw new Error("Synthetic tenant seeding is permitted only in development.");
}
const pool = new Pool({
  connectionString: databaseUrl(process.env.MIGRATION_DATABASE_URL),
  max: 1,
});
try {
  await pool.query(
    "INSERT INTO app.dev_tenant_lookup (singleton, tenant_id, brand_id) VALUES (true, $1, $2) ON CONFLICT (singleton) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, brand_id = EXCLUDED.brand_id",
    [cafeLegendFixtures.tenant.id, cafeLegendFixtures.brand.id],
  );
} finally {
  await pool.end();
}
