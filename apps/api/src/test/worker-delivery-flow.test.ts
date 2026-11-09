// legend-18qw: the production worker path end to end against PostgreSQL. The
// config comes from loadWorkerConfig exactly as worker-main builds it
// (WORKER_TRANSPORT=builtin, channels explicitly disabled), then the relay and
// consumption run the real outbox functions.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { createUlid, tenantIdSchema } from "@starter/shared/core";
import { eventFixture } from "@starter/shared/events";
import * as schema from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  appendOutbox,
  consumeOutbox,
  relayOutbox,
} from "../services/core-outbox.ts";
import { resolveFilledOutboxGaps } from "../services/core-outbox-gaps.ts";
import { syncStaleDeliveryChannels } from "../services/delivery-sync-consumer.ts";
import { loadWorkerConfig } from "../worker/production-config.ts";

const appPool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const database = drizzle(appPool, { schema });
const env = {
  DEPLOYMENT_MODE: "production",
  EDGE_MODE: "false",
  WORKER_TRANSPORT: "builtin",
  NOTIFICATION_EMAIL_PROVIDER: "disabled",
  NOTIFICATION_PUSH_PROVIDER: "disabled",
  NOTIFICATION_WHATSAPP_PROVIDER: "disabled",
};

afterAll(async () => {
  await appPool.end();
});

async function setup() {
  const handlers = await loadWorkerConfig({ env, database });
  const tenantId = tenantIdSchema.parse(randomUUID());
  const context = await handlers.resolveContext(tenantId);
  const aggregateId = createUlid();
  const append = async (sequence: number) => {
    const outboxId = createUlid();
    await withTenant(database, context, (tx) =>
      appendOutbox(tx, context, {
        id: outboxId,
        event: {
          ...eventFixture,
          id: createUlid(),
          tenantId,
          outletId: null,
          aggregateId,
          sequence,
          idempotencyKey: `legend-18qw:${aggregateId}:${sequence}`,
        },
        destination: "cloud-sync",
        direction: null,
        peerId: null,
      }),
    );
    return outboxId;
  };
  // What worker-main's runtime does for one job: consume through the
  // configured transport with the row's route.
  const deliver = (outboxId: string, as = context) =>
    consumeOutbox(database, as, {
      outboxId,
      authorize: (event) => handlers.authorizeEvent(as, event),
      deliver: (event, key, tx) =>
        handlers.deliverEvent(as, event, key, tx, {
          destination: "cloud-sync",
          direction: null,
          peerId: null,
        }),
    });
  const count = async (query: ReturnType<typeof sql>) =>
    withTenant(database, context, async (tx) =>
      Number((await tx.execute(query)).rows[0]?.total ?? 0),
    );
  return { handlers, tenantId, context, aggregateId, append, deliver, count };
}

