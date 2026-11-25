// 547b: explicit, one-invoice repair for legacy missing PPh 23 identities.
// Complete suppliers.npwp first and verify it is correct for the old invoice.
// Run from apps/api using the migration owner's connection:
// pnpm exec tsx src/db/repair-supplier-invoice-npwp.ts --tenant <uuid> \
//   --entity <uuid> --invoice <uuid> --actor <uuid> --reason '<audited reason>'
// Only the snapshot changes; its audit shares the transaction. No NPWP or
// connection string is printed. The ordinary app role remains immutable.
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { uuidSchema, userIdSchema, z } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { databaseError } from "./connection.ts";
import {
  assertMigrationOwner,
  migrationOwnerUrl,
  SafeError,
} from "./migration-owner.ts";

/** The built file runs without tsx; the source (tsx) keeps the dev fallback. */
const isBuilt = !import.meta.url.endsWith(".ts");

const USAGE =
  "Usage: pnpm exec tsx src/db/repair-supplier-invoice-npwp.ts --tenant <uuid> --entity <uuid> --invoice <uuid> --actor <uuid> --reason '<audited reason>'";
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const optionsSchema = z.strictObject({
  "--tenant": uuidSchema,
  "--entity": uuidSchema,
  "--invoice": uuidSchema,
  "--actor": userIdSchema,
  "--reason": z.string().trim().min(10).max(1000),
});
let pool: Pool | undefined;
try {
  if (args.length === 1 && args[0] === "--help") {
    console.log(USAGE);
  } else {
    if (args.length !== 10) throw new Error(USAGE);
    const pairs: Record<string, string> = {};
    for (let index = 0; index < args.length; index += 2) {
      const name = args[index]!;
      if (name in pairs) throw new Error(USAGE);
      pairs[name] = args[index + 1]!;
    }
    const parsed = optionsSchema.safeParse(pairs);
    if (!parsed.success) throw new Error(USAGE);
    const options = parsed.data;
    await import("../load-env.ts");
    const [{ repairSupplierInvoiceNpwpInTransaction }, schema] =
      await Promise.all([
        import("../services/accounting-ap.service.ts"),
        import("./schema/index.ts"),
      ]);
    pool = new Pool({
      connectionString: migrationOwnerUrl(isBuilt),
      max: 1,
      connectionTimeoutMillis: 5000,
    });
    await assertMigrationOwner(pool);
    const context = establishScopedTenantContext(
      establishTenantContext({
        tenantId: options["--tenant"],
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );
    const result = await drizzle(pool, { schema }).transaction((tx) =>
      repairSupplierInvoiceNpwpInTransaction(
        tx,
        context,
        {
          supplierInvoiceId: options["--invoice"],
          legalEntityId: options["--entity"],
          reason: options["--reason"],
        },
        options["--actor"],
      ),
    );
    console.log(`Supplier invoice NPWP snapshot: ${result}.`);
  }
} catch (error) {
  console.error(
    error instanceof SafeError ||
      (error instanceof Error && error.message === USAGE)
      ? (error as Error).message
      : databaseError(error),
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
