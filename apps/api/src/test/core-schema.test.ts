import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eventEnvelopeSchema, eventFixture } from "@starter/shared/events";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { tenantIdSchema } from "@starter/shared/core";
import * as schema from "../db/schema";
import { withTenant } from "../db/tenant";

const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const database = drizzle(pool, { schema });
const tenant = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const context = establishScopedTenantContext(
  establishTenantContext({
    tenantId: tenantIdSchema.parse(tenant),
    brandId: null,
    source: "domain",
  }),
  { kind: "tenant" },
);

afterAll(async () => {
  await pool.end();
});

describe("outbox aggregate outlet invariant", () => {
  it("rejects different outlets across destinations while allowing late earlier events", async () => {
    const aggregateId = randomUUID();
    const outletId = randomUUID();
    const insert = (
      sequence: number,
      outlet: string | null,
      destination: string,
    ) =>
      withTenant(database, context, async (tx) => {
        const event = eventEnvelopeSchema.parse({
          ...eventFixture,
          tenantId: tenant,
          outletId: outlet,
          sequence,
        });
        await tx.insert(schema.domainEventOutbox).values({
          tenantId: tenant,
          id: randomUUID(),
          outletId: outlet,
          eventId: randomUUID(),
          aggregateType: event.aggregateType,
          aggregateId,
          sequence,
          event,
          destination,
        });
      });
    await insert(2, outletId, "primary");
    await insert(1, outletId, "secondary");
    await expect(insert(3, randomUUID(), "other")).rejects.toThrow();
    await expect(insert(3, null, "other")).rejects.toThrow();
  });
});