describe("legend-18qw production worker delivery", () => {
  it("legend-18qw acknowledges durably and idempotently: a redelivered job is not applied twice", async () => {
    const { append, deliver, count } = await setup();
    const outboxId = await append(1);
    expect(await deliver(outboxId)).toBe(true);
    // pg-boss retried after an uncertain acknowledgement: same job again.
    expect(await deliver(outboxId)).toBe(false);
    expect(
      await count(
        sql`SELECT count(*) AS total FROM domain_event_consumptions WHERE consumer = 'cloud-sync'`,
      ),
    ).toBe(1);
    expect(
      await count(
        sql`SELECT count(*) AS total FROM domain_event_outbox WHERE status = 'delivered'`,
      ),
    ).toBe(1);
  });

  it("legend-18qw refuses delivery under another tenant's or an untrusted context", async () => {
    const { handlers, append, deliver } = await setup();
    const outboxId = await append(1);
    const intruder = await handlers.resolveContext(
      tenantIdSchema.parse(randomUUID()),
    );
    // Another tenant cannot even see the row (RLS), so nothing is consumed.
    await expect(deliver(outboxId, intruder)).rejects.toThrow(
      "Outbox row not found",
    );
    // A forged (spread) context is refused before any database work.
    await expect(
      deliver(outboxId, {
        ...intruder,
        tenant: { ...intruder.tenant },
      } as typeof intruder),
    ).rejects.toThrow();
    expect(await deliver(outboxId)).toBe(true);
  });

  it("legend-18qw records a sequence gap durably and fills it in order once the missing event arrives", async () => {
    const { handlers, context, append, deliver, count } = await setup();
    const second = await append(2);
    const enqueued: string[] = [];
    const enqueue = async (job: { outboxId: string }) => {
      enqueued.push(job.outboxId);
      return randomUUID();
    };
    const relay = () =>
      relayOutbox(database, context, enqueue, (gap) =>
        handlers.requestMissing(context, gap),
      );
    // relayOutbox is a periodic sweep, so a sweep that finds nothing yet is
    // normal. Under heavy machine load the first sweep after a commit
    // occasionally claimed 0 (legend-06qw0; ~1 in 150 looped runs, never alone).
    // The exact cause is not proven, so wait for the claim as a condition and
    // dump the outbox row state on every empty sweep: the next flake then
    // explains itself. A sweep that claims nothing changes nothing, so retrying
    // is safe, and the exact count and order below still hold.
    const relayClaimed = () =>
      vi.waitFor(
        async () => {
          const claimed = await relay();
          if (claimed === 0) {
            const state = await withTenant(
              database,
              context,
              async (tx) =>
                (
                  await tx.execute(
                    sql`SELECT sequence, dispatch_state, status, available_at, now() AS db_now, dispatch_lease_until FROM domain_event_outbox ORDER BY sequence`,
                  )
                ).rows,
            );
            console.warn(
              "legend-06qw0 relay claimed nothing",
              JSON.stringify(state),
            );
            throw new Error("relay claimed nothing yet");
          }
          return claimed;
        },
        { timeout: 10_000, interval: 50 },
      );
    // Sequence 1 is missing: nothing is claimable, the gap is recorded in one
    // durable row (counted at most once a minute, so two quick sweeps = 1).
    expect(await relay()).toBe(0);
    expect(await relay()).toBe(0);
    const gapRow = sql`SELECT count(*) AS total FROM domain_event_gap_requests WHERE missing_sequence = 1 AND request_count = 1 AND resolved_at IS NULL`;
    expect(await count(gapRow)).toBe(1);
    await expect(deliver(second)).rejects.toThrow("Aggregate sequence gap");

    const first = await append(1);
    expect(await relayClaimed()).toBe(1);
    expect(enqueued).toEqual([first]);
    expect(await deliver(first)).toBe(true);
    expect(await relayClaimed()).toBe(1);
    expect(enqueued).toEqual([first, second]);
    expect(await deliver(second)).toBe(true);

    expect(await resolveFilledOutboxGaps(database, context)).toBe(1);
    expect(
      await count(
        sql`SELECT count(*) AS total FROM domain_event_gap_requests WHERE resolved_at IS NOT NULL`,
      ),
    ).toBe(1);
  });
});

describe("legend-cbd0 delivery channel sweep wiring", () => {
  it("legend-cbd0 worker-main runs syncStaleDeliveryChannels in the cloud-only relay sweep, isolated from the relay", () => {
    const source = readFileSync(
      new URL("../worker-main.ts", import.meta.url),
      "utf8",
    );
    // Cloud only (an edge node never talks to the platform), and a sweep error
    // never blocks the relay.
    expect(source).toMatch(
      /if \(postsInventoryGl\) \{\s*try \{\s*await syncStaleDeliveryChannels\(context, new Date\(\)\);\s*\} catch \{\s*console\.error\("Delivery channel sync sweep failed"\);/,
    );
    // The consumption path feeds the same channels (stale marking, 86 push).
    expect(source).toMatch(
      /if \(postsInventoryGl\)\s*await deliverDeliveryChannelEvent\(context, event, tx\);/,
    );
  });

  it("legend-cbd0 the sweep runs with the context the worker resolves and finds nothing for a tenant without channels", async () => {
    const { context } = await setup();
    expect(await syncStaleDeliveryChannels(context, new Date())).toBe(0);
  });
});
