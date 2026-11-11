// legend-488 items 4, 5 (global half) and 9: the control-plane event stream.
// Written from the design (docs: design-controlplane.md), not from the
// implementation. Fail-first: none of the names below exist yet.
//
// Assumed names (all new):
// - @starter/shared/events: CONTROL_PLANE_TENANT_ID, CONTROL_PLANE_DESTINATION
//   ("control-plane"), CONTROL_PLANE_PACKAGE_DESTINATION
//   ("control-plane-package"), isControlPlaneDestination(destination).
// - ../services/control-plane-events.ts: deliverControlPlaneEvent(context, event, tx).
// - relayOutbox(db, ctx, enqueue, requestMissing, { destinations }).
//
// Decisions / assumptions:
// - CTO deviation: the tenant.status_changed consumer ONLY acknowledges
//   (consumption row + outbox row delivered). It must NOT revoke sessions, so
//   these tests assert subject sessions stay live after delivery.
// - The sentinel stream is read as the table owner (bypasses RLS); the sentinel
//   is addressed by tenant_id = CONTROL_PLANE_TENANT_ID, subject tenant by
//   aggregate_id.
// - Only this file sweeps the sentinel stream, so parallel files do not steal
//   each other's leases. The sweep delivers every claimed row (consumers are
//   idempotent).
// - Atomicity is checked through the real service with a throwing audit writer:
//   the audit row is written in the same transaction as the status change and
//   the event, so a failure must leave no status change and no event.
import { randomBytes, randomUUID } from "node:crypto";
import { idr, uuidToUlid } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  CONTROL_PLANE_DESTINATION,
  CONTROL_PLANE_PACKAGE_DESTINATION,
  CONTROL_PLANE_TENANT_ID,
  eventFixture,
} from "@starter/shared/events";
import type { CreateTenantInput } from "@starter/shared/platform";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  appendOutbox,
  consumeOutbox,
  relayOutbox,
} from "../services/core-outbox.ts";
import { deliverControlPlaneEvent } from "../services/control-plane-events.ts";
import { revokeOwnSession } from "../services/identity-session.service.ts";
import {
  createTenant,
  setTenantPackage,
  setTenantStatus,
} from "../services/platform-org.service.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
let actorUserId: string;

const limits: CreateTenantInput["limits"] = {
  maxOutlets: 5,
  maxActiveEmployees: 30,
  maxDevices: 10,
  aiRequestsPerMonth: 100,
  whatsappCostCapIdr: idr(0),
  aiCostCapIdr: idr(50_000),
  emailCostCapIdr: idr(10_000),
};

const sentinelContext = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: CONTROL_PLANE_TENANT_ID,
      brandId: null,
      source: "job",
    }),
    { kind: "tenant" },
  );
const tenantContext = (tenantId: string) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );

async function newTenant(): Promise<string> {
  const tenant = await createTenant(
    {
      slug: `cp-${randomBytes(4).toString("hex")}`,
      name: "Uji Control Plane",
      plan: "lengkap",
      deploymentMode: "shared",
      featureFlags: { modules: ["pos", "qr_order"], integrationProviders: [] },
      limits,
      firstAdmin: {
        name: "Admin Control",
        whatsapp: `62812${String(randomBytes(4).readUInt32BE() % 100_000_000).padStart(8, "0")}`,
        email: null,
      },
    },
    actorUserId,
  );
  return tenant.id;
}

async function newUser(): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Pengguna Control', $2, true)`,
    [id, `cp-${id}@example.com`],
  );
  return id;
}

