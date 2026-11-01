import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { tenantIdSchema } from "@starter/shared/core";
import { eventFixture } from "@starter/shared/events";
import * as schema from "../db/schema";
import { withTenant } from "../db/tenant";
import {
  appendOutbox,
  consumeOutbox,
  relayOutbox,
} from "../services/core-outbox";

const appPool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const database = drizzle(appPool, { schema });
const context = (tenantId: string) =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
const tenantA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const tenantB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const event = { ...eventFixture, tenantId: tenantA, outletId: null };
const row = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  event,
  destination: "test",
  direction: null,
  peerId: null,
} as const;

afterAll(async () => {
  await appPool.end();
});
describe("transactional domain event outbox", () => {
  it("rolls back an event together with its domain write", async () => {
    await expect(
      withTenant(database, context(tenantA), async (tx) => {
        await appendOutbox(tx, context(tenantA), row);
        throw new Error("domain failure");
      }),
    ).rejects.toThrow("domain failure");
    await withTenant(database, context(tenantA), async (tx) => {
      const result = await tx.execute(sql`SELECT id FROM domain_event_outbox`);
      expect(result.rows).toHaveLength(0);
    });
  });
  it("isolates tenant rows and rejects a mismatched event tenant", async () => {
    await withTenant(database, context(tenantA), async (tx) => {
      await appendOutbox(tx, context(tenantA), row);
    });
    await withTenant(database, context(tenantB), async (tx) => {
      expect(
        (await tx.execute(sql`SELECT id FROM domain_event_outbox`)).rows,
      ).toHaveLength(0);
      await expect(appendOutbox(tx, context(tenantB), row)).rejects.toThrow();
    });
  });
  it("orders aggregate delivery, deduplicates replay and preserves the provider key across a crash", async () => {
    const first = {
      ...row,
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
      event: { ...event, id: "01ARZ3NDEKTSV4RRFFQ69G5FAZ", sequence: 1 },
    };
    await withTenant(database, context(tenantA), async (tx) => {
      await appendOutbox(tx, context(tenantA), first);
    });
    const accepted = new Set<string>();
    let crash = true;
    const input = (outboxId: string) => ({
      outboxId,
      authorize: async () => true,
      deliver: async (_event: unknown, key: string) => {
        accepted.add(key);
        if (crash) {
          crash = false;
          throw new Error("crash after accept");
        }
      },
    });
    await expect(
      consumeOutbox(database, context(tenantA), input(row.id)),
    ).rejects.toThrow("Earlier aggregate event");
    await expect(
      consumeOutbox(database, context(tenantA), input(first.id)),
    ).rejects.toThrow("crash after accept");
    expect(
      await consumeOutbox(database, context(tenantA), input(first.id)),
    ).toBe(true);
    expect(
      await consumeOutbox(database, context(tenantA), input(first.id)),
    ).toBe(false);
    expect(await consumeOutbox(database, context(tenantA), input(row.id))).toBe(
      true,
    );
    expect(accepted.size).toBe(2);
    expect(accepted.has(first.event.id)).toBe(true);
    const jobs: unknown[] = [];
    expect(
      await relayOutbox(database, context(tenantA), async (job) => {
        jobs.push(job);
      }),
    ).toBe(0);
    expect(jobs).toEqual([]);
  });
});
