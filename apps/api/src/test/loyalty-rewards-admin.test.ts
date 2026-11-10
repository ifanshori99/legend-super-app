// legend-m4p5 slice SR: staff reward and mission administration over HTTP
// (docs/briefs/sub-290c-slices.md "Slice SR"; contract shapes in
// packages/shared/src/crm/endpoints.ts). Routes under test:
//   GET/POST /api/loyalty/rewards, PATCH /api/loyalty/rewards/:rewardId,
//   GET/POST /api/loyalty/missions, PATCH /api/loyalty/missions/:missionId
// all behind `crm.loyalty.manage`.
//
// Assumptions where the brief is silent:
// - A create answers 200 or 201 with `{ data: <row> }`; a patch answers 200.
// - An invalid reward body answers 400 (task statement). The error code is not
//   pinned.
// - The audit row sits in `audit_logs` with `event->>'objectId'` = the new row id
//   (same shape other suites read); the action name is not pinned.
// - The cashier template has no `crm.loyalty.manage` (it only has
//   `crm.loyalty.fulfil`), so it must get 403.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../app";
import { originHeader } from "./helpers";
import {
  seededTenantId,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers";
import { asTenant, memberHeaders, owner } from "./member-loyalty-helpers.ts";
import {
  cleanupSeededRewards,
  seedMenuItem,
  trackReward,
} from "./member-rewards-helpers.ts";

let app: Express;
let boss: Staff;
let cashier: Staff;
let menuItemId: string;

const headers = { ...memberHeaders, ...originHeader };

beforeAll(async () => {
  app = createApp();
  boss = await staffWithRole(app, {
    template: "owner",
    label: "Pemilik Hadiah",
  });
  cashier = await staffWithRole(app, {
    template: "cashier",
    label: "Kasir Hadiah",
  });
  menuItemId = await seedMenuItem(seededTenantId);
});

afterAll(async () => {
  // Rewards and missions made over HTTP carry created_by of this file's two
  // staff users; the shared fixture tenant is used by other files in parallel.
  const staffIds = [boss.userId, cashier.userId];
  const { rows } = await asTenant(seededTenantId, (client) =>
    client.query<{ id: string }>(
      "SELECT id FROM rewards WHERE tenant_id = $1 AND created_by = ANY($2::text[])",
      [seededTenantId, staffIds],
    ),
  );
  for (const row of rows) trackReward(seededTenantId, row.id);
  await asTenant(seededTenantId, (client) =>
    client.query(
      "DELETE FROM missions WHERE tenant_id = $1 AND created_by = ANY($2::text[])",
      [seededTenantId, staffIds],
    ),
  );
  await cleanupSeededRewards();
  await owner.end();
});

const uniqueName = (prefix: string) =>
  `${prefix} ${Math.random().toString(36).slice(2, 8)}`;

function voucherReward(overrides: Record<string, unknown> = {}) {
  return {
    name: uniqueName("Voucher"),
    description: "Potongan untuk member",
    type: "voucher",
    pointsCost: 100,
    stock: 10,
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: null,
    menuItemId: null,
    voucherValueIdr: 15000,
    isActive: true,
    sortOrder: 1,
    perCustomerLimit: 2,
    redemptionValidDays: 30,
    ...overrides,
  };
}

function itemReward(overrides: Record<string, unknown> = {}) {
  return voucherReward({
    name: uniqueName("Kopi"),
    type: "free_item",
    menuItemId,
    voucherValueIdr: null,
    ...overrides,
  });
}

function stampMission(overrides: Record<string, unknown> = {}) {
  return {
    name: uniqueName("Misi"),
    description: "Kumpulkan stempel",
    type: "stamp_card",
    rule: { kind: "stamp_card", stampsRequired: 5 },
    reward: { kind: "points", points: 50 },
    period: { kind: "monthly" },
    isActive: true,
    startsAt: null,
    endsAt: null,
    ...overrides,
  };
}

/** Walks the cursor pages until the row with `id` shows up. */
async function findInList(
  path: string,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  let cursor: string | null = null;
  for (let pageNo = 0; pageNo < 50; pageNo += 1) {
    const query: string =
      `limit=100` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const response = await boss.client.get(`${path}?${query}`).set(headers);
    expect(response.status).toBe(200);
    const rows = response.body.data as Record<string, unknown>[];
    const hit = rows.find((row) => row.id === id);
    if (hit) return hit;
    cursor = response.body.meta?.nextCursor ?? null;
    if (!cursor) return undefined;
  }
  return undefined;
}

async function auditRowsFor(objectId: string) {
  return asTenant(seededTenantId, async (client) => {
    const { rows } = await client.query<{ action: string }>(
      `SELECT event->>'action' AS action FROM audit_logs
       WHERE tenant_id = $1 AND event->>'objectId' = $2`,
      [seededTenantId, objectId],
    );
    return rows;
  });
}

describe("LOY-03 reward administration over HTTP", () => {
  it("LOY-03 the owner creates a voucher reward and an item reward, lists them and patches one", async () => {
    const voucher = voucherReward();
    const createdVoucher = await boss.client
      .post("/api/loyalty/rewards")
      .set(headers)
      .send(voucher);
    expect([200, 201]).toContain(createdVoucher.status);
    expect(createdVoucher.body.data).toMatchObject({
      name: voucher.name,
      type: "voucher",
      pointsCost: 100,
      menuItemId: null,
      voucherValueIdr: 15000,
      perCustomerLimit: 2,
      redemptionValidDays: 30,
      isActive: true,
    });
    const voucherId = createdVoucher.body.data.id as string;
    expect(voucherId).toEqual(expect.any(String));

    const item = itemReward();
    const createdItem = await boss.client
      .post("/api/loyalty/rewards")
      .set(headers)
      .send(item);
    expect([200, 201]).toContain(createdItem.status);
    expect(createdItem.body.data).toMatchObject({
      type: "free_item",
      menuItemId,
      voucherValueIdr: null,
    });
    const itemId = createdItem.body.data.id as string;

    expect(await findInList("/api/loyalty/rewards", voucherId)).toMatchObject({
      name: voucher.name,
      type: "voucher",
    });
    expect(await findInList("/api/loyalty/rewards", itemId)).toMatchObject({
      name: item.name,
      menuItemId,
    });

    const patched = await boss.client
      .patch(`/api/loyalty/rewards/${voucherId}`)
      .set(headers)
      .send({ name: "Voucher Baru", pointsCost: 250, isActive: false });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({
      id: voucherId,
      name: "Voucher Baru",
      pointsCost: 250,
      isActive: false,
      // Untouched fields stay as created.
      type: "voucher",
      voucherValueIdr: 15000,
    });
    expect(await findInList("/api/loyalty/rewards", voucherId)).toMatchObject({
      name: "Voucher Baru",
      isActive: false,
    });

    const onlyActive = await boss.client
      .get("/api/loyalty/rewards?active=true&limit=100")
      .set(headers);
    expect(onlyActive.status).toBe(200);
    const activeRows = onlyActive.body.data as { id: string }[];
    expect(activeRows.map((row) => row.id)).not.toContain(voucherId);
  });

  it("LOY-03 creating and patching a reward writes an audit row", async () => {
    const created = await boss.client
      .post("/api/loyalty/rewards")
      .set(headers)
      .send(voucherReward());
    expect([200, 201]).toContain(created.status);
    const id = created.body.data.id as string;
    const afterCreate = await auditRowsFor(id);
    expect(afterCreate.length).toBeGreaterThanOrEqual(1);

    const patched = await boss.client
      .patch(`/api/loyalty/rewards/${id}`)
      .set(headers)
      .send({ sortOrder: 9 });
    expect(patched.status).toBe(200);
    expect((await auditRowsFor(id)).length).toBeGreaterThan(afterCreate.length);
  });

  it("LOY-03 a voucher reward that names a menu item answers 400 and creates nothing", async () => {
    const bad = voucherReward({ menuItemId });
    const response = await boss.client
      .post("/api/loyalty/rewards")
      .set(headers)
      .send(bad);
    expect(response.status).toBe(400);
    expect(response.body.error).toBeDefined();
    const list = await boss.client
      .get("/api/loyalty/rewards?limit=100")
      .set(headers);
    expect(JSON.stringify(list.body)).not.toContain(bad.name);
  });

  it("LOY-03 an item reward without a menu item and a patch that breaks the type rules answer 400", async () => {
    const noItem = await boss.client
      .post("/api/loyalty/rewards")
      .set(headers)
      .send(itemReward({ menuItemId: null }));
    expect(noItem.status).toBe(400);

    const created = await boss.client
      .post("/api/loyalty/rewards")
      .set(headers)
      .send(voucherReward());
    const id = created.body.data.id as string;
    const patch = await boss.client
      .patch(`/api/loyalty/rewards/${id}`)
      .set(headers)
      .send({ menuItemId });
    expect(patch.status).toBe(400);
  });

  it("LOY-03 a role without crm.loyalty.manage gets 403 on reward routes and nothing is created", async () => {
    const created = await boss.client
      .post("/api/loyalty/rewards")
      .set(headers)
      .send(voucherReward());
    const id = created.body.data.id as string;

    const attempt = voucherReward();
    const post = await cashier.client
      .post("/api/loyalty/rewards")
      .set(headers)
      .send(attempt);
    expect(post.status).toBe(403);
    const get = await cashier.client.get("/api/loyalty/rewards").set(headers);
    expect(get.status).toBe(403);
    const patch = await cashier.client
      .patch(`/api/loyalty/rewards/${id}`)
      .set(headers)
      .send({ name: "Dibajak" });
    expect(patch.status).toBe(403);

    expect(await findInList("/api/loyalty/rewards", id)).toMatchObject({
      name: created.body.data.name,
    });
  });
});

describe("LOY-03 mission administration over HTTP", () => {
  it("LOY-03 the owner creates a mission, lists it and patches it", async () => {
    const mission = stampMission();
    const created = await boss.client
      .post("/api/loyalty/missions")
      .set(headers)
      .send(mission);
    expect([200, 201]).toContain(created.status);
    expect(created.body.data).toMatchObject({
      name: mission.name,
      type: "stamp_card",
      rule: { kind: "stamp_card", stampsRequired: 5 },
      reward: { kind: "points", points: 50 },
      period: { kind: "monthly" },
      isActive: true,
    });
    const id = created.body.data.id as string;

    expect(await findInList("/api/loyalty/missions", id)).toMatchObject({
      name: mission.name,
      type: "stamp_card",
    });

    const patched = await boss.client
      .patch(`/api/loyalty/missions/${id}`)
      .set(headers)
      .send({
        name: "Misi Baru",
        isActive: false,
        rule: { kind: "stamp_card", stampsRequired: 8 },
      });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({
      id,
      name: "Misi Baru",
      isActive: false,
      rule: { kind: "stamp_card", stampsRequired: 8 },
      reward: { kind: "points", points: 50 },
    });
    expect(await findInList("/api/loyalty/missions", id)).toMatchObject({
      name: "Misi Baru",
      isActive: false,
    });

    const onlyActive = await boss.client
      .get("/api/loyalty/missions?active=true&limit=100")
      .set(headers);
    expect(onlyActive.status).toBe(200);
    expect(
      (onlyActive.body.data as { id: string }[]).map((r) => r.id),
    ).not.toContain(id);
  });

  it("LOY-03 creating and patching a mission writes an audit row", async () => {
    const created = await boss.client
      .post("/api/loyalty/missions")
      .set(headers)
      .send(
        stampMission({
          type: "visit_count",
          rule: { kind: "visit_count", targetVisits: 3 },
          reward: { kind: "voucher", valueIdr: 10000, validDays: 14 },
        }),
      );
    expect([200, 201]).toContain(created.status);
    const id = created.body.data.id as string;
    const afterCreate = await auditRowsFor(id);
    expect(afterCreate.length).toBeGreaterThanOrEqual(1);

    const patched = await boss.client
      .patch(`/api/loyalty/missions/${id}`)
      .set(headers)
      .send({ isActive: false });
    expect(patched.status).toBe(200);
    expect((await auditRowsFor(id)).length).toBeGreaterThan(afterCreate.length);
  });

  // Assumption: the brief names no status for invalid input; the shared error
  // mapper answers 400 or 422, so both count (as in member-rewards.test.ts).
  it("LOY-03 a mission whose rule kind does not match its type is rejected and creates nothing", async () => {
    const bad = stampMission({
      type: "visit_count",
      rule: { kind: "stamp_card", stampsRequired: 5 },
    });
    const response = await boss.client
      .post("/api/loyalty/missions")
      .set(headers)
      .send(bad);
    expect([400, 422]).toContain(response.status);
    const list = await boss.client
      .get("/api/loyalty/missions?limit=100")
      .set(headers);
    expect(JSON.stringify(list.body)).not.toContain(bad.name);
  });

  it("LOY-03 a role without crm.loyalty.manage gets 403 on mission routes", async () => {
    const created = await boss.client
      .post("/api/loyalty/missions")
      .set(headers)
      .send(stampMission());
    // Independent of the create above: authorization runs before lookup, so any
    // well-formed id must answer 403 for the cashier.
    const id = (created.body.data?.id as string | undefined) ?? randomUUID();

    const post = await cashier.client
      .post("/api/loyalty/missions")
      .set(headers)
      .send(stampMission());
    expect(post.status).toBe(403);
    const get = await cashier.client.get("/api/loyalty/missions").set(headers);
    expect(get.status).toBe(403);
    const patch = await cashier.client
      .patch(`/api/loyalty/missions/${id}`)
      .set(headers)
      .send({ name: "Dibajak" });
    expect(patch.status).toBe(403);
  });
});
