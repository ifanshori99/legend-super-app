// Edge -> cloud `attendance.logged` applier (bead legend-wh71, PRD F25 offline
// attendance). The edge records a clock-in while offline and up-syncs the event;
// the cloud link store dispatches it through the applier registry to
// edge/attendance-logged-applier.ts, which stores it with recordAttendanceLog as
// an `offline = true` log. Mirrors edge-stock-moved-applier.test.ts.
//
// Assumptions (the contract leaves them open):
// - The idempotency identity of an offline log is the edge's own log id
//   (payload.attendanceLogId, carried as the aggregate id). A re-delivered
//   envelope, or a second envelope that re-sends the same log, never makes a
//   second row.
// - "Large time skew" = the client time is far from the server receive time in
//   a way no real offline outage explains: here 3 days in the FUTURE. A normal
//   offline event (clocked 10 minutes before delivery) must carry no flag.
// - A skewed log is stored (not rejected) with validity `flagged` and the
//   stored flag reason `offline_time_skew`.
// - The applier does not need a device binding, QR token or geofence for a
//   replayed event: the edge already vetted them, so a plain event is stored
//   (validity is anything but `rejected`).
// Fixtures: one disposable tenant, two outlets, one employee, created by the
// migration owner and removed in afterAll.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createUlid,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import { attendanceLogged } from "@starter/shared/hris";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import { registerAttendanceLoggedEdgeApplier } from "../edge/attendance-logged-applier.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import { edgeEventApplier, type EdgeApplyMeta } from "../edge/ports.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const actor = randomUUID();
const tenantId = randomUUID();
const outletA = randomUUID();
const outletB = randomUUID();
let employeeId: string;
let node: AuthenticatedEdgeNode;

const DAY_MS = 24 * 60 * 60 * 1000;

const scopeOf = (outletIds: string[] | "tenant"): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    outletIds === "tenant"
      ? { kind: "tenant" }
      : {
          kind: "outlets",
          outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
        },
  );

async function createFixture() {
  const brand = randomUUID();
  const entity = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant Absen Edge', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      tenantId,
      `absen-edge-${randomBytes(4).toString("hex")}`,
      actor,
      cafeLegendPlatformFixtures.tenant.id,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brand, tenantId, `absen-edge-${randomBytes(3).toString("hex")}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
    [entity, tenantId],
  );
  for (const [id, code] of [
    [outletA, "ABS-01"],
    [outletB, "ABS-02"],
  ])
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $5, 'Jl. Uji', '{}', 'active')`,
      [id, tenantId, brand, entity, code],
    );
  employeeId = randomUUID();
  await owner.query(
    `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                            employment_type, join_date, status)
     VALUES ($1, $2, 'ABS-0001', 'Karyawan Absen Edge', $3, 'pkwtt', '2025-03-01', 'active')`,
    [employeeId, tenantId, outletA],
  );
}

let clock = Date.now();
/** An edge `attendance.logged` as the edge emits it after an offline clock-in. */
function attendanceEvent(
  overrides: {
    tenantId?: string;
    outletId?: string;
    employeeId?: string;
    attendanceLogId?: string;
    eventId?: string;
    clockedAt?: Date;
    type?: "in" | "out";
    method?: "selfie_geo" | "rotating_qr" | "manual_correction";
    validity?: "valid" | "flagged" | "rejected";
  } = {},
): { event: EventEnvelope; attendanceLogId: string } {
  clock += 1_000;
  const attendanceLogId = overrides.attendanceLogId ?? createUlid(clock);
  const clockedAt = overrides.clockedAt ?? new Date(Date.now() - 10 * 60_000);
  const outletId = overrides.outletId ?? outletA;
  const event = attendanceLogged.envelopeSchema.parse({
    id: overrides.eventId ?? createUlid(clock),
    tenantId: overrides.tenantId ?? tenantId,
    outletId,
    name: "attendance.logged",
    version: 1,
    aggregateType: "attendance",
    aggregateId: attendanceLogId,
    sequence: 1,
    // Edge emit time: right after the clock-in unless the clock itself is skewed.
    occurredAt:
      clockedAt.getTime() > Date.now()
        ? new Date().toISOString()
        : new Date(clockedAt.getTime() + 5_000).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `attendance.logged:${attendanceLogId}`,
    payloadSchemaRef: "attendance.logged.v1",
    payload: {
      attendanceLogId,
      employeeId: overrides.employeeId ?? employeeId,
      outletId,
      type: overrides.type ?? "in",
      method: overrides.method ?? "selfie_geo",
      occurredAt: clockedAt.toISOString(),
      validity: overrides.validity ?? "valid",
      shiftAssignmentId: null,
    },
  }) as EventEnvelope;
  return { event, attendanceLogId };
}

