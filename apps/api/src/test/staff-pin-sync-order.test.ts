// Commit-ordered cloud -> edge staff pin export and generation-key ordering on
// the edge (bead legend-t9ii, tier K; follow-up of legend-wg5t item 5 and
// legend-kyie). The old export paged by (updated_at, id) behind a settle window
// and the old edge apply compared the cloud `updatedAt` with its own local
// created_at / updated_at, so one slow edge clock could let an older cloud row
// replace a newer edge-set pin. These tests run the real services on the
// disposable PostgreSQL; the "edge" database is the same database, so a test
// plays the edge by deleting the cloud row first.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import type { StaffPinEdgeRecord } from "@starter/shared/access/override";
import {
  encodeCursor,
  outletIdSchema,
  type ScopedTenantContext,
  type TenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { applyStaffPinSet } from "../edge/access-applier.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import {
  attemptStaffPin,
  setStaffPin,
} from "../services/device-pin.service.ts";
import {
  registerEdgeNode,
  authenticateEdgeCredential,
} from "../services/edge-node.service.ts";
import {
  applyStaffPinRecords,
  listStaffPinRecordsSince,
  type VerifiedEdgeNode,
} from "../services/staff-pin-sync.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const bandung = cafeLegendAccessFixtures.outletIds.bandung;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 6,
});
const createdUserIds: string[] = [];
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
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Staf urutan', $2)`,
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

const setPin = (userId: string, pin: string, now?: Date) =>
  setStaffPin(
    tenant,
    userId,
    { outletId: bandung, userId },
    { pin },
    now ? { now } : {},
  );

/** One export pass to the end; the watermark is the last cursor seen. */
async function pull(since?: string) {
  const records: StaffPinEdgeRecord[] = [];
  let cursor = since;
  let watermark: string | undefined = since;
  for (let page = 0; page < 1000; page++) {
    const result = await listStaffPinRecordsSince(node, {
      since: cursor,
      limit: 100,
    });
    records.push(...result.data);
    watermark = result.meta.watermark ?? undefined;
    if (result.meta.nextCursor === null) break;
    cursor = result.meta.nextCursor;
  }
  return { records, watermark };
}

/**
 * Pulls until every wanted staff member was exported. A transaction of another
 * test file that is open at this moment holds the commit watermark back for a
 * moment, so a positive assertion polls instead of reading once.
 */
async function pullUntil(userIds: string[], since?: string) {
  let last = await pull(since);
  for (let attempt = 0; attempt < 50; attempt++) {
    if (userIds.every((id) => last.records.some((row) => row.userId === id)))
      return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
    last = await pull(since);
  }
  return last;
}

async function pinRow(userId: string) {
  const { rows } = await owner.query<{
    id: string;
    pin_hash: string;
    pin_salt: string;
    failed_attempts: number;
    pin_generation_at: Date;
    pin_set_at: Date;
    generation_text: string;
  }>(
    `SELECT *, to_char(pin_generation_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS generation_text
       FROM staff_pins WHERE tenant_id = $1 AND outlet_id = $2 AND user_id = $3`,
    [tenantId, bandung, userId],
  );
  return rows[0]!;
}

async function edgeEventOf(userId: string): Promise<EventEnvelope> {
  const { rows } = await owner.query<{ event: EventEnvelope }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_type = 'staff_pin' AND event->>'name' = 'staff_pin.set'
        AND event->'payload'->>'userId' = $2
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId, userId],
  );
  return rows[0]!.event;
}

async function asEdge<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.EDGE_MODE;
  process.env.EDGE_MODE = "true";
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.EDGE_MODE;
    else process.env.EDGE_MODE = previous;
  }
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

afterEach(() => {
  delete process.env.EDGE_MODE;
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.query(
    `DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_type = 'staff_pin' AND event->'payload'->>'userId' = ANY($2::text[])`,
    [tenantId, createdUserIds],
  );
  await owner.query(
    `DELETE FROM staff_pins WHERE tenant_id = $1 AND user_id = ANY($2::text[])`,
    [tenantId, createdUserIds],
  );
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantId, createdUserIds],
  );
  // edge_nodes rows are revoked, never deleted (trigger): the disposable
  // database drops the standby node registered by the adoption test.
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
    createdUserIds,
  ]);
  await owner.end();
});

