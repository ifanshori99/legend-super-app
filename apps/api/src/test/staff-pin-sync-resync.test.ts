// Edge apply never restores a counter or lock the edge already cleared (bead
// legend-7vv8h, tier K). The cloud epoch changes on every database restart, so
// the edge then replays the full export; the same-material merge used to take
// GREATEST(counter) against the raw cloud values and brought back a counter
// that a correct PIN (or an AUTH-06 unlock) had cleared on the edge. The "edge"
// database is the same database, so a test plays the edge by deleting the
// cloud row first and clearing the counter with owner SQL.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import type { StaffPinEdgeRecord } from "@starter/shared/access/override";
import { outletIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { setAuditWriter } from "../services/audit-writer.ts";
import { setStaffPin } from "../services/device-pin.service.ts";
import {
  applyStaffPinRecords,
  listStaffPinRecordsSince,
  type VerifiedEdgeNode,
} from "../services/staff-pin-sync.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const bandung = cafeLegendAccessFixtures.outletIds.bandung;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const createdUserIds: string[] = [];
const MINUTE = 60_000;

const tenant = establishTenantContext({
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
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Staf resync', $2)`,
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

/** The cloud record of a fresh pin; the cloud row is then removed (edge copy). */
async function cloudRecord(userId: string): Promise<StaffPinEdgeRecord> {
  await setStaffPin(
    tenant,
    userId,
    { outletId: bandung, userId },
    { pin: "582914" },
    { now: new Date(Date.now() - 10 * MINUTE) },
  );
  // A transaction of another test file that is open holds the export horizon
  // back for a moment, so poll instead of reading once.
  for (let attempt = 0; attempt < 50; attempt++) {
    const page = await listStaffPinRecordsSince(node, { limit: 100 });
    const found = page.data.find((row) => row.userId === userId);
    if (found) {
      await owner.query(
        "DELETE FROM staff_pins WHERE tenant_id = $1 AND user_id = $2",
        [tenantId, userId],
      );
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("staff pin was not exported");
}

async function pinRow(userId: string) {
  const { rows } = await owner.query<{
    failed_attempts: number;
    locked_until: Date | null;
    cloud_failed_attempts: number | null;
    cloud_locked_until: Date | null;
  }>(
    `SELECT failed_attempts, locked_until, cloud_failed_attempts, cloud_locked_until
       FROM staff_pins WHERE tenant_id = $1 AND outlet_id = $2 AND user_id = $3`,
    [tenantId, bandung, userId],
  );
  return rows[0]!;
}

/** The edge accepting a correct PIN (or an unlock): counter and lock cleared. */
const clearOnEdge = (userId: string) =>
  owner.query(
    `UPDATE staff_pins SET failed_attempts = 0, locked_until = NULL
      WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId],
  );

beforeAll(() => {
  setAuditWriter({ record: async () => {} });
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.query(
    `DELETE FROM staff_pins WHERE tenant_id = $1 AND user_id = ANY($2::text[])`,
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

describe("legend-7vv8h edge apply never restores a cleared counter or lock", () => {
  it("a counter the edge cleared stays cleared when a full resync replays the same cloud record, and a new cloud failure raises it again", async () => {
    const userId = await newStaff();
    const record = await cloudRecord(userId);
    await applyStaffPinRecords(edgeContext, [record]);

    // Cloud counter 3 is merged, the edge then clears it (correct PIN).
    const three = { ...record, failedAttempts: 3 };
    expect((await applyStaffPinRecords(edgeContext, [three])).applied).toBe(1);
    expect((await pinRow(userId)).failed_attempts).toBe(3);
    await clearOnEdge(userId);

    // Full resync after a cloud restart: the same record arrives again.
    await applyStaffPinRecords(edgeContext, [three]);
    expect((await pinRow(userId)).failed_attempts).toBe(0);
    await applyStaffPinRecords(edgeContext, [three]);
    expect((await pinRow(userId)).failed_attempts).toBe(0);

    // A new cloud failure (4) is above the stored baseline: it raises again.
    const four = { ...record, failedAttempts: 4 };
    await applyStaffPinRecords(edgeContext, [four]);
    const row = await pinRow(userId);
    expect(row.failed_attempts).toBe(4);
    expect(row.cloud_failed_attempts).toBe(4);
  });

  it("a lock the edge cleared stays cleared on replay, and a later cloud lock applies", async () => {
    const userId = await newStaff();
    const record = await cloudRecord(userId);
    await applyStaffPinRecords(edgeContext, [record]);

    const lockedUntil = new Date(Date.now() + 30 * MINUTE);
    const locked = {
      ...record,
      failedAttempts: 3,
      lockedUntil: lockedUntil.toISOString(),
    };
    await applyStaffPinRecords(edgeContext, [locked]);
    const merged = await pinRow(userId);
    expect(merged.locked_until?.getTime()).toBe(lockedUntil.getTime());
    expect(merged.cloud_locked_until?.getTime()).toBe(lockedUntil.getTime());

    await clearOnEdge(userId);
    await applyStaffPinRecords(edgeContext, [locked]);
    const replayed = await pinRow(userId);
    expect(replayed.failed_attempts).toBe(0);
    expect(replayed.locked_until).toBeNull();

    const later = new Date(lockedUntil.getTime() + MINUTE);
    await applyStaffPinRecords(edgeContext, [
      { ...locked, failedAttempts: 5, lockedUntil: later.toISOString() },
    ]);
    const raised = await pinRow(userId);
    expect(raised.failed_attempts).toBe(5);
    expect(raised.locked_until?.getTime()).toBe(later.getTime());
  });

  it("an edge copy without a stored baseline (before this change) treats the record as new", async () => {
    const userId = await newStaff();
    const record = await cloudRecord(userId);
    await applyStaffPinRecords(edgeContext, [record]);
    await owner.query(
      `UPDATE staff_pins SET cloud_failed_attempts = NULL, cloud_locked_until = NULL
        WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId],
    );
    await applyStaffPinRecords(edgeContext, [{ ...record, failedAttempts: 2 }]);
    const row = await pinRow(userId);
    expect(row.failed_attempts).toBe(2);
    expect(row.cloud_failed_attempts).toBe(2);
  });
});