function store() {
  return createDbLinkStore({
    database: db,
    context: node.context,
    node: node.scope,
    outboundDirection: "cloud_to_edge",
  });
}

async function deliver(events: EventEnvelope[]) {
  const link = store();
  const from = await link.lastReceivedInbound();
  await link.applyInbound({
    fromSeq: from,
    toSeq: from + events.length,
    events: events.map((event, index) => ({
      linkSeq: from + index + 1,
      event,
    })),
  });
}

const meta = (context = node.context): EdgeApplyMeta => ({
  edgeNodeId: node.scope.edgeNodeId,
  direction: "edge_to_cloud",
  kind: "transaction_event",
  context,
});

/** Direct apply through the registry, bypassing the link sequencer. */
const applyDirect = (event: EventEnvelope, context = node.context) =>
  withTenant(db, context, (tx) =>
    edgeEventApplier("edge_to_cloud").apply(tx, event, meta(context)),
  );

type LogRow = {
  id: string;
  outlet_id: string;
  type: string;
  method: string;
  offline: boolean;
  validity: string;
  flag_reasons: string[];
  review_status: string;
  occurred_at: Date;
  client_event_id: string;
};

async function logsOfEmployee(forEmployee = employeeId) {
  const { rows } = await owner.query<LogRow>(
    `SELECT id::text, outlet_id::text, type, method, offline, validity, flag_reasons, review_status,
            occurred_at, client_event_id
       FROM attendance_logs WHERE tenant_id = $1 AND employee_id = $2
      ORDER BY occurred_at`,
    [tenantId, forEmployee],
  );
  return rows;
}

async function logCount() {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM attendance_logs WHERE tenant_id = $1",
    [tenantId],
  );
  return rows[0]!.n;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  await createFixture();
  const registered = await registerEdgeNode(scopeOf([outletA]), actor, {
    outletId: outletA,
    role: "primary",
    label: "Utama Absen",
  });
  const authenticated = await authenticateEdgeCredential(registered.credential);
  if (!authenticated) throw new Error("Edge node did not authenticate");
  node = authenticated;
});

beforeEach(async () => {
  resetEdgeApplierRegistryForTests();
  registerAttendanceLoggedEdgeApplier();
  // Each test counts rows from a clean log table of the fixture tenant.
  await owner.query("DELETE FROM attendance_logs WHERE tenant_id = $1", [
    tenantId,
  ]);
});

afterAll(async () => {
  resetEdgeApplierRegistryForTests();
  setAuditWriter(null);
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "domain_event_outbox",
      "attendance_logs",
      "attendance_corrections",
      "attendance_devices",
      "attendance_policies",
      "attendance_qr_secrets",
      "employees",
      "edge_link_slots",
      "edge_inbound_events",
      "edge_received_events",
      "edge_sync_conflicts",
      "edge_outbound_queue",
      "sync_cursors",
      "edge_nodes",
      "audit_logs",
      "outlets",
      "legal_entities",
      "brands",
    ])
      await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
        tenantId,
      ]);
    await client.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await owner.end();
  }
});

