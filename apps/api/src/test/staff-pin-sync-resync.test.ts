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
import {
  staffPinEdgeRecordSchema,
  type StaffPinEdgeRecord,
} from "@starter/shared/access/override";
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

/** Polls the export for a staff pin (a test file that is open holds the horizon back). */
async function exportedRecord(userId: string): Promise<StaffPinEdgeRecord> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const page = await listStaffPinRecordsSince(node, { limit: 100 });
    const found = page.data.find((row) => row.userId === userId);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("staff pin was not exported");
}

/**
 * The cloud record of a fresh pin; the cloud row is then removed (edge copy).
 * Without `withRevision` the record is the one of a cloud before legend-r11j7
 * (no `attemptRevision`: the edge compares the counter by value, the
 * legend-7vv8h tests below); with it the record carries the cloud revision.
 */
async function cloudRecord(
  userId: string,
  withRevision = false,
): Promise<StaffPinEdgeRecord> {
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
    const page = await listStaffPinRecordsSince(node, {
      limit: 100,
      revision: withRevision ? "1" : undefined,
    });
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
    attempt_revision: string;
    cloud_attempt_revision: string | null;
  }>(
    `SELECT failed_attempts, locked_until, cloud_failed_attempts, cloud_locked_until,
            attempt_revision, cloud_attempt_revision
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

  it("a cloud lock that differs from the stored baseline applies even when it is earlier than the baseline, and its replay changes nothing", async () => {
    const userId = await newStaff();
    const record = await cloudRecord(userId);
    await applyStaffPinRecords(edgeContext, [record]);

    const first = new Date(Date.now() + 30 * MINUTE);
    await applyStaffPinRecords(edgeContext, [
      { ...record, failedAttempts: 3, lockedUntil: first.toISOString() },
    ]);
    expect((await pinRow(userId)).cloud_locked_until?.getTime()).toBe(
      first.getTime(),
    );
    await clearOnEdge(userId);

    // The cloud lock was cleared and a newer, shorter one set between two
    // pulls: it is earlier than the baseline but still in the future.
    const second = new Date(Date.now() + 10 * MINUTE);
    const shorter = {
      ...record,
      failedAttempts: 3,
      lockedUntil: second.toISOString(),
    };
    await applyStaffPinRecords(edgeContext, [shorter]);
    const applied = await pinRow(userId);
    expect(applied.locked_until?.getTime()).toBe(second.getTime());
    expect(applied.cloud_locked_until?.getTime()).toBe(second.getTime());

    await applyStaffPinRecords(edgeContext, [shorter]);
    const replayed = await pinRow(userId);
    expect(replayed.failed_attempts).toBe(applied.failed_attempts);
    expect(replayed.locked_until?.getTime()).toBe(second.getTime());
    expect(replayed.cloud_locked_until?.getTime()).toBe(second.getTime());
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

  it("a cloud counter that went down (correct PIN on the cloud) and rose again is not dropped as a replay", async () => {
    const userId = await newStaff();
    const record = await cloudRecord(userId);
    await applyStaffPinRecords(edgeContext, [record]);
    await applyStaffPinRecords(edgeContext, [{ ...record, failedAttempts: 3 }]);
    expect((await pinRow(userId)).cloud_failed_attempts).toBe(3);
    await clearOnEdge(userId);

    // The cloud counter went 3 -> 0 (correct PIN there) -> 2 (two new
    // failures) between two pulls: the edge never saw the 0. 2 is below the
    // stored baseline (3) but differs from it and is above the local counter.
    await applyStaffPinRecords(edgeContext, [{ ...record, failedAttempts: 2 }]);
    const row = await pinRow(userId);
    expect(row.failed_attempts).toBe(2);
    expect(row.cloud_failed_attempts).toBe(2);
  });

  it("a cloud counter that went down (correct PIN on the cloud) and rose again is not dropped as a replay after the edge saw the cloud reset to 0", async () => {
    const userId = await newStaff();
    const record = await cloudRecord(userId);
    await applyStaffPinRecords(edgeContext, [record]);
    await applyStaffPinRecords(edgeContext, [{ ...record, failedAttempts: 3 }]);
    expect((await pinRow(userId)).cloud_failed_attempts).toBe(3);
    await clearOnEdge(userId);

    // The cloud counter is cleared by a correct PIN there: baseline 3 -> 0.
    await applyStaffPinRecords(edgeContext, [{ ...record, failedAttempts: 0 }]);
    expect((await pinRow(userId)).cloud_failed_attempts).toBe(0);

    // Two new cloud failures: 2 is below the old baseline (3) but differs from
    // the current one (0) and is above the local counter.
    await applyStaffPinRecords(edgeContext, [{ ...record, failedAttempts: 2 }]);
    const row = await pinRow(userId);
    expect(row.failed_attempts).toBe(2);
    expect(row.cloud_failed_attempts).toBe(2);
  });

  it("a new pin set on the edge starts without a cloud baseline, so a same-material record with the old baseline value applies", async () => {
    const userId = await newStaff();
    const record = await cloudRecord(userId);
    await applyStaffPinRecords(edgeContext, [record]);
    await applyStaffPinRecords(edgeContext, [{ ...record, failedAttempts: 4 }]);
    expect((await pinRow(userId)).cloud_failed_attempts).toBe(4);

    await setStaffPin(
      tenant,
      userId,
      { outletId: bandung, userId },
      { pin: "193746" },
      { now: new Date(Date.now() - 5 * MINUTE) },
    );
    const afterSet = await pinRow(userId);
    expect(afterSet.failed_attempts).toBe(0);
    expect(afterSet.cloud_failed_attempts).toBeNull();

    // The cloud record of the new pin carries counter 4 (same material as the
    // edge row): it must raise the local counter again.
    const fresh = await exportedRecord(userId);
    await applyStaffPinRecords(edgeContext, [{ ...fresh, failedAttempts: 4 }]);
    const row = await pinRow(userId);
    expect(row.failed_attempts).toBe(4);
    expect(row.cloud_failed_attempts).toBe(4);
  });
});

describe("legend-r11j7 counter ABA between two pulls", () => {
  it("without attemptRevision, a cloud counter 3 -> 0 -> 3 is indistinguishable from a replay and stays cleared (value fallback)", async () => {
    const userId = await newStaff();
    const record = await cloudRecord(userId);
    expect(record.attemptRevision).toBeUndefined();
    expect(staffPinEdgeRecordSchema.safeParse(record).success).toBe(true);
    await applyStaffPinRecords(edgeContext, [record]);
    const three = { ...record, failedAttempts: 3 };
    await applyStaffPinRecords(edgeContext, [three]);
    expect((await pinRow(userId)).failed_attempts).toBe(3);
    await clearOnEdge(userId);

    // The cloud went 3 -> 0 -> 3 between two pulls: the same record arrives.
    await applyStaffPinRecords(edgeContext, [three]);
    expect((await pinRow(userId)).failed_attempts).toBe(0);
  });

  it("with attemptRevision, a cloud counter 3 -> 0 -> 3 between two pulls raises the cleared edge counter again, and a replay of it does not", async () => {
    const userId = await newStaff();
    const record = await cloudRecord(userId, true);
    const r = record.attemptRevision!;
    expect(typeof r).toBe("number");
    await applyStaffPinRecords(edgeContext, [record]);
    expect((await pinRow(userId)).cloud_attempt_revision).toBe(String(r));

    // Cloud counter 0 -> 3 (three bumps).
    const three = { ...record, failedAttempts: 3, attemptRevision: r + 3 };
    await applyStaffPinRecords(edgeContext, [three]);
    expect((await pinRow(userId)).failed_attempts).toBe(3);
    await clearOnEdge(userId);

    // Same record again (cloud restart resync): still a replay.
    await applyStaffPinRecords(edgeContext, [three]);
    expect((await pinRow(userId)).failed_attempts).toBe(0);

    // Cloud: 3 -> 0 (correct PIN) -> 3 (three new failures) = 4 bumps. Same
    // value, new revision: the edge never saw the 0, it raises again.
    const aba = { ...three, attemptRevision: r + 7 };
    await applyStaffPinRecords(edgeContext, [aba]);
    const row = await pinRow(userId);
    expect(row.failed_attempts).toBe(3);
    expect(row.cloud_attempt_revision).toBe(String(r + 7));
    expect(row.cloud_failed_attempts).toBe(3);
  });

  it("the first pull after the upgrade (null revision baseline) falls back to the value and stores the revision", async () => {
    const userId = await newStaff();
    const record = await cloudRecord(userId, true);
    const r = record.attemptRevision!;
    await applyStaffPinRecords(edgeContext, [record]);
    await applyStaffPinRecords(edgeContext, [
      { ...record, failedAttempts: 3, attemptRevision: r + 3 },
    ]);
    await clearOnEdge(userId);
    await owner.query(
      `UPDATE staff_pins SET cloud_attempt_revision = NULL
        WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId],
    );

    // Value 3 equals the stored baseline value: replay, nothing restored, but
    // the revision is stored now.
    await applyStaffPinRecords(edgeContext, [
      { ...record, failedAttempts: 3, attemptRevision: r + 3 },
    ]);
    const row = await pinRow(userId);
    expect(row.failed_attempts).toBe(0);
    expect(row.cloud_attempt_revision).toBe(String(r + 3));
  });

  it("a record without a revision resets the revision baseline to unknown, so the next pull compares by value (legend-r11j7)", async () => {
    const userId = await newStaff();
    const record = await cloudRecord(userId, true);
    const r = record.attemptRevision!;
    await applyStaffPinRecords(edgeContext, [record]);
    expect((await pinRow(userId)).cloud_attempt_revision).toBe(String(r));

    // An old cloud (no flag support) sends no revision: the stored revision
    // would be stale after this merge, so the baseline becomes unknown.
    const legacy: StaffPinEdgeRecord = { ...record };
    delete legacy.attemptRevision;
    await applyStaffPinRecords(edgeContext, [{ ...legacy, failedAttempts: 3 }]);
    const merged = await pinRow(userId);
    expect(merged.failed_attempts).toBe(3);
    expect(merged.cloud_attempt_revision).toBeNull();
    await clearOnEdge(userId);

    // The cloud is upgraded; its revision for the same value 3 is new. The
    // value equals the baseline value: a replay, nothing restored, and the
    // revision is stored now.
    await applyStaffPinRecords(edgeContext, [
      { ...record, failedAttempts: 3, attemptRevision: r + 3 },
    ]);
    const row = await pinRow(userId);
    expect(row.failed_attempts).toBe(0);
    expect(row.cloud_attempt_revision).toBe(String(r + 3));
  });

  it("a new local PIN clears the cloud revision baseline with the other cloud baselines (legend-r11j7)", async () => {
    const userId = await newStaff();
    const record = await cloudRecord(userId, true);
    await applyStaffPinRecords(edgeContext, [record]);
    expect((await pinRow(userId)).cloud_attempt_revision).not.toBeNull();
    await setStaffPin(
      tenant,
      userId,
      { outletId: bandung, userId },
      { pin: "730418" },
      { now: new Date(Date.now() - 5 * MINUTE) },
    );
    const row = await pinRow(userId);
    expect(row.cloud_failed_attempts).toBeNull();
    expect(row.cloud_attempt_revision).toBeNull();
  });

  it("the trigger bumps attempt_revision on a counter or hash change only (not a lock-only change), and a writer cannot set it", async () => {
    const userId = await newStaff();
    await setStaffPin(
      tenant,
      userId,
      { outletId: bandung, userId },
      { pin: "582914" },
      { now: new Date(Date.now() - 10 * MINUTE) },
    );
    const start = Number((await pinRow(userId)).attempt_revision);
    const update = (set: string) =>
      owner.query(
        `UPDATE staff_pins SET ${set} WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, userId],
      );

    await update("failed_attempts = 2");
    expect(Number((await pinRow(userId)).attempt_revision)).toBe(start + 1);
    // A lock-only change is merged by value on the edge: no bump (review K).
    await update("locked_until = now() + interval '5 minutes'");
    expect(Number((await pinRow(userId)).attempt_revision)).toBe(start + 1);
    await update("pin_salt = 'AAAAAAAAAAAAAAAAAAAAAA=='");
    expect(Number((await pinRow(userId)).attempt_revision)).toBe(start + 2);
    await update(`pin_hash = repeat('a', 64)`);
    expect(Number((await pinRow(userId)).attempt_revision)).toBe(start + 3);

    // updated_at only, or a write of the same values: no bump.
    await update("updated_at = now()");
    await update("failed_attempts = 2");
    expect(Number((await pinRow(userId)).attempt_revision)).toBe(start + 3);

    // A writer cannot set it, alone or together with a counter change.
    await update("attempt_revision = 999");
    expect(Number((await pinRow(userId)).attempt_revision)).toBe(start + 3);
    await update("attempt_revision = 999, failed_attempts = 1");
    expect(Number((await pinRow(userId)).attempt_revision)).toBe(start + 4);
  });
});