async function newSession(
  userId: string,
  tenantId: string | null,
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO session (id, expires_at, token, user_id, tenant_id)
     VALUES ($1, now() + interval '1 day', $2, $3, $4)`,
    [id, randomBytes(16).toString("hex"), userId, tenantId],
  );
  return id;
}

async function isRevoked(sessionId: string): Promise<boolean> {
  const { rows } = await owner.query<{ revoked_at: Date | null }>(
    "SELECT revoked_at FROM session WHERE id = $1",
    [sessionId],
  );
  return rows[0]!.revoked_at !== null;
}

type ControlRow = {
  id: string;
  destination: string;
  sequence: string;
  status: string;
  delivered_at: Date | null;
  event: { name: string; payload: Record<string, unknown> };
};

/** Sentinel-stream rows of one aggregate (a subject tenant or a session). */
async function controlRows(
  aggregateType: string,
  aggregateId: string,
): Promise<ControlRow[]> {
  const { rows } = await owner.query<ControlRow>(
    `SELECT id, destination, sequence, status, delivered_at, event
       FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_type = $2 AND aggregate_id = $3
      ORDER BY destination, sequence`,
    [CONTROL_PLANE_TENANT_ID, aggregateType, aggregateId],
  );
  return rows;
}

async function subjectCloudSyncNames(tenantId: string): Promise<string[]> {
  const { rows } = await owner.query<{ name: string }>(
    `SELECT event->>'name' AS name FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_type = 'tenant' ORDER BY sequence`,
    [tenantId],
  );
  return rows.map((row) => row.name);
}

/** Consumption rows are keyed by the event id, not the outbox row id. */
async function consumptionCount(outboxId: string): Promise<number> {
  const { rows } = await owner.query<{ total: string }>(
    `SELECT count(*) AS total FROM domain_event_consumptions
      WHERE tenant_id = $1
        AND event_id = (SELECT event_id FROM domain_event_outbox WHERE id = $2)`,
    [CONTROL_PLANE_TENANT_ID, outboxId],
  );
  return Number(rows[0]!.total);
}

/** One relay sweep of the sentinel stream, as the worker's controlPlaneRelay does. */
async function sweep() {
  const context = sentinelContext();
  const gaps: unknown[] = [];
  const claimed: { tenantId: string; outboxId: string; generation: number }[] =
    [];
  for (let round = 0; round < 5; round += 1) {
    const jobs: typeof claimed = [];
    await relayOutbox(
      db,
      context,
      async (job) => {
        jobs.push(job as (typeof claimed)[number]);
        return randomUUID();
      },
      async (gap) => {
        gaps.push(gap);
      },
      { destinations: [CONTROL_PLANE_DESTINATION] },
    );
    if (jobs.length === 0) break;
    for (const job of jobs) {
      claimed.push(job);
      await consumeOutbox(db, context, {
        outboxId: job.outboxId,
        generation: job.generation,
        authorize: async () => true,
        deliver: (event, _key, tx) =>
          deliverControlPlaneEvent(context, event, tx),
      });
    }
  }
  return { claimed, gaps };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  actorUserId = await newUser();
  setAuditWriter(coreAuditWriter);
});

afterAll(async () => {
  setAuditWriter(coreAuditWriter);
  await owner.end();
});

describe("control-plane write path (legend-488 item 4)", () => {
  it("a suspend writes one sentinel control-plane row about the subject and nothing to the subject's cloud-sync", async () => {
    const tenantId = await newTenant();
    await setTenantStatus(
      tenantId,
      { status: "suspended", reason: "Tidak membayar tagihan bulan ini." },
      actorUserId,
    );
    const rows = await controlRows("tenant", tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      destination: CONTROL_PLANE_DESTINATION,
      sequence: "1",
    });
    expect(rows[0]?.event.name).toBe("tenant.status_changed");
    expect(rows[0]?.event.payload).toMatchObject({
      from: "active",
      to: "suspended",
    });
    // tenant.created stays on the subject's own stream (out of scope).
    expect(await subjectCloudSyncNames(tenantId)).toEqual(["tenant.created"]);
  });

  it("a failure inside the transaction rolls back the status change and the event together", async () => {
    const tenantId = await newTenant();
    setAuditWriter({
      record: async () => {
        throw new Error("audit down");
      },
    });
    try {
      await expect(
        setTenantStatus(
          tenantId,
          { status: "suspended", reason: "Audit sengaja gagal di sini." },
          actorUserId,
        ),
      ).rejects.toThrow();
    } finally {
      setAuditWriter(coreAuditWriter);
    }
    const { rows } = await owner.query<{ status: string }>(
      "SELECT status FROM tenants WHERE id = $1",
      [tenantId],
    );
    expect(rows[0]?.status).toBe("active");
    expect(await controlRows("tenant", tenantId)).toHaveLength(0);
  });

  it("a later change of the same tenant still writes its own rows (tenant scope restored after the append)", async () => {
    const tenantId = await newTenant();
    await setTenantStatus(
      tenantId,
      { status: "suspended", reason: "Tidak membayar tagihan bulan ini." },
      actorUserId,
    );
    await setTenantStatus(
      tenantId,
      { status: "active", reason: "Tagihan sudah dibayar lunas." },
      actorUserId,
    );
    const rows = await controlRows("tenant", tenantId);
    expect(rows.map((row) => [row.sequence, row.event.payload.to])).toEqual([
      ["1", "suspended"],
      ["2", "active"],
    ]);
    const { rows: tenant } = await owner.query<{ status: string }>(
      "SELECT status FROM tenants WHERE id = $1",
      [tenantId],
    );
    expect(tenant[0]?.status).toBe("active");
  });
});

describe("control-plane delivery to a suspended tenant (legend-488 item 4)", () => {
  for (const status of ["suspended", "archived"] as const) {
    it(`a ${status} tenant's status event is relayed and delivered; its sessions are not revoked`, async () => {
      const tenantId = await newTenant();
      const userId = await newUser();
      const sessionId = await newSession(userId, tenantId);
      await setTenantStatus(
        tenantId,
        { status, reason: "Alasan operator untuk uji ini." },
        actorUserId,
      );
      const [pending] = await controlRows("tenant", tenantId);
      expect(pending?.status).toBe("pending");

      await sweep();

      const [row] = await controlRows("tenant", tenantId);
      expect(row?.status).toBe("delivered");
      expect(row?.delivered_at).not.toBeNull();
      expect(await consumptionCount(row!.id)).toBe(1);
      // CTO scope: acknowledge only.
      expect(await isRevoked(sessionId)).toBe(false);
    });
  }

  it("suspend then reactivate before delivery: both events deliver in order, sessions stay live, redelivery is a no-op", async () => {
    const tenantId = await newTenant();
    const userId = await newUser();
    const sessionId = await newSession(userId, tenantId);
    await setTenantStatus(
      tenantId,
      { status: "suspended", reason: "Tidak membayar tagihan bulan ini." },
      actorUserId,
    );
    await setTenantStatus(
      tenantId,
      { status: "active", reason: "Tagihan sudah dibayar lunas." },
      actorUserId,
    );
    const { claimed } = await sweep();
    expect(claimed.length).toBeGreaterThanOrEqual(2);
    const rows = await controlRows("tenant", tenantId);
    expect(rows.map((row) => row.status)).toEqual(["delivered", "delivered"]);
    expect(await isRevoked(sessionId)).toBe(false);

    // Same event again (pg-boss retry): dedupe on the consumption row.
    const context = sentinelContext();
    const again = await consumeOutbox(db, context, {
      outboxId: uuidToUlid(rows[0]!.id),
      generation: 0,
      authorize: async () => true,
      deliver: (event, _key, tx) =>
        deliverControlPlaneEvent(context, event, tx),
    });
    expect(again).toBe(false);
    expect(await consumptionCount(rows[0]!.id)).toBe(1);
    expect(await isRevoked(sessionId)).toBe(false);
  });
});