describe("legend-wh71 edge -> cloud attendance.logged", () => {
  it("stores an offline clock-in as an offline log of the employee, without a time flag", async () => {
    const clockedAt = new Date(Date.now() - 10 * 60_000);
    const { event } = attendanceEvent({ clockedAt });
    await deliver([event]);

    const rows = await logsOfEmployee();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row!.offline).toBe(true);
    expect(row!.type).toBe("in");
    expect(row!.method).toBe("selfie_geo");
    expect(row!.outlet_id).toBe(outletA);
    // The client time is trusted for an offline event.
    expect(row!.occurred_at.toISOString()).toBe(clockedAt.toISOString());
    // The edge's vetting cannot be verified from the event: flagged for review.
    expect(row!.validity).toBe("flagged");
    expect(row!.review_status).toBe("pending");
    expect(row!.flag_reasons).toContain("offline_unverified");
    expect(row!.flag_reasons).not.toContain("offline_time_skew");
  });

  it("refuses a payload the edge itself marked rejected and stores nothing", async () => {
    const { event } = attendanceEvent({ validity: "rejected" });
    await expect(applyDirect(event)).rejects.toBeTruthy();
    expect(await logsOfEmployee()).toHaveLength(0);
  });

  it("refuses an edge event with method manual_correction and stores nothing", async () => {
    const { event } = attendanceEvent({ method: "manual_correction" });
    await expect(applyDirect(event)).rejects.toBeTruthy();
    expect(await logsOfEmployee()).toHaveLength(0);
  });

  it("a re-delivered event (same event id) does not create a second log", async () => {
    const { event } = attendanceEvent();
    await deliver([event]);
    await deliver([event]);
    await applyDirect(event);
    expect(await logsOfEmployee()).toHaveLength(1);
  });

  it("a second envelope that re-sends the same log (same client event) does not create a second log", async () => {
    const first = attendanceEvent();
    await deliver([first.event]);
    // A new envelope id for the very same edge log (the edge retried the emit).
    const again = attendanceEvent({
      attendanceLogId: first.attendanceLogId,
      eventId: createUlid(clock + 500),
      clockedAt: new Date(first.event.payload.occurredAt as string),
    });
    expect(again.event.id).not.toBe(first.event.id);
    await applyDirect(again.event);
    const rows = await logsOfEmployee();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.offline).toBe(true);
  });

  it("two different offline clock-ins both land (in, then out)", async () => {
    const inEvent = attendanceEvent({
      type: "in",
      clockedAt: new Date(Date.now() - 60 * 60_000),
    });
    const outEvent = attendanceEvent({
      type: "out",
      clockedAt: new Date(Date.now() - 5 * 60_000),
    });
    await deliver([inEvent.event, outEvent.event]);
    const rows = await logsOfEmployee();
    expect(rows.map((row) => row.type)).toEqual(["in", "out"]);
    expect(rows.every((row) => row.offline)).toBe(true);
  });

  it("flags a log whose client time is far off the server time with offline_time_skew", async () => {
    const { event } = attendanceEvent({
      clockedAt: new Date(Date.now() + 3 * DAY_MS),
    });
    await deliver([event]);
    const rows = await logsOfEmployee();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.offline).toBe(true);
    expect(rows[0]!.flag_reasons).toContain("offline_time_skew");
    expect(rows[0]!.validity).toBe("flagged");
  });

  it("refuses an event of another tenant and stores nothing", async () => {
    const { event } = attendanceEvent({ tenantId: randomUUID() });
    await expect(applyDirect(event)).rejects.toThrow();
    await expect(deliver([event])).rejects.toThrow();
    expect(await logCount()).toBe(0);
  });

  it("refuses an event for an employee that does not belong to the tenant", async () => {
    const stranger = randomUUID();
    const { event } = attendanceEvent({ employeeId: stranger });
    await expect(applyDirect(event)).rejects.toThrow();
    expect(await logCount()).toBe(0);
  });

  it("refuses an event of an outlet outside the node scope", async () => {
    const { event } = attendanceEvent({ outletId: outletB });
    await expect(applyDirect(event)).rejects.toThrow();
    // Even with a tenant-wide context, the node's own outlet decides.
    await expect(applyDirect(event, scopeOf("tenant"))).rejects.toThrow();
    await expect(deliver([event])).rejects.toThrow();
    expect(await logCount()).toBe(0);
  });

  it("registering twice keeps one dispatcher", () => {
    registerAttendanceLoggedEdgeApplier();
    const dispatcher = edgeEventApplier("edge_to_cloud");
    registerAttendanceLoggedEdgeApplier();
    expect(edgeEventApplier("edge_to_cloud")).toBe(dispatcher);
  });
});
