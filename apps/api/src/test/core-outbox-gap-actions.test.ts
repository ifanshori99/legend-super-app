import { randomUUID } from "node:crypto";
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
  ulidToUuid,
  type OutletScopeData,
} from "@starter/shared/core";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { eventFixture } from "@starter/shared/events";
import {
  cafeLegendPlatformFixtures,
  skipOutboxGapInputSchema,
} from "@starter/shared/platform";
import { createApp } from "../app";
import * as schema from "../db/schema";
import { withTenant } from "../db/tenant";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers";
import { setAuditWriter } from "../services/audit-writer";
import { coreAuditWriter } from "../services/core-audit-writer";
import { appendOutbox, consumeOutbox } from "../services/core-outbox";
import { recordOutboxGapRequest } from "../services/core-outbox-gaps";
import {
  listOpenOutboxGaps,
  skipOutboxGap,
} from "../services/core-outbox-gap-actions";

const ownerPool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appPool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const database = drizzle(appPool, { schema });
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
const actor = randomUUID();
const REASON = "Producer bug, event lost for good";

beforeAll(() => setAuditWriter(coreAuditWriter));
afterAll(async () => {
  setAuditWriter(null);
  await appPool.end();
  await ownerPool.end();
});

// Outbox holds sequence 2 only; sequence 1 is the gap.
async function openGap(tenantId: string, outletId: string | null = null) {
  const aggregateId = createUlid();
  const outboxId = createUlid();
  await withTenant(database, context(tenantId), (tx) =>
    appendOutbox(tx, context(tenantId), {
      id: outboxId,
      event: {
        ...eventFixture,
        id: createUlid(),
        tenantId,
        outletId,
        aggregateId,
        sequence: 2,
      },
      destination: "test",
      direction: null,
      peerId: null,
    }),
  );
  await recordOutboxGapRequest(database, context(tenantId), {
    destination: "test",
    aggregateType: eventFixture.aggregateType,
    aggregateId,
    missingSequence: 1,
  });
  const gap = (await listOpenOutboxGaps(database, context(tenantId))).find(
    (g) => g.aggregateId === ulidToUuid(aggregateId),
  );
  if (!gap) throw new Error("gap missing");
  return { aggregateId, outboxId, gap };
}

const rows = (tenantId: string, query: ReturnType<typeof sql>) =>
  withTenant(
    database,
    context(tenantId),
    async (tx) => (await tx.execute(query)).rows,
  );