describe("legend-t9ii edge orders pin generations by the cloud key, never a node clock", () => {
  it("an edge clock 10 minutes behind keeps its newer pin against a later cloud attempt bump, and the cloud adopts the edge pin", async () => {
    const userId = await newStaff();
    const now = Date.now();
    // Cloud pin A, set 20 minutes ago.
    await setPin(userId, PIN_A, new Date(now - 20 * MINUTE));
    const first = await pullUntil([userId]);
    const recordA = first.records.find((row) => row.userId === userId)!;

    // A wrong attempt on the cloud moves updated_at (not the pin generation);
    // the next export carries the bump.
    const attempt = await attemptStaffPin(tenant, {
      outletId: bandung,
      userId,
      pin: "111111",
    });
    expect(attempt.kind).not.toBe("ok");
    const second = await pullUntil([userId], first.watermark);
    const bump = second.records.find((row) => row.userId === userId)!;
    expect(bump.failedAttempts).toBe(1);
    expect(bump.pinGenerationAt).toBe(recordA.pinGenerationAt);

    // The edge copy: cloud row gone, record A applied.
    await deletePin(userId);
    await applyStaffPinRecords(edgeContext, [recordA]);
    // The edge clock runs 10 minutes behind and sets pin B (still after A's
    // key, which is 20 minutes old).
    await asEdge(() => setPin(userId, PIN_B, new Date(now - 10 * MINUTE)));
    const edgeSet = await pinRow(userId);
    const event = await edgeEventOf(userId);
    const material = (event.payload as { material: { setAt: string; pinHash: string } })
      .material;

    // The older cloud row (the attempt bump on pin A) arrives afterwards.
    await applyStaffPinRecords(edgeContext, [bump]);
    const after = await pinRow(userId);
    expect(after.pin_hash).toBe(edgeSet.pin_hash);
    expect(after.pin_hash).toBe(material.pinHash);

    // B's key is after the cloud generation of A, so the cloud adopts it.
    expect(Date.parse(material.setAt)).toBeGreaterThan(
      Date.parse(recordA.pinGenerationAt),
    );
    await owner.query(
      `UPDATE staff_pins SET pin_hash = $2, pin_salt = $3, pin_generation_at = $4::timestamptz WHERE id = $1`,
      [edgeSet.id, recordA.pinHash, recordA.salt, recordA.pinGenerationAt],
    );
    const registered = await registerEdgeNode(
      establishScopedTenantContext(tenant, {
        kind: "outlets",
        outletIds: [outletIdSchema.parse(bandung)],
      }),
      userId,
      { outletId: bandung, role: "standby", label: "uji urutan" },
    );
    const authenticated = await authenticateEdgeCredential(
      registered.credential,
    );
    const outcome = await withTenant(db, authenticated!.context, (tx) =>
      applyStaffPinSet(tx, event, {
        edgeNodeId: authenticated!.scope.edgeNodeId,
        direction: "edge_to_cloud",
        kind: "transaction_event",
        context: authenticated!.context,
      }),
    );
    expect(outcome).toBe("applied");
    expect((await pinRow(userId)).pin_hash).toBe(material.pinHash);
  });

  it("applying a record stores the cloud key as the edge generation key, and a key tie lets the cloud win", async () => {
    const userId = await newStaff();
    await setPin(userId, PIN_A, new Date(Date.now() - 30 * MINUTE));
    const { records } = await pullUntil([userId]);
    const recordA = records.find((row) => row.userId === userId)!;
    await setPin(userId, PIN_B, new Date(Date.now() - 20 * MINUTE));
    const recordB = (
      await pullUntil([userId], undefined)
    ).records.find((row) => row.userId === userId)!;
    expect(recordB.pinHash).not.toBe(recordA.pinHash);

    await deletePin(userId);
    expect((await applyStaffPinRecords(edgeContext, [recordA])).applied).toBe(1);
    const inserted = await pinRow(userId);
    expect(inserted.generation_text).toBe(recordA.pinGenerationAt);
    expect(inserted.pin_set_at.toISOString()).toBe(
      new Date(recordA.pinGenerationAt).toISOString(),
    );

    // Newer key replaces, an older key replayed afterwards does not.
    expect((await applyStaffPinRecords(edgeContext, [recordB])).applied).toBe(1);
    expect((await pinRow(userId)).pin_hash).toBe(recordB.pinHash);
    expect((await applyStaffPinRecords(edgeContext, [recordA])).applied).toBe(0);
    expect((await pinRow(userId)).pin_hash).toBe(recordB.pinHash);

    // Tie, other material: the cloud wins (same rule as the cloud's own set).
    const tie = { ...recordA, pinGenerationAt: recordB.pinGenerationAt };
    expect((await applyStaffPinRecords(edgeContext, [tie])).applied).toBe(1);
    expect((await pinRow(userId)).pin_hash).toBe(recordA.pinHash);
  });

  it("same material merges lock state without comparing clocks and skips a write that changes nothing", async () => {
    const userId = await newStaff();
    await setPin(userId, PIN_A, new Date(Date.now() - 10 * MINUTE));
    const { records } = await pullUntil([userId]);
    const record = records.find((row) => row.userId === userId)!;
    await deletePin(userId);
    await applyStaffPinRecords(edgeContext, [record]);

    // An older updatedAt but a higher counter still merges (no clock compare).
    const higher: StaffPinEdgeRecord = {
      ...record,
      failedAttempts: 3,
      updatedAt: new Date(Date.parse(record.updatedAt) - 60 * MINUTE).toISOString(),
    };
    expect((await applyStaffPinRecords(edgeContext, [higher])).applied).toBe(1);
    expect((await pinRow(userId)).failed_attempts).toBe(3);

    // A lower counter never weakens the edge and writes nothing.
    expect((await applyStaffPinRecords(edgeContext, [record])).applied).toBe(0);
    expect((await pinRow(userId)).failed_attempts).toBe(3);

    // The same material with a later key moves the key forward only.
    const later = new Date(Date.parse(record.pinGenerationAt) + MINUTE);
    expect(
      (
        await applyStaffPinRecords(edgeContext, [
          { ...record, pinGenerationAt: later.toISOString() },
        ])
      ).applied,
    ).toBe(1);
    const row = await pinRow(userId);
    expect(row.failed_attempts).toBe(3);
    expect(row.pin_generation_at.getTime()).toBe(later.getTime());
  });
});

