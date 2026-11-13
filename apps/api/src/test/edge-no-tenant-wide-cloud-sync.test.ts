// legend-7h5s: an edge node must not produce a tenant-wide (no outletId)
// event routed to the `cloud-sync` destination. The worker transport
// dead-letters such an event after the fact (worker/transport.ts); the
// producer (appendOutbox) now refuses it up front with a clear error.
//
// Written from the brief (docs/briefs/647-shared-context.md section C), not
// from the implementation.
//
// Assumptions:
// - Edge mode is read from process.env.EDGE_MODE at call time (precedent:
//   edge-access-applier.test.ts sets and restores it around the call). If the
//   implementer picks another seam, only `withEdgeMode` below changes.
// - "Refused" = appendOutbox rejects and nothing is written to the outbox.
//   The message is pinned loosely to /tenant-wide/i ("clear error").
// - An edge event WITH an outletId and destination cloud-sync is allowed.
// - An edge tenant-wide event with a non-cloud-sync destination stays
//   allowed (identity session.revoked uses such a destination).
// - The cloud (EDGE_MODE off or "false") is unaffected for every shape.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import {
  createUlid,
  tenantIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventFixture } from "@starter/shared/events";
import * as schema from "../db/schema";
import { withTenant } from "../db/tenant";
import { appendOutbox } from "../services/core-outbox";
import { setEdgeNodeForTests } from "../edge/mode";

const appPool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const database = drizzle(appPool, { schema });
const tenantId = randomUUID();
const outletId = randomUUID();

const context = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );

function outboxRow(input: { outletId: string | null; destination: string }) {
  return {
    id: createUlid(),
    event: {
      ...eventFixture,
      id: createUlid(),
      tenantId,
      outletId: input.outletId,
      name: "points.earned",
      aggregateType: "points",
      aggregateId: createUlid(),
      sequence: 1,
      idempotencyKey: `idem-${randomUUID()}`,
      payloadSchemaRef: "points.earned.v1",
      payload: {},
    },
    destination: input.destination,
    direction: null,
    peerId: null,
  } as const;
}

async function append(row: ReturnType<typeof outboxRow>) {
  await withTenant(database, context(), (tx) =>
    appendOutbox(tx, context(), row),
  );
}

async function outboxCount(eventId: string): Promise<number> {
  return withTenant(database, context(), async (tx) => {
    const result = await tx.execute(
      sql`SELECT id FROM domain_event_outbox WHERE event->>'id' = ${eventId}`,
    );
    return result.rows.length;
  });
}

// Seam: setEdgeNodeForTests (edge/mode.ts); env.EDGE_MODE is parsed once at load.
function setEdgeMode(value: "true" | "false" | undefined) {
  setEdgeNodeForTests(value === "true" ? () => true : () => false);
}

afterEach(() => {
  setEdgeNodeForTests(null);
});
afterAll(async () => {
  await appPool.end();
});

describe("legend-7h5s edge producer guard for tenant-wide cloud-sync events", () => {
  it("refuses a tenant-wide cloud-sync event on an edge node and writes nothing", async () => {
    setEdgeMode("true");
    const row = outboxRow({ outletId: null, destination: "cloud-sync" });
    await expect(append(row)).rejects.toThrow(/tenant-wide/i);
    expect(await outboxCount(row.event.id)).toBe(0);
  });

  it("allows an outlet-scoped cloud-sync event on an edge node", async () => {
    setEdgeMode("true");
    const row = outboxRow({ outletId, destination: "cloud-sync" });
    await append(row);
    expect(await outboxCount(row.event.id)).toBe(1);
  });

  it("allows a tenant-wide event with a non-cloud-sync destination on an edge node", async () => {
    setEdgeMode("true");
    const row = outboxRow({ outletId: null, destination: "test" });
    await append(row);
    expect(await outboxCount(row.event.id)).toBe(1);
  });

  it("does not affect the cloud when EDGE_MODE is false", async () => {
    setEdgeMode("false");
    const row = outboxRow({ outletId: null, destination: "cloud-sync" });
    await append(row);
    expect(await outboxCount(row.event.id)).toBe(1);
  });

  it("does not affect the cloud when EDGE_MODE is unset", async () => {
    setEdgeMode(undefined);
    const row = outboxRow({ outletId: null, destination: "cloud-sync" });
    await append(row);
    expect(await outboxCount(row.event.id)).toBe(1);
  });
});
