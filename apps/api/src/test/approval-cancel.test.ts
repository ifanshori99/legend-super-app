// Requester cancels their own pending approval (bead legend-6hr8) and POS
// override reason codes (bead legend-5vlw). PRD v1.7 §3 F6 "Override
// Supervisor", §3 F7 Kotak Approval, AUTH-06, TEN-01.
//
// Contract under test (sub-brief A1/A2, tier K):
//   POST /api/approvals/:requestId/cancel
//     - anonymous -> 401; no trusted Origin -> 403
//     - only the requester, only a pending request, same tenant
//     - another user of the same tenant -> 404 (no leak); another tenant -> 404
//     - pending -> 200 with the approval DTO (status "cancelled"), one
//       approval.resolved outbox event (outcome "cancelled") and an audit row
//     - repeat on a cancelled request -> 200 (idempotent), no second event
//     - approved / rejected / expired -> 409
//   POST /api/pos-overrides with a reasonCode outside the shared list -> 422.
//
// Assumptions (spec is silent): the HTTP cancel only acts on sourceModule
// "inbox" requests (other modules -> 409), so rows are seeded as inbox; a
// pending row past deadline_at is 409 even before the sweep runs; the audit action for a cancel contains
// "cancel"; the cancelled outbox payload carries `outcome: "cancelled"` like
// the other approval.resolved outcomes. Rows are seeded straight into
// approval_requests (as TEN-01 does) so this file does not touch the shared
// approval_policies matrix that platform-approval.test.ts rewrites.
// Real Express app + Better Auth + PostgreSQL (disposable server).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { setAuditWriter, type AuditEntry } from "../services/audit-writer";
import { expireDueApprovalRequests } from "../services/platform-approval.service";
import { agent, originHeader, verifySessionMfa } from "./helpers";
import { owner, staffWithRole, type Staff } from "./floor-test-helpers";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const bandung = cafeLegendAccessFixtures.outletIds.bandung;
const bandung2 = cafeLegendAccessFixtures.outletIds.bandung2;
const tenantB = randomUUID();
const audits: AuditEntry[] = [];
const createdUserIds: string[] = [];
const createdRequestIds: string[] = [];
const tenantWide: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "session" }),
  { kind: "tenant" },
);

let requester: Staff;
let otherUser: Staff;
let decider: Staff;

async function signedIn(label: string): Promise<Staff> {
  const staff = await staffWithRole(app, {
    template: "cashier",
    scopeType: "outlet",
    scopeId: bandung,
    label,
  });
  createdUserIds.push(staff.userId);
  await verifySessionMfa(staff.email);
  return staff;
}

type SeedOptions = {
  forTenant?: string;
  sourceModule?: string;
  outletId?: string | null;
  /** SQL expression for deadline_at. */
  deadlineSql?: string;
};

/**
 * A pending approval request owned by `requestedBy`. Defaults to a request
 * the inbox opened (sourceModule "inbox"): the HTTP cancel only acts on those.
 */
async function seedPending(
  requestedBy: string,
  options: SeedOptions | string = {},
): Promise<string> {
  const opts: SeedOptions =
    typeof options === "string" ? { forTenant: options } : options;
  const id = randomUUID();
  await owner.query(
    `INSERT INTO approval_requests
       (id, tenant_id, outlet_id, chain_id, source_module, action_type, object_type, object_id,
        requested_by, source, level, required_levels, required_steps, request_reason, deadline_at, created_at)
     VALUES ($1, $2, $5, $1, $6, 'void', 'order', $3, $4, 'user', 1, 1, '[]',
             'Pelanggan membatalkan pesanan sebelum dapur mulai.', ${opts.deadlineSql ?? "now() + interval '1 hour'"},
             now() - interval '2 hours')`,
    [
      id,
      opts.forTenant ?? tenantId,
      randomUUID(),
      requestedBy,
      opts.outletId ?? null,
      opts.sourceModule ?? "inbox",
    ],
  );
  createdRequestIds.push(id);
  return id;
}

