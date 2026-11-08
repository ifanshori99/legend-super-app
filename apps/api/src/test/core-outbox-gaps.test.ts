import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createUlid, tenantIdSchema, ulidToUuid } from "@starter/shared/core";
import { eventFixture } from "@starter/shared/events";
import * as schema from "../db/schema";
import { withTenant } from "../db/tenant";
import {
  appendOutbox,
  consumeOutbox,
  relayOutbox,
} from "../services/core-outbox";
import {
  recordOutboxGapRequest,
  resolveFilledOutboxGaps,
} from "../services/core-outbox-gaps";

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

afterAll(async () => {
  await appPool.end();
});

function outboxRow(tenantId: string, aggregateId: string, sequence: number) {
  return {
    id: createUlid(),
    event: {
      ...eventFixture,
      id: createUlid(),
      tenantId,
      outletId: null,
      aggregateId,
      sequence,
    },
    destination: "test",
    direction: null,
    peerId: null,
  };
}

async function append(tenantId: string, row: ReturnType<typeof outboxRow>) {
  await withTenant(database, context(tenantId), (tx) =>
    appendOutbox(tx, context(tenantId), row),
  );
}

async function gapRows(tenantId: string) {
  return withTenant(database, context(tenantId), async (tx) => {
    const result = await tx.execute(
      sql`SELECT request_count, resolved_at FROM domain_event_gap_requests`,
    );
    return result.rows as { request_count: number; resolved_at: Date | null }[];
  });
}

const allow = async () => true;
const noop = async () => {};

describe("outbox gap requests", () => {
  it("legend-18qw repeated gap request is one row, counted at most once a minute", async () => {
    const tenant = randomUUID();
    const gap = {
      destination: "test",
      aggregateType: "pos_order",
      aggregateId: createUlid(),
      missingSequence: 1,
    };
    // Pretend the last request was two minutes ago.
    const ageLastRequest = () =>
      withTenant(database, context(tenant), (tx) =>
        tx.execute(
          sql`UPDATE domain_event_gap_requests SET last_requested_at = now() - interval '2 minutes'`,
        ),
      );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        await recordOutboxGapRequest(database, context(tenant), gap),
      ).toEqual({ requestCount: 1, counted: true });
      // The next tick within a minute neither counts nor rewrites the row.
      expect(
        await recordOutboxGapRequest(database, context(tenant), gap),
      ).toEqual({ requestCount: 1, counted: false });
      await ageLastRequest();
      expect(
        await recordOutboxGapRequest(database, context(tenant), gap),
      ).toEqual({ requestCount: 2, counted: true });
      await ageLastRequest();
      expect(
        await recordOutboxGapRequest(database, context(tenant), gap),
      ).toEqual({ requestCount: 3, counted: true });
      // Logged for counts 1 and 2 (powers of two), throttled for 3.
      expect(error).toHaveBeenCalledTimes(2);
      expect(error.mock.calls[0]?.[0]).toBe(
        `Outbox sequence gap: destination=test aggregateType=pos_order missingSequence=1 requests=1`,
      );
    } finally {
      error.mockRestore();
    }
    const rows = await gapRows(tenant);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.request_count).toBe(3);
    // The ULID aggregate id is stored as its lossless UUID.
    await withTenant(database, context(tenant), async (tx) => {
      const result = await tx.execute(
        sql`SELECT aggregate_id FROM domain_event_gap_requests`,
      );
      expect(result.rows[0]).toEqual({
        aggregate_id: ulidToUuid(gap.aggregateId),
      });
    });
  });

  it("legend-18qw a resolved gap requested again within a minute is reopened and counted", async () => {
    const tenant = randomUUID();
    const gap = {
      destination: "test",
      aggregateType: "pos_order",
      aggregateId: createUlid(),
      missingSequence: 1,
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        await recordOutboxGapRequest(database, context(tenant), gap),
      ).toEqual({ requestCount: 1, counted: true });
      // Resolved seconds later (e.g. the offset passed it), then missing again.
      await withTenant(database, context(tenant), (tx) =>
        tx.execute(
          sql`UPDATE domain_event_gap_requests SET resolved_at = now()`,
        ),
      );
      expect(
        await recordOutboxGapRequest(database, context(tenant), gap),
      ).toEqual({ requestCount: 2, counted: true });
    } finally {
      error.mockRestore();
    }
    const rows = await gapRows(tenant);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resolved_at).toBeNull();
  });

  it("legend-18qw another tenant cannot see a gap request", async () => {
    const tenant = randomUUID();
    const other = randomUUID();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await recordOutboxGapRequest(database, context(tenant), {
        destination: "test",
        aggregateType: "pos_order",
        aggregateId: randomUUID(),
        missingSequence: 4,
      });
    } finally {
      error.mockRestore();
    }
    expect(await gapRows(tenant)).toHaveLength(1);
    expect(await gapRows(other)).toHaveLength(0);
  });

  it("legend-18qw relay records the gap and resolves it once the consumer passes it", async () => {
    const tenant = randomUUID();
    const aggregateId = createUlid();
    const second = outboxRow(tenant, aggregateId, 2);
    await append(tenant, second);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        await relayOutbox(
          database,
          context(tenant),
          async () => randomUUID(),
          async (gap) => {
            await recordOutboxGapRequest(database, context(tenant), gap);
          },
        ),
      ).toBe(0);
    } finally {
      error.mockRestore();
    }
    const open = await gapRows(tenant);
    expect(open).toHaveLength(1);
    expect(open[0]?.resolved_at).toBeNull();
    // Still missing: nothing to resolve.
    expect(await resolveFilledOutboxGaps(database, context(tenant))).toBe(0);

    const first = outboxRow(tenant, aggregateId, 1);
    await append(tenant, first);
    await relayOutbox(database, context(tenant), async () => randomUUID());
    for (const [row] of [[first], [second]] as const) {
      await relayOutbox(database, context(tenant), async () => randomUUID());
      expect(
        await consumeOutbox(database, context(tenant), {
          outboxId: row.id,
          generation: 0,
          authorize: allow,
          deliver: noop,
        }),
      ).toBe(true);
    }
    expect(await resolveFilledOutboxGaps(database, context(tenant))).toBe(1);
    const resolved = await gapRows(tenant);
    expect(resolved[0]?.resolved_at).not.toBeNull();
    // Idempotent: a second sweep resolves nothing.
    expect(await resolveFilledOutboxGaps(database, context(tenant))).toBe(0);
  });
});
