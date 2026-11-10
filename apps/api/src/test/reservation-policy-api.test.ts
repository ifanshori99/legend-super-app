// Reservation policy admin endpoints (PRD v1.7 §3.22 "DP & Kebijakan"; RSV-03;
// TEN-02/03; bead legend-u0q8). Real middleware and RLS against PostgreSQL.
// Every save is a NEW version: a stored version is never edited (only retired),
// and a stale editor gets 409.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reservationPolicySchema } from "@starter/shared/reservation";
import { createApp } from "../app";
import { agent, originHeader } from "./helpers";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  owner,
  seededOutletA,
  seededOutletB,
  seededTenantId,
  staffOfIsolatedTenant,
  staffWithRole,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers";

let app: ReturnType<typeof createApp>;
let ownerStaff: Staff;
let managerOutletA: Staff;
let cashier: Staff;
let other: IsolatedTenant;
let otherStaff: Staff;

const rules = {
  depositRequirement: "required",
  depositAmountIdr: 50_000,
  paymentWindowMinutes: 60,
  freeCancellationHours: 24,
  lateCancellationRefundBp: 5_000,
  noShowRefundBp: 0,
  minimumSpendIdr: 0,
  defaultDurationMinutes: 90,
  slotIntervalMinutes: 30,
};
const policyPath = (outletId: string) =>
  `/api/outlets/${outletId}/reservation-policy`;

async function resetPolicies(tenantId: string, outletId: string) {
  await owner.query(
    "DELETE FROM reservation_policies WHERE tenant_id = $1 AND outlet_id = $2",
    [tenantId, outletId],
  );
}

const put = (client: Staff["client"], outletId: string, body: object) =>
  client.put(policyPath(outletId)).set(originHeader).send(body);

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  ownerStaff = await staffWithRole(app, {
    template: "owner",
    label: "Policy Owner",
  });
  managerOutletA = await staffWithRole(app, {
    template: "outlet_manager",
    scopeType: "outlet",
    scopeId: seededOutletA,
    label: "Policy Manager A",
  });
  cashier = await staffWithRole(app, {
    template: "cashier",
    label: "Policy Cashier",
  });
  other = await createIsolatedTenant(`pol${randomUUID().slice(0, 8)}`);
  otherStaff = await staffOfIsolatedTenant(app, other);
});

afterAll(async () => {
  await resetPolicies(seededTenantId, seededOutletA);
  await resetPolicies(seededTenantId, seededOutletB);
  await resetPolicies(other.tenantId, other.outletId);
  await dropIsolatedTenant(other);
  await owner.end();
});

