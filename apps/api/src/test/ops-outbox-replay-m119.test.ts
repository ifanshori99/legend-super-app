// legend-m119: operator outbox replay (PRD v1.7 §3 outbox, §5 Worker, TEN-02/03).
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
} from "@starter/shared/core";
import { eventFixture } from "@starter/shared/events";
import * as schema from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { errorHandler } from "../middleware/error-handler";
import { setAuditWriter } from "../services/audit-writer";
import { coreAuditWriter } from "../services/core-audit-writer";
import {
  appendOutbox,
  markOutboxDead,
  relayOutbox,
} from "../services/core-outbox";
import { replayOutboxAsOperator } from "../services/ops-outbox.service";
import { createOpsOutboxRouter } from "../routes/ops-outbox.routes";

const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const database = drizzle(pool, { schema });
const operator = randomUUID();
const scope = (tenantId: string, outletIds?: string[]) =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "domain",
    }),
    outletIds
      ? {
          kind: "outlets",
          outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
        }
      : { kind: "tenant" },
  );

beforeAll(() => setAuditWriter(coreAuditWriter));
afterAll(async () => {
  setAuditWriter(null);
  await pool.end();
});

/** A tenant-wide event that went through relay and the dead letter. */
async function deadEvent(tenantId: string, outletId: string | null = null) {
  const id = createUlid();
  const context = scope(tenantId);
  await withTenant(database, context, (tx) =>
    appendOutbox(tx, context, {
      id,
      event: {
        ...eventFixture,
        tenantId,
        outletId,
        id: createUlid(),
        aggregateId: createUlid(),
        sequence: 1,
      },
      destination: "test",
      direction: null,
      peerId: null,
    }),
  );
  await relayOutbox(database, context, async () => randomUUID());
  await markOutboxDead(database, context, { outboxId: id, generation: 0 });
  return id;
}

const allow = () => true;
const rows = (tenantId: string, query: ReturnType<typeof sql>) =>
  withTenant(
    database,
    scope(tenantId),
    async (tx) => (await tx.execute(query)).rows,
  );

