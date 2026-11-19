import { randomUUID } from "node:crypto";
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
  markOutboxDead,
  replayOutbox,
  recoverExpiredDispatches,
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
  it("TEN-01 TEN-02 isolates tenant rows and rejects a mismatched event tenant", async () => {
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
  it("holds a sequence gap until the missing lower event arrives", async () => {
    const gaps: unknown[] = [];
    expect(
      await relayOutbox(
        database,
        context(tenantA),
        async () => "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        async (gap) => {
          gaps.push(gap);
        },
      ),
    ).toBe(0);
    expect(gaps).toEqual([
      {
        destination: "test",
        aggregateType: "order",
        aggregateId: event.aggregateId,
        missingSequence: 1,
      },
    ]);
    const deliver = async () => {};
    await expect(
      consumeOutbox(database, context(tenantA), {
        outboxId: row.id,
        authorize: async () => true,
        deliver,
      }),
    ).rejects.toThrow("Aggregate sequence gap");
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
    ).rejects.toThrow("Aggregate sequence gap");
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
        return "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      }),
    ).toBe(0);
    expect(jobs).toEqual([]);
  });
  it("does not auto-requeue dead letters and requires an authorized audited replay", async () => {
    const second = {
      ...row,
      id: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
      event: {
        ...event,
        id: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
        aggregateId: "01ARZ3NDEKTSV4RRFFQ69G5FB2",
        sequence: 1,
      },
    };
    await withTenant(database, context(tenantA), async (tx) =>
      appendOutbox(tx, context(tenantA), second),
    );
    const sent: { tenantId: string; outboxId: string; generation: number }[] =
      [];
    const enqueue = async (job: {
      tenantId: string;
      outboxId: string;
      generation: number;
    }) => {
      sent.push(job);
      return "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    };
    expect(await relayOutbox(database, context(tenantA), enqueue)).toBe(1);
    await markOutboxDead(database, context(tenantA), {
      outboxId: second.id,
      generation: 0,
    });
    expect(await relayOutbox(database, context(tenantA), enqueue)).toBe(0);
    const replay = {
      outboxId: second.id,
      actor: { type: "user", id: "33333333-3333-4333-8333-333333333333" },
      reason: "Operator retry",
      authorize: async () => false,
    };
    await expect(
      replayOutbox(database, context(tenantA), replay),
    ).rejects.toThrow("permission");
    await replayOutbox(database, context(tenantA), {
      ...replay,
      authorize: async () => true,
    });
    expect(await relayOutbox(database, context(tenantA), enqueue)).toBe(1);
    expect(sent.map((job) => job.generation)).toEqual([0, 1]);
    expect(
      await consumeOutbox(database, context(tenantA), {
        outboxId: second.id,
        generation: 0,
        authorize: async () => true,
        deliver: async () => {},
      }),
    ).toBe("superseded");
    await markOutboxDead(database, context(tenantA), {
      outboxId: second.id,
      generation: 0,
    });
    await withTenant(database, context(tenantA), async (tx) => {
      const state = await tx.execute(
        sql`SELECT dispatch_state FROM domain_event_outbox WHERE id = ${"01563e3a-b5d3-d676-4c61-efb99302bd60"}::uuid`,
      );
      expect(state.rows[0]?.dispatch_state).toBe("queued");
    });
    await withTenant(database, context(tenantA), async (tx) => {
      const audit = await tx.execute(
        sql`SELECT generation, reason FROM domain_event_replays`,
      );
      expect(audit.rows).toEqual([{ generation: 1, reason: "Operator retry" }]);
    });
  });
  it("enforces audited replay and monotonic generations in the database", async () => {
    const third = {
      ...row,
      id: "01ARZ3NDEKTSV4RRFFQ69G5FC0",
      event: {
        ...event,
        id: "01ARZ3NDEKTSV4RRFFQ69G5FC1",
        aggregateId: "01ARZ3NDEKTSV4RRFFQ69G5FC2",
        sequence: 1,
      },
    };
    await withTenant(database, context(tenantA), async (tx) =>
      appendOutbox(tx, context(tenantA), third),
    );
    const enqueue = async () => "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    expect(await relayOutbox(database, context(tenantA), enqueue)).toBe(1);
    await markOutboxDead(database, context(tenantA), {
      outboxId: third.id,
      generation: 0,
    });
    const id = sql`(SELECT id FROM domain_event_outbox WHERE event->>'id' = ${third.event.id})`;
    // A direct requeue without an operator replay audit record is refused.
    await expect(
      withTenant(database, context(tenantA), (tx) =>
        tx.execute(
          sql`UPDATE domain_event_outbox SET dispatch_state = 'ready', dispatch_generation = 1, dispatch_job_id = NULL, dead_lettered_at = NULL WHERE id = ${id}`,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(database, context(tenantA), (tx) =>
        tx.execute(
          sql`UPDATE domain_event_outbox SET dispatch_state = 'ready', dispatch_job_id = NULL, dead_lettered_at = NULL WHERE id = ${id}`,
        ),
      ),
    ).rejects.toThrow();
    await replayOutbox(database, context(tenantA), {
      outboxId: third.id,
      actor: { type: "user", id: "33333333-3333-4333-8333-333333333333" },
      reason: "Operator retry",
      authorize: async () => true,
    });
    await expect(
      withTenant(database, context(tenantA), (tx) =>
        tx.execute(
          sql`UPDATE domain_event_outbox SET dispatch_generation = 0 WHERE id = ${id}`,
        ),
      ),
    ).rejects.toThrow();
  });
  it("F3 legend-hds7 re-dispatches a queued event whose pg-boss job vanished, fenced by generation", async () => {
    const tenant = randomUUID();
    const aggregateId = "01ARZ3NDEKTSV4RRFFQ69G5FD2";
    const first = {
      ...row,
      id: "01ARZ3NDEKTSV4RRFFQ69G5FD1",
      event: {
        ...event,
        tenantId: tenant,
        id: "01ARZ3NDEKTSV4RRFFQ69G5FD0",
        aggregateId,
        sequence: 1,
      },
    };
    const second = {
      ...row,
      id: "01ARZ3NDEKTSV4RRFFQ69G5FD4",
      event: {
        ...event,
        tenantId: tenant,
        id: "01ARZ3NDEKTSV4RRFFQ69G5FD3",
        aggregateId,
        sequence: 2,
      },
    };
    await withTenant(database, context(tenant), async (tx) => {
      await appendOutbox(tx, context(tenant), first);
      await appendOutbox(tx, context(tenant), second);
    });
    const jobId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const sent: { outboxId: string; generation: number }[] = [];
    const enqueue = async (job: {
      tenantId: string;
      outboxId: string;
      generation: number;
    }) => {
      sent.push({ outboxId: job.outboxId, generation: job.generation });
      return jobId;
    };
    expect(await relayOutbox(database, context(tenant), enqueue)).toBe(1);
    expect(sent).toEqual([{ outboxId: first.id, generation: 0 }]);
    const queued = await withTenant(
      database,
      context(tenant),
      async (tx) =>
        (
          await tx.execute(
            sql`SELECT dispatch_state, dispatch_job_id, dispatch_lease_token, dispatch_lease_until > now() AS leased FROM domain_event_outbox WHERE event->>'id' = ${first.event.id}`,
          )
        ).rows,
    );
    // The queued row carries a live job lease, so a lost job is detectable.
    expect(queued).toEqual([
      {
        dispatch_state: "queued",
        dispatch_job_id: jobId,
        dispatch_lease_token: null,
        leased: true,
      },
    ]);
    // A sweep before the lease expires neither duplicates nor recovers it.
    expect(await relayOutbox(database, context(tenant), enqueue)).toBe(0);
    expect(sent).toHaveLength(1);
    // pg-boss lost the job: no consumer ever ran and the lease expired.
    await withTenant(database, context(tenant), (tx) =>
      tx.execute(
        sql`UPDATE domain_event_outbox SET dispatch_lease_until = now() - interval '1 second' WHERE event->>'id' = ${first.event.id}`,
      ),
    );
    expect(await relayOutbox(database, context(tenant), enqueue)).toBe(1);
    expect(sent.map((job) => job.generation)).toEqual([0, 1]);
    // The lost job is fenced; only the re-dispatched generation may deliver.
    expect(
      await consumeOutbox(database, context(tenant), {
        outboxId: first.id,
        generation: 0,
        authorize: async () => true,
        deliver: async () => {},
      }),
    ).toBe("superseded");
    expect(
      await consumeOutbox(database, context(tenant), {
        outboxId: first.id,
        generation: 1,
        authorize: async () => true,
        deliver: async () => {},
      }),
    ).toBe(true);
    // The aggregate is unblocked: the next sequence dispatches.
    expect(await relayOutbox(database, context(tenant), enqueue)).toBe(1);
    expect(sent.map((job) => job.outboxId)).toEqual([
      first.id,
      first.id,
      second.id,
    ]);
    // A delivered row is never recovered by a later sweep.
    expect(await recoverExpiredDispatches(database, context(tenant))).toEqual(
      [],
    );
  });
  it("F3 legend-hds7 keeps the recovery fence in the database and scopes it per tenant", async () => {
    const tenant = randomUUID();
    const other = randomUUID();
    const single = {
      ...row,
      id: "01ARZ3NDEKTSV4RRFFQ69G5FE1",
      event: {
        ...event,
        tenantId: tenant,
        id: "01ARZ3NDEKTSV4RRFFQ69G5FE0",
        aggregateId: "01ARZ3NDEKTSV4RRFFQ69G5FE2",
        sequence: 1,
      },
    };
    await withTenant(database, context(tenant), async (tx) =>
      appendOutbox(tx, context(tenant), single),
    );
    expect(
      await relayOutbox(
        database,
        context(tenant),
        async () => "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      ),
    ).toBe(1);
    const id = sql`(SELECT id FROM domain_event_outbox WHERE event->>'id' = ${single.event.id})`;
    // While the queued lease is live the generation cannot advance.
    await expect(
      withTenant(database, context(tenant), (tx) =>
        tx.execute(
          sql`UPDATE domain_event_outbox SET dispatch_state = 'ready', dispatch_generation = 1, dispatch_lease_until = NULL WHERE id = ${id}`,
        ),
      ),
    ).rejects.toThrow();
    await withTenant(database, context(tenant), (tx) =>
      tx.execute(
        sql`UPDATE domain_event_outbox SET dispatch_lease_until = now() - interval '1 second' WHERE id = ${id}`,
      ),
    );
    // Even with an expired lease, a bare generation bump is refused: recovery
    // must also return the row to 'ready' for the relay to re-enqueue it.
    await expect(
      withTenant(database, context(tenant), (tx) =>
        tx.execute(
          sql`UPDATE domain_event_outbox SET dispatch_generation = 1 WHERE id = ${id}`,
        ),
      ),
    ).rejects.toThrow();
    // Recovery is tenant scoped: another tenant sees no rows.
    expect(await recoverExpiredDispatches(database, context(other))).toEqual(
      [],
    );
    const recovered = await recoverExpiredDispatches(database, context(tenant));
    expect(recovered.map((entry) => Number(entry.dispatch_generation))).toEqual(
      [1],
    );
    // A second sweep is idempotent.
    expect(await recoverExpiredDispatches(database, context(tenant))).toEqual(
      [],
    );
  });
});