describe("tenant.package_changed stays parked (legend-488 item 9)", () => {
  it("is written to control-plane-package, never claimed, never delivered, and does not block the status stream", async () => {
    const tenantId = await newTenant();
    await setTenantPackage(
      tenantId,
      {
        plan: "outlet-dasar",
        featureFlags: { modules: ["pos"], integrationProviders: [] },
        limits: { ...limits, maxOutlets: 1 },
        reason: "Turun ke paket outlet dasar.",
      },
      actorUserId,
    );
    const rows = await controlRows("tenant", tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      destination: CONTROL_PLANE_PACKAGE_DESTINATION,
      sequence: "1",
    });
    expect(rows[0]?.event.name).toBe("tenant.package_changed");
    // Not on the subject's cloud-sync either.
    expect(await subjectCloudSyncNames(tenantId)).toEqual(["tenant.created"]);

    const first = await sweep();
    const second = await sweep();
    const [parked] = await controlRows("tenant", tenantId);
    expect(parked?.status).toBe("pending");
    expect(parked?.delivered_at).toBeNull();
    expect(
      [...first.claimed, ...second.claimed].some(
        (job) => job.outboxId === uuidToUlid(parked!.id),
      ),
    ).toBe(false);
    expect([...first.gaps, ...second.gaps]).toEqual([]);

    // A later status change of the same tenant is a separate stream and flows.
    await setTenantStatus(
      tenantId,
      { status: "suspended", reason: "Tidak membayar tagihan bulan ini." },
      actorUserId,
    );
    await sweep();
    const after = await controlRows("tenant", tenantId);
    const byName = Object.fromEntries(
      after.map((row) => [row.event.name, row]),
    );
    expect(byName["tenant.status_changed"]).toMatchObject({
      destination: CONTROL_PLANE_DESTINATION,
      sequence: "1",
      status: "delivered",
    });
    expect(byName["tenant.package_changed"]?.status).toBe("pending");
  });
});