describe("legend-jcil outbox gap operator action", () => {
  it("lists open gaps of the tenant only", async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const { gap } = await openGap(a);
    expect(gap.missingSequence).toBe(1);
    expect(await listOpenOutboxGaps(database, context(b))).toEqual([]);
  });

  it("skips the gap, moves the offset, resolves it and audits with the reason", async () => {
    const tenant = randomUUID();
    const { aggregateId, gap } = await openGap(tenant);
    const done = await skipOutboxGap(
      database,
      context(tenant),
      gap.id,
      { reason: REASON },
      actor,
    );
    expect(done.id).toBe(gap.id);
    expect(await listOpenOutboxGaps(database, context(tenant))).toEqual([]);
    const offset = await rows(
      tenant,
      sql`SELECT last_sequence FROM domain_event_offsets WHERE aggregate_id = ${ulidToUuid(aggregateId)}::uuid`,
    );
    expect(Number(offset[0]?.last_sequence)).toBe(1);
    const audit = await rows(
      tenant,
      sql`SELECT event FROM audit_logs WHERE tenant_id = ${tenant}::uuid`,
    );
    const event = (
      audit.find(
        (r) => (r.event as { action: string }).action === "outbox_gap.skipped",
      ) as { event: Record<string, unknown> }
    ).event;
    expect(event.actorId).toBe(actor);
    expect(event.reason).toBe(REASON);
    expect(event.objectId).toBe(gap.id);
    expect(
      (event.maskedChanges as { after: { missingSequence: number } }).after
        .missingSequence,
    ).toBe(1);
    // A second skip of the same gap is refused.
    await expect(
      skipOutboxGap(
        database,
        context(tenant),
        gap.id,
        { reason: REASON },
        actor,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("skips a gap of an outlet-scoped aggregate: the offset outlet matches the event outlet and the next event is consumable", async () => {
    // audit_logs has an outlet FK, so this uses the seeded tenant and outlet.
    const tenant = cafeLegendPlatformFixtures.tenant.id;
    const outletId = outletIdSchema.parse(
      cafeLegendAccessFixtures.outletIds.bandung,
    );
    const { aggregateId, outboxId, gap } = await openGap(tenant, outletId);
    await skipOutboxGap(
      database,
      context(tenant),
      gap.id,
      { reason: REASON },
      actor,
    );
    const offset = await rows(
      tenant,
      sql`SELECT outlet_id, last_sequence FROM domain_event_offsets WHERE aggregate_id = ${ulidToUuid(aggregateId)}::uuid`,
    );
    expect(offset[0]?.outlet_id).toBe(outletId);
    expect(Number(offset[0]?.last_sequence)).toBe(1);
    const audit = await rows(
      tenant,
      sql`SELECT outlet_id FROM audit_logs WHERE tenant_id = ${tenant}::uuid AND event->>'objectId' = ${gap.id} AND event->>'action' = 'outbox_gap.skipped'`,
    );
    expect(audit[0]?.outlet_id).toBe(outletId);
    // Sequence 2 now delivers: consumeOutbox rejects an offset whose
    // outlet_id differs from the event's ("Aggregate outlet changed").
    const delivered: number[] = [];
    await consumeOutbox(
      database,
      context(tenant, { kind: "outlets", outletIds: [outletId] }),
      {
        outboxId,
        authorize: async () => true,
        deliver: async (event) => {
          delivered.push(event.sequence);
        },
      },
    );
    expect(delivered).toEqual([2]);
  });

  it("refuses a gap of another tenant and a missing gap", async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const { gap } = await openGap(a);
    await expect(
      skipOutboxGap(database, context(b), gap.id, { reason: REASON }, actor),
    ).rejects.toMatchObject({ status: 404 });
    expect(await listOpenOutboxGaps(database, context(a))).toHaveLength(1);
  });

  it("refuses to skip when the event is in the outbox after all", async () => {
    const tenant = randomUUID();
    const { aggregateId, gap } = await openGap(tenant);
    await withTenant(database, context(tenant), (tx) =>
      appendOutbox(tx, context(tenant), {
        id: createUlid(),
        event: {
          ...eventFixture,
          id: createUlid(),
          tenantId: tenant,
          outletId: null,
          aggregateId,
          sequence: 1,
        },
        destination: "test",
        direction: null,
        peerId: null,
      }),
    );
    await expect(
      skipOutboxGap(
        database,
        context(tenant),
        gap.id,
        { reason: REASON },
        actor,
      ),
    ).rejects.toMatchObject({ status: 409 });
    const audit = await rows(
      tenant,
      sql`SELECT 1 FROM audit_logs WHERE tenant_id = ${tenant}::uuid`,
    );
    expect(audit).toHaveLength(0);
  });

  it("requires a written reason", () => {
    expect(skipOutboxGapInputSchema.safeParse({}).success).toBe(false);
    expect(
      skipOutboxGapInputSchema.safeParse({ reason: "short" }).success,
    ).toBe(false);
    expect(skipOutboxGapInputSchema.safeParse({ reason: REASON }).success).toBe(
      true,
    );
  });
});

// The permission platform.event_gap.manage carries only the "platform" tag, so
// it is held by exactly the revocable platform_admins registry. The platform
// router refuses everyone else before any handler runs (requirePlatformAdmin).
describe("legend-jcil platform routes enforce platform.event_gap.manage", () => {
  const app = createApp();
  const tenant = cafeLegendPlatformFixtures.tenant.id;
  const adminUserIds: string[] = [];
  afterAll(async () => {
    if (adminUserIds.length)
      await ownerPool.query(
        "DELETE FROM platform_admins WHERE user_id = ANY($1::text[])",
        [adminUserIds],
      );
  });

  it("answers 403 to a signed-in user and a legacy admin role, and changes nothing", async () => {
    const { gap } = await openGap(tenant);
    const user = agent(app);
    await signUp(user, "Biasa");
    const legacy = agent(app);
    await setRole(await signUp(legacy, "Legacy Admin"), "admin");
    for (const client of [user, legacy]) {
      const list = await client.get(
        `/api/platform/tenants/${tenant}/outbox-gaps`,
      );
      expect(list.status).toBe(403);
      const skip = await client
        .post(`/api/platform/tenants/${tenant}/outbox-gaps/${gap.id}/skip`)
        .set(originHeader)
        .send({ reason: REASON });
      expect(skip.status).toBe(403);
    }
    const open = await listOpenOutboxGaps(database, context(tenant));
    expect(open.map((g) => g.id)).toContain(gap.id);
    await skipOutboxGap(
      database,
      context(tenant),
      gap.id,
      { reason: REASON },
      actor,
    );
  });

  it("lets a platform admin list and skip a gap", async () => {
    const { gap } = await openGap(tenant);
    const admin = agent(app);
    const email = await signUp(admin, "Platform Admin");
    const session = await admin.get("/api/auth/get-session");
    const userId = session.body.user.id as string;
    adminUserIds.push(userId);
    await ownerPool.query(
      "INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [userId],
    );
    await verifySessionMfa(email);
    const list = await admin.get(`/api/platform/tenants/${tenant}/outbox-gaps`);
    expect(list.status).toBe(200);
    expect((list.body.data as { id: string }[]).map((g) => g.id)).toContain(
      gap.id,
    );
    const skip = await admin
      .post(`/api/platform/tenants/${tenant}/outbox-gaps/${gap.id}/skip`)
      .set(originHeader)
      .send({ reason: REASON });
    expect(skip.status).toBe(200);
    expect(skip.body.data.id).toBe(gap.id);
    const open = await listOpenOutboxGaps(database, context(tenant));
    expect(open.map((g) => g.id)).not.toContain(gap.id);
  });
});
