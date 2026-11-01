import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  type OutletScopeData,
} from "@starter/shared/core";
import { eventFixture } from "@starter/shared/events";
import * as schema from "../db/schema";
import { withTenant } from "../db/tenant";
import {
  appendOutbox,
  consumeOutbox,
  markOutboxDead,
  relayOutbox,
  replayOutbox,
} from "../services/core-outbox";

// PRD v1.7 §3 (event model + outbox, Sinkronisasi: idempotent, ordered per
// aggregate) and §5 Worker (idempotent jobs carrying tenant_id, permission
// re-checked at run time). Each test uses fresh tenants so files can share a DB.

const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const database = drizzle(pool, { schema });
afterAll(async () => {
  await pool.end();
});

const context = (
  tenantId: string,
  scope: OutletScopeData = { kind: "tenant" },
) =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "domain",
    }),
    scope,
  );

function outboxRow(
  tenantId: string,
  input: {
    aggregateId: string;
    sequence: number;
    outletId?: string | null;
    name?: string;
    destination?: string;
  },
) {
  return {
    id: createUlid(),
    event: {
      ...eventFixture,
      id: createUlid(),
      tenantId,
      outletId: input.outletId ?? null,
      aggregateId: input.aggregateId,
      sequence: input.sequence,
      ...(input.name
        ? { name: input.name, payloadSchemaRef: `${input.name}.v1` }
        : {}),
    },
    destination: input.destination ?? "consumer-test",
    direction: null,
    peerId: null,
  };
}

async function append(tenantId: string, row: ReturnType<typeof outboxRow>) {
  await withTenant(database, context(tenantId), (tx) =>
    appendOutbox(tx, context(tenantId), row),
  );
}

async function count(tenantId: string, table: string) {
  return withTenant(database, context(tenantId), async (tx) => {
    const result = await tx.execute(
      sql.raw(`SELECT count(*)::int AS n FROM ${table}`),
    );
    return Number(result.rows[0]?.n);
  });
}

const allow = async () => true;
const noop = async () => {};