describe("platform-only session.revoked on the control plane (legend-488 item 5)", () => {
  it("revoking a platform session writes one sentinel row, even for two concurrent revokes", async () => {
    const userId = await newUser();
    const sessionId = await newSession(userId, null);
    const sibling = await newSession(userId, null);
    await Promise.all([
      revokeOwnSession({ userId, sessionId }),
      revokeOwnSession({ userId, sessionId }),
    ]);
    const rows = await controlRows("session", sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      destination: CONTROL_PLANE_DESTINATION,
      sequence: "1",
    });
    expect(rows[0]?.event.name).toBe("session.revoked");
    expect(rows[0]?.event.payload).toMatchObject({ sessionId, userId });
    // Not on the old tenant-less identity stream.
    const { rows: legacy } = await owner.query(
      `SELECT 1 FROM domain_event_outbox
        WHERE tenant_id IS NULL AND aggregate_type = 'session' AND aggregate_id = $1`,
      [sessionId],
    );
    expect(legacy).toHaveLength(0);

    await sweep();
    const [delivered] = await controlRows("session", sessionId);
    expect(delivered?.status).toBe("delivered");
    expect(await isRevoked(sessionId)).toBe(true);
    // Delivery closes nothing else.
    expect(await isRevoked(sibling)).toBe(false);
    // Replay of the same row is a no-op.
    const context = sentinelContext();
    expect(
      await consumeOutbox(db, context, {
        outboxId: uuidToUlid(delivered!.id),
        generation: 0,
        authorize: async () => true,
        deliver: (event, _key, tx) =>
          deliverControlPlaneEvent(context, event, tx),
      }),
    ).toBe(false);
    expect(await isRevoked(sibling)).toBe(false);
  });
});

describe("control-plane guards fail closed (legend-488 item 9)", () => {
  const event = (tenantId: string) => ({
    ...eventFixture,
    id: "01ARZ3NDEKTSV4RRFFQ69G5FB3",
    tenantId,
    outletId: null,
    aggregateId: "01ARZ3NDEKTSV4RRFFQ69G5FB4",
    sequence: 1,
    idempotencyKey: `guard:${randomUUID()}`.slice(0, 100),
  });
  const row = (tenantId: string, destination: string) => ({
    id: "01ARZ3NDEKTSV4RRFFQ69G5FB5",
    event: event(tenantId),
    destination,
    direction: null,
    peerId: null,
  });

  it("the sentinel tenant cannot append to a normal destination", async () => {
    const context = sentinelContext();
    await expect(
      withTenant(db, context, (tx) =>
        appendOutbox(tx, context, row(CONTROL_PLANE_TENANT_ID, "cloud-sync")),
      ),
    ).rejects.toThrow();
  });

  it("a real tenant cannot append to either control-plane destination", async () => {
    const tenantId = await newTenant();
    const context = tenantContext(tenantId);
    for (const destination of [
      CONTROL_PLANE_DESTINATION,
      CONTROL_PLANE_PACKAGE_DESTINATION,
    ])
      await expect(
        withTenant(db, context, (tx) =>
          appendOutbox(tx, context, row(tenantId, destination)),
        ),
      ).rejects.toThrow();
    const { rows } = await owner.query(
      "SELECT 1 FROM domain_event_outbox WHERE tenant_id = $1 AND destination LIKE 'control-plane%'",
      [tenantId],
    );
    expect(rows).toHaveLength(0);
  });

  it("the control-plane consumer refuses a non-sentinel context and an unknown event name", async () => {
    const tenantId = await newTenant();
    const statusEvent = {
      ...event(CONTROL_PLANE_TENANT_ID),
      name: "tenant.status_changed",
    };
    await expect(
      deliverControlPlaneEvent(
        tenantContext(tenantId),
        statusEvent as never,
        {} as never,
      ),
    ).rejects.toThrow();
    await expect(
      deliverControlPlaneEvent(
        sentinelContext(),
        { ...event(CONTROL_PLANE_TENANT_ID), name: "order.paid" } as never,
        {} as never,
      ),
    ).rejects.toThrow();
  });

  it("relay with a destination allowlist ignores a normal tenant's cloud-sync rows; the default relay still claims them", async () => {
    const tenantId = await newTenant();
    const context = tenantContext(tenantId);
    const jobs: { tenantId: string; outboxId: string }[] = [];
    const enqueue = async (job: unknown) => {
      jobs.push(job as (typeof jobs)[number]);
      return randomUUID();
    };
    const requestMissing = async () => {};
    await relayOutbox(db, context, enqueue, requestMissing, {
      destinations: [CONTROL_PLANE_DESTINATION],
    });
    expect(jobs).toEqual([]);
    expect(
      await relayOutbox(db, context, enqueue, requestMissing),
    ).toBeGreaterThanOrEqual(1);
    expect(jobs.every((job) => job.tenantId === tenantId)).toBe(true);
  });

  it("the sentinel relay never returns a suspended tenant's ordinary rows", async () => {
    const tenantId = await newTenant();
    await setTenantStatus(
      tenantId,
      { status: "suspended", reason: "Tidak membayar tagihan bulan ini." },
      actorUserId,
    );
    const { claimed } = await sweep();
    expect(
      claimed.every((job) => job.tenantId === CONTROL_PLANE_TENANT_ID),
    ).toBe(true);
    const { rows } = await owner.query<{ status: string }>(
      `SELECT status FROM domain_event_outbox
        WHERE tenant_id = $1 AND destination = 'cloud-sync'`,
      [tenantId],
    );
    expect(rows.map((r) => r.status)).toEqual(["pending"]);
  });
});