describe("operator outbox replay", () => {
  it("m119 replays a dead event, writes the replay row and the audit row together", async () => {
    const tenant = randomUUID();
    const id = await deadEvent(tenant);
    const result = await replayOutboxAsOperator(database, scope(tenant), {
      outboxId: id,
      actorUserId: operator,
      reason: "  Provider fixed  ",
      canReplay: allow,
    });
    expect(result).toEqual({ outboxId: id, generation: 1 });
    const replays = await rows(
      tenant,
      sql`SELECT generation, reason, actor FROM domain_event_replays`,
    );
    expect(replays).toHaveLength(1);
    expect(replays[0]).toMatchObject({
      generation: 1,
      reason: "Provider fixed",
      actor: { type: "user", id: operator },
    });
    const audit = await rows(tenant, sql`SELECT event FROM audit_logs`);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.event).toMatchObject({
      action: "outbox.replayed",
      objectType: "outbox_event",
      actorId: operator,
      reason: "Provider fixed",
    });
  });

  it("m119 rolls the replay back when the audit write fails", async () => {
    const tenant = randomUUID();
    const id = await deadEvent(tenant);
    setAuditWriter(null);
    try {
      await expect(
        replayOutboxAsOperator(database, scope(tenant), {
          outboxId: id,
          actorUserId: operator,
          reason: "x",
          canReplay: allow,
        }),
      ).rejects.toThrow();
    } finally {
      setAuditWriter(coreAuditWriter);
    }
    expect(
      await rows(tenant, sql`SELECT 1 FROM domain_event_replays`),
    ).toHaveLength(0);
    const state = await rows(
      tenant,
      sql`SELECT dispatch_state, dispatch_generation FROM domain_event_outbox`,
    );
    expect(state[0]).toMatchObject({
      dispatch_state: "dead",
      dispatch_generation: 0,
    });
  });

  it("m119 denies without the permission (403) and changes nothing", async () => {
    const tenant = randomUUID();
    const id = await deadEvent(tenant);
    await expect(
      replayOutboxAsOperator(database, scope(tenant), {
        outboxId: id,
        actorUserId: operator,
        reason: "try",
        canReplay: () => false,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await rows(tenant, sql`SELECT 1 FROM domain_event_replays`),
    ).toHaveLength(0);
    expect(await rows(tenant, sql`SELECT 1 FROM audit_logs`)).toHaveLength(0);
  });

  it("m119 TEN-02 hides another tenant's event (404)", async () => {
    const owner = randomUUID();
    const id = await deadEvent(owner);
    await expect(
      replayOutboxAsOperator(database, scope(randomUUID()), {
        outboxId: id,
        actorUserId: operator,
        reason: "cross tenant",
        canReplay: allow,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await rows(owner, sql`SELECT 1 FROM domain_event_replays`),
    ).toHaveLength(0);
  });

  it("m119 answers 409 on a second replay, so a double click never bumps the generation twice", async () => {
    const tenant = randomUUID();
    const id = await deadEvent(tenant);
    const input = {
      outboxId: id,
      actorUserId: operator,
      reason: "again",
      canReplay: allow,
    };
    const [a, b] = await Promise.allSettled([
      replayOutboxAsOperator(database, scope(tenant), input),
      replayOutboxAsOperator(database, scope(tenant), input),
    ]);
    const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
    const rejected = [a, b].filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      status: 409,
    });
    const state = await rows(
      tenant,
      sql`SELECT dispatch_generation FROM domain_event_outbox`,
    );
    expect(state[0]?.dispatch_generation).toBe(1);
    expect(
      await rows(tenant, sql`SELECT 1 FROM domain_event_replays`),
    ).toHaveLength(1);
  });

  it("m119 TEN-03 refuses an outlet outside the caller's scope and an unscoped outlet event", async () => {
    const tenant = randomUUID();
    const outletA = randomUUID();
    const outletB = randomUUID();
    const id = await deadEvent(tenant, outletA);
    await expect(
      replayOutboxAsOperator(database, scope(tenant, [outletB]), {
        outboxId: id,
        actorUserId: operator,
        reason: "wrong outlet",
        canReplay: allow,
      }),
    ).rejects.toMatchObject({ status: 403 });
    // Reach is right but the per-event permission check (outlet target) says no.
    await expect(
      replayOutboxAsOperator(database, scope(tenant, [outletA]), {
        outboxId: id,
        actorUserId: operator,
        reason: "no grant for outlet",
        canReplay: (event) => event.outletId !== outletA,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await rows(tenant, sql`SELECT 1 FROM domain_event_replays`),
    ).toHaveLength(0);
  });
});

describe("operator outbox replay route", () => {
  const ulid = createUlid();
  function app(canReplay = true) {
    const calls: unknown[] = [];
    const server = express();
    server.use(
      "/api/ops",
      createOpsOutboxRouter({
        guards: [],
        resolve: () => ({
          context: scope(randomUUID()),
          userId: operator,
          canReplay: () => canReplay,
        }),
        replay: async (_db, _context, input) => {
          calls.push(input);
          if (!canReplay)
            throw new HttpError(
              403,
              "FORBIDDEN",
              "Your account cannot replay.",
            );
          return { outboxId: input.outboxId, generation: 3 };
        },
      }),
    );
    server.use(errorHandler);
    return { server, calls };
  }
  const post = (server: express.Express, body: unknown, id = ulid) =>
    request(server)
      .post(`/api/ops/outbox/${id}/replay`)
      .set("Content-Type", "application/json")
      .send(JSON.stringify(body));

  it("m119 requires a reason of 1..1000 characters and rejects extra keys", async () => {
    const { server, calls } = app();
    expect((await post(server, {})).status).toBe(422);
    expect((await post(server, { reason: "   " })).status).toBe(422);
    expect((await post(server, { reason: "x".repeat(1001) })).status).toBe(422);
    expect((await post(server, { reason: "ok", tenantId: "t" })).status).toBe(
      422,
    );
    expect((await post(server, { reason: "ok" }, "not-a-ulid")).status).toBe(
      422,
    );
    expect(calls).toHaveLength(0);
  });

  it("m119 returns the new generation with the actor from the session", async () => {
    const { server, calls } = app();
    const res = await post(server, { reason: "Retry" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { outboxId: ulid, generation: 3 } });
    expect(calls[0]).toMatchObject({ actorUserId: operator, reason: "Retry" });
  });

  it("m119 maps a permission refusal to 403", async () => {
    const { server } = app(false);
    expect((await post(server, { reason: "Retry" })).status).toBe(403);
  });
});