describe("outbox consumers", () => {
  it("TEN-01 rolls back a consumer's database effect with its consumption record, then commits both exactly once", async () => {
    const tenant = randomUUID();
    const source = outboxRow(tenant, {
      aggregateId: createUlid(),
      sequence: 1,
    });
    const followUp = outboxRow(tenant, {
      aggregateId: createUlid(),
      sequence: 1,
      destination: "follow-up",
    });
    await append(tenant, source);
    let failAfterEffect = true;
    const deliver = async (
      _event: unknown,
      _key: string,
      tx: Parameters<Parameters<typeof withTenant>[2]>[0],
    ) => {
      // The side effect is itself a transactional outbox write.
      await appendOutbox(tx, context(tenant), followUp);
      if (failAfterEffect) {
        failAfterEffect = false;
        throw new Error("failure after side effect");
      }
    };
    await expect(
      consumeOutbox(database, context(tenant), {
        outboxId: source.id,
        authorize: allow,
        deliver,
      }),
    ).rejects.toThrow("failure after side effect");
    expect(await count(tenant, "domain_event_consumptions")).toBe(0);
    expect(await count(tenant, "domain_event_offsets")).toBe(0);
    expect(await count(tenant, "domain_event_outbox")).toBe(1);

    expect(
      await consumeOutbox(database, context(tenant), {
        outboxId: source.id,
        authorize: allow,
        deliver,
      }),
    ).toBe(true);
    expect(await count(tenant, "domain_event_consumptions")).toBe(1);
    expect(await count(tenant, "domain_event_outbox")).toBe(2);
    // Redelivery of the same event is a durable no-op (dedup on consumer + event id).
    expect(
      await consumeOutbox(database, context(tenant), {
        outboxId: source.id,
        authorize: allow,
        deliver,
      }),
    ).toBe(false);
    expect(await count(tenant, "domain_event_outbox")).toBe(2);
  });

  it("advances the aggregate sequence for event types the consumer ignores", async () => {
    const tenant = randomUUID();
    const aggregateId = createUlid();
    const ignored = outboxRow(tenant, {
      aggregateId,
      sequence: 1,
      name: "order.submitted",
    });
    const handled = outboxRow(tenant, { aggregateId, sequence: 2 });
    await append(tenant, ignored);
    await append(tenant, handled);
    const handledNames: string[] = [];
    const deliver = async (event: { name: string }) => {
      if (event.name !== "order.paid") return; // ignored type: no effect
      handledNames.push(event.name);
    };
    expect(
      await consumeOutbox(database, context(tenant), {
        outboxId: ignored.id,
        authorize: allow,
        deliver,
      }),
    ).toBe(true);
    expect(
      await consumeOutbox(database, context(tenant), {
        outboxId: handled.id,
        authorize: allow,
        deliver,
      }),
    ).toBe(true);
    expect(handledNames).toEqual(["order.paid"]);
    const offset = await withTenant(database, context(tenant), (tx) =>
      tx.execute(sql`SELECT last_sequence FROM domain_event_offsets`),
    );
    expect(offset.rows).toEqual([{ last_sequence: "2" }]);
  });

  it("holds every later sequence of an aggregate behind a dead-lettered event until an operator replays it", async () => {
    const tenant = randomUUID();
    const aggregateId = createUlid();
    const first = outboxRow(tenant, { aggregateId, sequence: 1 });
    const second = outboxRow(tenant, { aggregateId, sequence: 2 });
    await append(tenant, first);
    await append(tenant, second);
    const sent: { outboxId: string; generation: number }[] = [];
    const enqueue = async (job: { outboxId: string; generation: number }) => {
      sent.push(job);
      return randomUUID();
    };
    const gaps: unknown[] = [];
    const requestMissing = async (gap: unknown) => {
      gaps.push(gap);
    };
    expect(
      await relayOutbox(database, context(tenant), enqueue, requestMissing),
    ).toBe(1);
    expect(sent.map((job) => job.outboxId)).toEqual([first.id]);
    await markOutboxDead(database, context(tenant), {
      outboxId: first.id,
      generation: 0,
    });
    // Dead letters are never re-enqueued automatically, and the next sequence
    // is not skipped past the dead one (present, so no gap request either).
    for (let sweep = 0; sweep < 3; sweep++)
      expect(
        await relayOutbox(database, context(tenant), enqueue, requestMissing),
      ).toBe(0);
    expect(gaps).toEqual([]);
    await replayOutbox(database, context(tenant), {
      outboxId: first.id,
      actor: { type: "user", id: randomUUID() },
      reason: "Provider outage resolved",
      authorize: allow,
    });
    expect(
      await relayOutbox(database, context(tenant), enqueue, requestMissing),
    ).toBe(1);
    expect(sent.at(-1)).toMatchObject({ outboxId: first.id, generation: 1 });
    expect(
      await consumeOutbox(database, context(tenant), {
        outboxId: first.id,
        generation: 1,
        authorize: allow,
        deliver: noop,
      }),
    ).toBe(true);
    expect(
      await relayOutbox(database, context(tenant), enqueue, requestMissing),
    ).toBe(1);
    expect(sent.at(-1)).toMatchObject({ outboxId: second.id, generation: 0 });
  });

  it("rejects replay by a non-operator actor or without a reason", async () => {
    const tenant = randomUUID();
    const row = outboxRow(tenant, { aggregateId: createUlid(), sequence: 1 });
    await append(tenant, row);
    await relayOutbox(database, context(tenant), async () => randomUUID());
    await markOutboxDead(database, context(tenant), {
      outboxId: row.id,
      generation: 0,
    });
    await expect(
      replayOutbox(database, context(tenant), {
        outboxId: row.id,
        actor: { type: "system" },
        reason: "auto",
        authorize: allow,
      }),
    ).rejects.toThrow();
    await expect(
      replayOutbox(database, context(tenant), {
        outboxId: row.id,
        actor: { type: "user", id: randomUUID() },
        reason: "   ",
        authorize: allow,
      }),
    ).rejects.toThrow("operator and reason");
    expect(await count(tenant, "domain_event_replays")).toBe(0);
  });

  it("TEN-01 TEN-02 keeps offsets, consumptions, replays and outbox rows invisible and unusable across tenants", async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const row = outboxRow(tenantA, { aggregateId: createUlid(), sequence: 1 });
    await append(tenantA, row);
    await relayOutbox(database, context(tenantA), async () => randomUUID());
    await markOutboxDead(database, context(tenantA), {
      outboxId: row.id,
      generation: 0,
    });
    await replayOutbox(database, context(tenantA), {
      outboxId: row.id,
      actor: { type: "user", id: randomUUID() },
      reason: "Operator retry",
      authorize: allow,
    });
    await consumeOutbox(database, context(tenantA), {
      outboxId: row.id,
      generation: 1,
      authorize: allow,
      deliver: noop,
    });
    for (const table of [
      "domain_event_outbox",
      "domain_event_offsets",
      "domain_event_consumptions",
      "domain_event_replays",
    ]) {
      expect(await count(tenantA, table)).toBe(1);
      expect(await count(tenantB, table)).toBe(0);
    }
    await expect(
      consumeOutbox(database, context(tenantB), {
        outboxId: row.id,
        generation: 1,
        authorize: allow,
        deliver: noop,
      }),
    ).rejects.toThrow("not found");
    await expect(
      replayOutbox(database, context(tenantB), {
        outboxId: row.id,
        actor: { type: "user", id: randomUUID() },
        reason: "cross-tenant",
        authorize: allow,
      }),
    ).rejects.toThrow("not found");
    // RLS WITH CHECK refuses a row written for another tenant.
    await expect(
      withTenant(database, context(tenantB), (tx) =>
        tx.execute(
          sql`INSERT INTO domain_event_offsets (tenant_id, consumer, aggregate_type, aggregate_id) VALUES (${tenantA}::uuid, 'x', 'order', ${randomUUID()}::uuid)`,
        ),
      ),
    ).rejects.toThrow();
    expect(await count(tenantA, "domain_event_offsets")).toBe(1);
  });

  it("TEN-03 limits an outlet-scoped relay, consumer and replay to the assigned outlets", async () => {
    const tenant = randomUUID();
    const outletX = outletIdSchema.parse(randomUUID());
    const outletY = outletIdSchema.parse(randomUUID());
    const inX = outboxRow(tenant, {
      aggregateId: createUlid(),
      sequence: 1,
      outletId: outletX,
    });
    const inY = outboxRow(tenant, {
      aggregateId: createUlid(),
      sequence: 1,
      outletId: outletY,
    });
    await append(tenant, inX);
    await append(tenant, inY);
    const scopedX = context(tenant, { kind: "outlets", outletIds: [outletX] });
    const sent: string[] = [];
    expect(
      await relayOutbox(database, scopedX, async (job) => {
        sent.push(job.outboxId);
        return randomUUID();
      }),
    ).toBe(1);
    expect(sent).toEqual([inX.id]);
    await expect(
      consumeOutbox(database, scopedX, {
        outboxId: inY.id,
        authorize: allow,
        deliver: noop,
      }),
    ).rejects.toThrow();
    await expect(
      appendOutbox(
        // Tenant-wide events need tenant scope.
        undefined as never,
        scopedX,
        outboxRow(tenant, { aggregateId: createUlid(), sequence: 1 }),
      ),
    ).rejects.toThrow("tenant scope");
    expect(await count(tenant, "domain_event_consumptions")).toBe(0);
  });
});