describe("reservation policy admin", () => {
  it("needs a session, a trusted origin and the outlet permission", async () => {
    const anonymous = await agent(app).get(policyPath(seededOutletA));
    expect(anonymous.status).toBe(401);
    const noOrigin = await ownerStaff.client
      .put(policyPath(seededOutletA))
      .send({ ...rules, expectedVersion: null });
    expect([401, 403]).toContain(noOrigin.status);
    const denied = await put(cashier.client, seededOutletA, {
      ...rules,
      expectedVersion: null,
    });
    expect(denied.status).toBe(403);
  });

  it("creates v1, then a new version per change, and keeps the old row untouched", async () => {
    await resetPolicies(seededTenantId, seededOutletA);
    const empty = await ownerStaff.client.get(policyPath(seededOutletA));
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual({ active: null, history: [] });

    const first = await put(ownerStaff.client, seededOutletA, {
      ...rules,
      expectedVersion: null,
    });
    expect(first.status).toBe(200);
    const v1 = reservationPolicySchema.parse(first.body.data);
    expect(v1).toMatchObject({ version: "v1", isActive: true, ...rules });

    const second = await put(ownerStaff.client, seededOutletA, {
      ...rules,
      depositAmountIdr: 75_000,
      expectedVersion: "v1",
    });
    expect(second.status).toBe(200);
    const v2 = reservationPolicySchema.parse(second.body.data);
    expect(v2).toMatchObject({ version: "v2", isActive: true });
    expect(v2.id).not.toBe(v1.id);

    const overview = await ownerStaff.client.get(policyPath(seededOutletA));
    expect(overview.status).toBe(200);
    expect(overview.body.data.active.id).toBe(v2.id);
    expect(overview.body.data.history).toHaveLength(1);
    expect(overview.body.data.history[0]).toMatchObject({
      id: v1.id,
      isActive: false,
      depositAmountIdr: 50_000,
    });

    // The frozen version keeps its rules in the table; only is_active changed.
    const { rows } = await owner.query<{
      deposit_amount_idr: string;
      is_active: boolean;
    }>(
      "SELECT deposit_amount_idr, is_active FROM reservation_policies WHERE id = $1",
      [v1.id],
    );
    expect(rows[0]).toMatchObject({
      deposit_amount_idr: "50000",
      is_active: false,
    });
  });

  it("refuses a stale editor with 409 and treats identical rules as a no-op", async () => {
    await resetPolicies(seededTenantId, seededOutletA);
    const first = await put(ownerStaff.client, seededOutletA, {
      ...rules,
      expectedVersion: null,
    });
    expect(first.status).toBe(200);

    const stale = await put(ownerStaff.client, seededOutletA, {
      ...rules,
      depositAmountIdr: 90_000,
      expectedVersion: null,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("RESERVATION_POLICY_VERSION_CONFLICT");

    const retry = await put(ownerStaff.client, seededOutletA, {
      ...rules,
      expectedVersion: null,
    });
    expect(retry.status).toBe(200);
    expect(retry.body.data.id).toBe(first.body.data.id);
    const { rows } = await owner.query(
      "SELECT 1 FROM reservation_policies WHERE tenant_id = $1 AND outlet_id = $2",
      [seededTenantId, seededOutletA],
    );
    expect(rows).toHaveLength(1);
  });

  it("validates the body strictly", async () => {
    const noDeposit = await put(ownerStaff.client, seededOutletA, {
      ...rules,
      depositAmountIdr: 0,
      expectedVersion: null,
    });
    expect(noDeposit.status).toBe(422);
    const withTenant = await put(ownerStaff.client, seededOutletA, {
      ...rules,
      expectedVersion: null,
      tenantId: randomUUID(),
    });
    expect(withTenant.status).toBe(422);
    const outOfRange = await put(ownerStaff.client, seededOutletA, {
      ...rules,
      lateCancellationRefundBp: 10_001,
      expectedVersion: null,
    });
    expect(outOfRange.status).toBe(422);
  });

  it("TEN-03 an outlet-scoped manager cannot read or save another outlet's policy", async () => {
    await resetPolicies(seededTenantId, seededOutletB);
    const own = await managerOutletA.client.get(policyPath(seededOutletA));
    expect(own.status).toBe(200);
    const read = await managerOutletA.client.get(policyPath(seededOutletB));
    expect(read.status).toBe(403);
    const write = await put(managerOutletA.client, seededOutletB, {
      ...rules,
      expectedVersion: null,
    });
    expect(write.status).toBe(403);
    const { rows } = await owner.query(
      "SELECT 1 FROM reservation_policies WHERE tenant_id = $1 AND outlet_id = $2",
      [seededTenantId, seededOutletB],
    );
    expect(rows).toHaveLength(0);
  });

  it("TEN-02 another tenant's staff cannot see or write this tenant's policy, and the reverse", async () => {
    await resetPolicies(seededTenantId, seededOutletA);
    const seeded = await put(ownerStaff.client, seededOutletA, {
      ...rules,
      expectedVersion: null,
    });
    expect(seeded.status).toBe(200);

    const read = await otherStaff.client.get(policyPath(seededOutletA));
    expect([403, 404]).toContain(read.status);
    const write = await put(otherStaff.client, seededOutletA, {
      ...rules,
      depositAmountIdr: 1,
      expectedVersion: "v1",
    });
    expect([403, 404]).toContain(write.status);

    const reverseRead = await ownerStaff.client.get(policyPath(other.outletId));
    expect([403, 404]).toContain(reverseRead.status);
    const reverseWrite = await put(ownerStaff.client, other.outletId, {
      ...rules,
      expectedVersion: null,
    });
    expect([403, 404]).toContain(reverseWrite.status);

    const { rows } = await owner.query(
      "SELECT deposit_amount_idr FROM reservation_policies WHERE tenant_id = $1 AND outlet_id = $2",
      [seededTenantId, seededOutletA],
    );
    expect(rows).toEqual([{ deposit_amount_idr: "50000" }]);
    const { rows: foreign } = await owner.query(
      "SELECT 1 FROM reservation_policies WHERE tenant_id = $1",
      [other.tenantId],
    );
    expect(foreign).toHaveLength(0);
  });
});
