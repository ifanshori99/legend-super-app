// Backfill of the standard defaults for tenants created before provisioning
// existed (PRD v1.7 §3.19 chart of accounts and mappings, §16 Lokasi Stok;
// beads legend-a7x7 and legend-4ryw):
//   pnpm db:backfill-defaults [--tenant <id>]
//
// Per tenant: standard F&B chart + default mappings for each legal entity
// that has no account yet, the standard UOM catalog, and the six stock
// locations of each outlet that lacks a type, and the default PBJT rule and tax
// settings for a tenant that has none (legend-9obf). Idempotent and insert-only: an
// existing row is never changed, and a chart a tenant already has is never
// mixed with the template. Prints counts per tenant id, no personal data.
import "../load-env";
import { eq } from "drizzle-orm";
import { backfillTenantCharts } from "../services/accounting-provisioning.service";
import { backfillTenantInventoryDefaults } from "../services/inventory-provisioning.service";
import { backfillTenantTaxDefaults } from "../services/tax-provisioning.service";
import { databaseError } from "./connection";
import { db, pool } from "./index";
import { tenants } from "./schema";

// pnpm forwards a literal "--" when called as `pnpm db:backfill-defaults -- ...`.
const args = process.argv.slice(2).filter((arg) => arg !== "--");
let onlyTenant: string | undefined;
if (args.length > 0) {
  if (args[0] !== "--tenant" || !args[1] || args.length > 2) {
    console.error("Usage: pnpm db:backfill-defaults [--tenant <id>]");
    process.exit(1);
  }
  onlyTenant = args[1];
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      onlyTenant,
    )
  ) {
    console.error(`--tenant must be a tenant id (UUID), got "${onlyTenant}".`);
    process.exit(1);
  }
}

try {
  const rows = onlyTenant
    ? await db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.id, onlyTenant))
    : await db.select({ id: tenants.id }).from(tenants);
  if (onlyTenant && rows.length === 0)
    throw new Error(`Tenant ${onlyTenant} does not exist.`);

  for (const { id } of rows) {
    const charts = await backfillTenantCharts(id);
    const inventory = await backfillTenantInventoryDefaults(id);
    // A tax failure (e.g. the owner publishing a rule at the same moment hits
    // the unique version key) must not skip the tenants after this one; rerun
    // the backfill to finish it. The exit code still reports the failure.
    try {
      const tax = await backfillTenantTaxDefaults(id);
      console.log(
        `tenant ${id}: tax rules inserted ${tax.rulesInserted}, tax settings inserted ${tax.settingsInserted}`,
      );
      // Existing tax config is never changed; a tenant that cannot price
      // orders must be completed by its owner through the tax routes.
      if (!tax.priceReady)
        console.warn(
          `  tenant ${id}: skipped, not price-ready (no published active tenant-wide tax rule or tax settings)`,
        );
    } catch (error) {
      console.error(
        `tenant ${id}: tax defaults failed: ${databaseError(error)}`,
      );
      process.exitCode = 1;
    }
    const provisioned = charts.filter((c) => c.status === "provisioned");
    console.log(
      `tenant ${id}: legal entities ${charts.length}, charts provisioned ${provisioned.length}, ` +
        `accounts ${provisioned.reduce((n, c) => n + c.accounts, 0)}, ` +
        `mappings ${provisioned.reduce((n, c) => n + c.mappings, 0)}, ` +
        `uoms inserted ${inventory.uomsInserted}, outlets ${inventory.outlets}, ` +
        `stock locations inserted ${inventory.locationsInserted}`,
    );
    // Existing charts are never changed; an entity with unmapped posting roles
    // must be completed by the tenant through the CoA routes, or its automatic
    // journals for those roles are refused.
    for (const chart of charts)
      if (chart.missingRoles > 0)
        console.warn(
          `  legal entity ${chart.legalEntityId}: ${chart.missingRoles} posting role(s) unmapped`,
        );
  }
  console.log(`Backfill finished for ${rows.length} tenant(s).`);
} catch (error) {
  // Our own errors (unknown tenant, invalid template) carry no driver code and
  // a safe message; only driver errors go through `databaseError`, which
  // replaces their text so no connection detail is printed.
  const driverError =
    typeof error === "object" &&
    error !== null &&
    ("code" in error ||
      (error instanceof Error &&
        typeof error.cause === "object" &&
        error.cause !== null &&
        "code" in error.cause));
  console.error(
    !driverError && error instanceof Error
      ? error.message
      : databaseError(error),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
