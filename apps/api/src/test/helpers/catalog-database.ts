// Each catalog suite owns its cloud as well as its edge. A private tenant alone
// cannot isolate database-wide transaction snapshots or mutable fixture rows.
import { randomUUID } from "node:crypto";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { createEdgeDatabase } from "./edge-database.ts";

/** Run from vi.hoisted, before any module creates the application's pool. */
export async function createCatalogCloud() {
  const original = {
    STARTER_TEST_DATABASE_URL: process.env.STARTER_TEST_DATABASE_URL,
    DATABASE_URL: process.env.DATABASE_URL,
    APP_DATABASE_URL: process.env.APP_DATABASE_URL,
  };
  const cloud = await createEdgeDatabase({
    tenantId: cafeLegendPlatformFixtures.tenant.id,
    outletId: cafeLegendAccessFixtures.outletIds.bandung,
  });
  try {
    // The sync suite needs one author for recipes; no shared seeded user or
    // synthetic seed script is needed in this cloud.
    const userId = randomUUID();
    await cloud.owner.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1, 'Catalog author', $2)`,
      [userId, `${userId}@catalog.example.test`],
    );
  } catch (error) {
    await cloud.cleanup();
    throw error;
  }
  process.env.STARTER_TEST_DATABASE_URL = cloud.ownerUrl;
  process.env.DATABASE_URL = cloud.appUrl;
  process.env.APP_DATABASE_URL = cloud.appUrl;
  return {
    name: cloud.name,
    parentDatabaseName: new URL(original.STARTER_TEST_DATABASE_URL!).pathname,
    async cleanup() {
      await cloud.cleanup();
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}