/** 2-level chain: level 1 approved (id returned), level 2 pending. */
async function seedTwoLevelChain(requestedBy: string, approver: string) {
  const level1 = await seedPending(requestedBy);
  await owner.query(
    `UPDATE approval_requests SET required_levels = 2, status = 'approved',
       decided_by = $2, decided_at = now(), reason = 'Level 1 setuju.' WHERE id = $1`,
    [level1, approver],
  );
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO approval_requests
       (tenant_id, outlet_id, chain_id, source_module, action_type, object_type, object_id,
        requested_by, source, level, required_levels, required_steps, request_reason, deadline_at)
     SELECT tenant_id, outlet_id, chain_id, source_module, action_type, object_type, object_id,
        requested_by, source, 2, required_levels, required_steps, request_reason,
        now() + interval '2 hours'
     FROM approval_requests WHERE id = $1
     RETURNING id`,
    [level1],
  );
  const level2 = rows[0]!.id;
  createdRequestIds.push(level2);
  return { level1, level2 };
}

async function statusOf(id: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM approval_requests WHERE id = $1",
    [id],
  );
  return rows[0]!.status;
}

/**
 * approval.resolved rows for one destination. The service appends one row per
 * destination (cloud-sync for the source module, notification for alerts), so
 * "exactly once" is counted per destination.
 */
async function resolvedEvents(chainId: string, destination = "cloud-sync") {
  const { rows } = await owner.query<{
    payload: Record<string, unknown>;
  }>(
    `SELECT event->'payload' AS payload
     FROM domain_event_outbox
     WHERE tenant_id = $1 AND aggregate_type = 'approval' AND aggregate_id = $2
       AND event->>'name' = 'approval.resolved' AND destination = $3`,
    [tenantId, chainId, destination],
  );
  return rows;
}

const cancelAs = (staff: Staff, id: string, key?: string) => {
  const request = staff.client
    .post(`/api/approvals/${id}/cancel`)
    .set(originHeader);
  return (key ? request.set("Idempotency-Key", key) : request).send({});
};

beforeAll(async () => {
  setAuditWriter({
    record: async (entry) => {
      audits.push(entry);
    },
  });
  requester = await signedIn("Kasir pembatal");
  otherUser = await signedIn("Kasir lain");
  decider = await signedIn("Pemutus");
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Cancel test tenant', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [tenantB, `cancel-${tenantB}`, randomUUID()],
  );
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.query(
    "DELETE FROM approval_requests WHERE id = ANY($1::uuid[])",
    [createdRequestIds],
  );
  await owner.query("DELETE FROM tenants WHERE id = $1", [tenantB]);
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantId, createdUserIds],
  );
  await owner.end();
});

describe("legend-6hr8 POST /api/approvals/:requestId/cancel", () => {
  it("legend-6hr8 the requester cancels a pending request: 200 cancelled, one approval.resolved event, audit row", async () => {
    const id = await seedPending(requester.userId);
    const response = await cancelAs(requester, id, `cancel-${randomUUID()}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toMatchObject({
      id,
      status: "cancelled",
      requestedBy: requester.userId,
    });
    expect(await statusOf(id)).toBe("cancelled");

    const events = await resolvedEvents(id);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((row) => row.payload.outcome === "cancelled")).toBe(
      true,
    );
    expect(
      audits.some(
        (row) => row.objectId === id && /cancel/i.test(String(row.action)),
      ),
    ).toBe(true);
  });

  it("legend-6hr8 the browser sends the cancel with no body and no content-type: 200 cancelled, not 415", async () => {
    const id = await seedPending(requester.userId);
    const response = await requester.client
      .post(`/api/approvals/${id}/cancel`)
      .set(originHeader);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.status).toBe("cancelled");
    expect(await statusOf(id)).toBe("cancelled");
  });

  it("legend-6hr8 a repeat cancel is 200 with the same data and emits no second event", async () => {
    const id = await seedPending(requester.userId);
    const first = await cancelAs(requester, id);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const eventsAfterFirst = (await resolvedEvents(id)).length;
    expect(eventsAfterFirst).toBeGreaterThanOrEqual(1);

    const repeat = await cancelAs(requester, id);
    expect(repeat.status, JSON.stringify(repeat.body)).toBe(200);
    expect(repeat.body.data).toMatchObject({ id, status: "cancelled" });
    const keyed = await cancelAs(requester, id, `again-${randomUUID()}`);
    expect(keyed.status, JSON.stringify(keyed.body)).toBe(200);
    expect((await resolvedEvents(id)).length).toBe(eventsAfterFirst);
  });

  it("legend-6hr8 another user of the same tenant gets 404 and the request stays pending", async () => {
    const id = await seedPending(requester.userId);
    const response = await cancelAs(otherUser, id);
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(await statusOf(id)).toBe("pending");
    expect(await resolvedEvents(id)).toHaveLength(0);
  });

  it("legend-6hr8 a request of another tenant gets 404 even when requested by the caller's own user id (TEN-01)", async () => {
    // Same requested_by as the caller: only the tenant filter can refuse it.
    const id = await seedPending(requester.userId, { forTenant: tenantB });
    const response = await cancelAs(requester, id);
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(await statusOf(id)).toBe("pending");
  });

  it("legend-6hr8 an unknown request id gets 404", async () => {
    const response = await cancelAs(requester, randomUUID());
    expect(response.status, JSON.stringify(response.body)).toBe(404);
  });

  it.each(["approved", "rejected", "expired"] as const)(
    "legend-6hr8 a %s request cannot be cancelled: 409 and the outcome stands",
    async (outcome) => {
      const id = await seedPending(requester.userId);
      if (outcome === "expired")
        await owner.query(
          "UPDATE approval_requests SET status = 'expired', updated_at = now() WHERE id = $1",
          [id],
        );
      else
        await owner.query(
          `UPDATE approval_requests SET status = $2, decided_by = $3,
             decided_at = now(), reason = 'Sesuai bukti transaksi.' WHERE id = $1`,
          [id, outcome, decider.userId],
        );
      const response = await cancelAs(requester, id);
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(await statusOf(id)).toBe(outcome);
      expect(await resolvedEvents(id)).toHaveLength(0);
    },
  );

  it("legend-6hr8 a 2-level chain with level 1 approved is cancelled by the level-1 id: 200 cancelled, also on repeat", async () => {
    const { level1, level2 } = await seedTwoLevelChain(
      requester.userId,
      decider.userId,
    );
    const first = await cancelAs(requester, level1);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data.status).toBe("cancelled");
    // The reply is the level-2 row (the one that was open), not the level-1 id.
    expect(first.body.data.id).toBe(level2);
    // The open level-2 row is the one that gets cancelled; level 1 keeps its outcome.
    expect(await statusOf(level2)).toBe("cancelled");
    expect(await statusOf(level1)).toBe("approved");

    const repeat = await cancelAs(requester, level1);
    expect(repeat.status, JSON.stringify(repeat.body)).toBe(200);
    expect(repeat.body.data.status).toBe("cancelled");
  });

  it("legend-6hr8 a pending request past its deadline (sweep not run) is 409 and stays pending", async () => {
    const id = await seedPending(requester.userId, {
      deadlineSql: "now() - interval '1 minute'",
    });
    const response = await cancelAs(requester, id);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(await statusOf(id)).toBe("pending");
    expect(await resolvedEvents(id)).toHaveLength(0);

    // The sweep then expires it and announces the outcome exactly once.
    await expireDueApprovalRequests(tenantWide);
    expect(await statusOf(id)).toBe("expired");
    for (const destination of ["cloud-sync", "notification"]) {
      const events = await resolvedEvents(id, destination);
      expect(events, destination).toHaveLength(1);
      expect(events[0]!.payload.outcome).toBe("expired");
    }
  });

  it("legend-6hr8 an outlet-scoped requester whose membership no longer covers the request outlet gets 404 and it stays pending", async () => {
    // Assumption: the requester holds a role at Bandung only; the request sits
    // at the other outlet (bandung2), so their scope does not cover it.
    const id = await seedPending(requester.userId, { outletId: bandung2 });
    const response = await cancelAs(requester, id);
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(await statusOf(id)).toBe("pending");
    expect(await resolvedEvents(id)).toHaveLength(0);
  });

  it("legend-6hr8 a request opened by a module other than inbox (purchasing) is 409 and stays pending", async () => {
    const id = await seedPending(requester.userId, {
      sourceModule: "purchasing",
    });
    const response = await cancelAs(requester, id);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(await statusOf(id)).toBe("pending");
    expect(await resolvedEvents(id)).toHaveLength(0);
  });

  it("legend-6hr8 without a trusted Origin the cancel is 403 and nothing changes", async () => {
    const id = await seedPending(requester.userId);
    const response = await requester.client
      .post(`/api/approvals/${id}/cancel`)
      .send({});
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(await statusOf(id)).toBe("pending");
  });

  it("legend-6hr8 an anonymous caller gets 401", async () => {
    const id = await seedPending(requester.userId);
    const response = await agent(app)
      .post(`/api/approvals/${id}/cancel`)
      .set(originHeader)
      .send({});
    expect(response.status, JSON.stringify(response.body)).toBe(401);
    expect(await statusOf(id)).toBe("pending");
  });
});

describe("legend-5vlw POS override reason codes", () => {
  it("legend-5vlw POST /api/pos-overrides with a reasonCode outside the shared list is 422", async () => {
    const response = await requester.client
      .post("/api/pos-overrides")
      .set(originHeader)
      .send({
        outletId: bandung,
        action: "void",
        valueIdr: 45_000,
        reason: "Tamu membatalkan menu sebelum dimasak.",
        reasonCode: "kode_ngawur_tidak_terdaftar",
        objectType: "order",
        objectId: randomUUID(),
        approval: { method: "supervisor_phone" },
      });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
  });
});
