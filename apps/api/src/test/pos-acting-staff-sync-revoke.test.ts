// Edge staff pin sync revokes acting-cashier tokens (bead legend-aruta;
// docs/DECISIONS.md "Kasir aktif per perangkat lewat token server"). A pin set
// or reset that arrives from the cloud ends the live tokens of that staff
// member at the outlet (reason pin_reset), in the same transaction as the pin
// write. A replay of the same pin material revokes nothing. The "edge" database
// is the same database, so the test plays the edge by deleting the cloud row
// first (like staff-pin-sync-order.test.ts).
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import type { StaffPinEdgeRecord } from "@starter/shared/access/override";
import {
  outletIdSchema,
  type ScopedTenantContext,
  type TenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { setAuditWriter } from "../services/audit-writer.ts";
import { setStaffPin } from "../services/device-pin.service.ts";
import {
  applyStaffPinRecords as applyStaffPinRecordsRaw,
  listStaffPinRecordsSince,
  type VerifiedEdgeNode,
} from "../services/staff-pin-sync.ts";
import { withEdgeModeEnv } from "./edge-mode-env.ts";

const applyStaffPinRecords = (
  ...args: Parameters<typeof applyStaffPinRecordsRaw>
) => withEdgeModeEnv(() => applyStaffPinRecordsRaw(...args));

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const bandung = cafeLegendAccessFixtures.outletIds.bandung;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const createdUserIds: string[] = [];
const createdDeviceIds: string[] = [];
const MINUTE = 60_000;
const PIN_A = "582914";
const PIN_B = "730418";

const tenant: TenantContext = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});
const node: VerifiedEdgeNode = {
  tenantId,
  outletId: bandung,
  edgeNodeId: randomUUID(),
};
const edgeContext: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "device" }),
  { kind: "outlets", outletIds: [outletIdSchema.parse(bandung)] },
);

async function newStaff(): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Staf sinkron kasir', $2)`,
    [id, `${id}@example.test`],
  );
  createdUserIds.push(id);
  const {
    rows: [role],
  } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'cashier'",
    [tenantId],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '2 hours', $2)`,
    [tenantId, id, role!.id, bandung],
  );
  return id;
}

async function newDevice(): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
     VALUES ($1, $2, $3, 'pos', 'Kasir sinkron', now() - interval '1 minute')`,
    [id, tenantId, bandung],
  );
  createdDeviceIds.push(id);
  return id;
}

/** A live acting-cashier token of `staffUserId` on a fresh device. */
async function issueToken(staffUserId: string): Promise<string> {
  const deviceId = await newDevice();
  const id = randomUUID();
  await owner.query(
    `INSERT INTO pos_acting_staff
       (id, tenant_id, outlet_id, device_id, staff_user_id, session_user_id,
        session_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $5, $6, $7, now() + interval '1 hour')`,
    [
      id,
      tenantId,
      bandung,
      deviceId,
      staffUserId,
      randomUUID(),
      randomUUID().replaceAll("-", "").padEnd(64, "0"),
    ],
  );
  return id;
}

async function tokenState(id: string) {
  const { rows } = await owner.query<{
    revoked: boolean;
    reason: string | null;
  }>(
    "SELECT revoked_at IS NOT NULL AS revoked, revoke_reason AS reason FROM pos_acting_staff WHERE id = $1",
    [id],
  );
  return rows[0]!;
}

async function exportRecord(userId: string): Promise<StaffPinEdgeRecord> {
  for (let attempt = 0; attempt < 50; attempt++) {
    let cursor: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const result = await listStaffPinRecordsSince(node, {
        since: cursor,
        limit: 100,
      });
      const found = result.data.find((row) => row.userId === userId);
      if (found) return found;
      if (result.meta.nextCursor === null) break;
      cursor = result.meta.nextCursor;
    }
    // A transaction of another test file can hold the commit watermark back.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Staff pin record was not exported.");
}

async function deletePin(userId: string) {
  await owner.query(
    "DELETE FROM staff_pins WHERE tenant_id = $1 AND user_id = $2",
    [tenantId, userId],
  );
}

beforeAll(() => {
  setAuditWriter({ record: async () => {} });
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.query(
    "DELETE FROM pos_acting_staff WHERE tenant_id = $1 AND staff_user_id = ANY($2::text[])",
    [tenantId, createdUserIds],
  );
  await owner.query("DELETE FROM devices WHERE id = ANY($1::uuid[])", [
    createdDeviceIds,
  ]);
  await owner.query(
    `DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_type = 'staff_pin' AND event->'payload'->>'userId' = ANY($2::text[])`,
    [tenantId, createdUserIds],
  );
  await owner.query(
    "DELETE FROM staff_pins WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantId, createdUserIds],
  );
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantId, createdUserIds],
  );
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
    createdUserIds,
  ]);
  await owner.end();
});

describe("legend-aruta edge staff pin sync revokes acting-cashier tokens", () => {
  it("revokes on an inserted pin and on a changed hash, and leaves a replay and other staff alone", async () => {
    const userId = await newStaff();
    const otherId = await newStaff();
    const now = Date.now();
    await setStaffPin(
      tenant,
      userId,
      { outletId: bandung, userId },
      { pin: PIN_A },
      { now: new Date(now - 20 * MINUTE) },
    );
    const recordA = await exportRecord(userId);
    await setStaffPin(
      tenant,
      userId,
      { outletId: bandung, userId },
      { pin: PIN_B },
      { now: new Date(now - 10 * MINUTE) },
    );
    const recordB = await exportRecord(userId);
    expect(recordB.pinHash).not.toBe(recordA.pinHash);

    // Insert branch: the edge has no copy yet.
    await deletePin(userId);
    const insertToken = await issueToken(userId);
    const otherToken = await issueToken(otherId);
    await applyStaffPinRecords(edgeContext, [recordA]);
    expect(await tokenState(insertToken)).toEqual({
      revoked: true,
      reason: "pin_reset",
    });
    expect((await tokenState(otherToken)).revoked).toBe(false);

    // A replay of the same material changes nothing.
    const replayToken = await issueToken(userId);
    expect((await applyStaffPinRecords(edgeContext, [recordA])).applied).toBe(
      0,
    );
    expect((await tokenState(replayToken)).revoked).toBe(false);

    // Update branch: a later generation with a new hash.
    expect((await applyStaffPinRecords(edgeContext, [recordB])).applied).toBe(
      1,
    );
    expect(await tokenState(replayToken)).toEqual({
      revoked: true,
      reason: "pin_reset",
    });
    expect((await tokenState(otherToken)).revoked).toBe(false);
  });
});