describe("legend-t9ii commit-ordered export", () => {
  it("the record carries the exact microsecond text of pin_generation_at", async () => {
    const userId = await newStaff();
    await setPin(userId, PIN_A, new Date(Date.now() - 5 * MINUTE));
    await owner.query(
      `UPDATE staff_pins SET pin_generation_at = '2026-03-04 05:06:07.123456+00' WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId],
    );
    const { records } = await pullUntil([userId]);
    const record = records.find((row) => row.userId === userId)!;
    expect(record.pinGenerationAt).toBe("2026-03-04T05:06:07.123456Z");
    expect(Object.keys(record)).toContain("pinGenerationAt");
  });

  it("a writer that commits late is not skipped by a watermark that already passed a newer commit", async () => {
    const early = await newStaff();
    const late = await newStaff();
    const newer = await newStaff();
    for (const id of [early, late, newer]) await setPin(id, PIN_A);
    const base = await pullUntil([early, late, newer]);

    const slow = await owner.connect();
    try {
      // Writer A takes its transaction id first and stays open.
      await slow.query("BEGIN");
      await slow.query(
        "UPDATE staff_pins SET failed_attempts = 1 WHERE tenant_id = $1 AND user_id = $2",
        [tenantId, late],
      );
      // Writer B starts later and commits first.
      await owner.query(
        "UPDATE staff_pins SET failed_attempts = 2 WHERE tenant_id = $1 AND user_id = $2",
        [tenantId, newer],
      );

      // The export never moves past a transaction that is still open.
      const held = await pull(base.watermark);
      expect(held.records.map((row) => row.userId)).not.toContain(late);
      expect(held.records.map((row) => row.userId)).not.toContain(newer);

      await slow.query("COMMIT");
    } finally {
      slow.release();
    }
    const released = await pullUntil([late, newer], base.watermark);
    const byUser = new Map<string, StaffPinEdgeRecord>(
      released.records.map((row) => [row.userId, row]),
    );
    expect(byUser.get(late)?.failedAttempts).toBe(1);
    expect(byUser.get(newer)?.failedAttempts).toBe(2);
  });

  it("an old spin1 cursor restarts from the beginning, and a tampered spin2 cursor is a validation error", async () => {
    const userId = await newStaff();
    await setPin(userId, PIN_A);
    await pullUntil([userId]);
    const spin1 = encodeCursor([
      "spin1",
      "2999-01-01T00:00:00.000000Z",
      randomUUID(),
    ]);
    const restarted = await pullUntil([userId], spin1);
    expect(restarted.records.some((row) => row.userId === userId)).toBe(true);

    for (const keys of [
      ["spin2", "not-a-number", randomUUID()],
      ["spin2", "12", "not-a-uuid"],
      ["spin2", "12"],
      ["other", "12", randomUUID()],
    ])
      await expect(
        listStaffPinRecordsSince(node, {
          since: encodeCursor(keys),
          limit: 10,
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
