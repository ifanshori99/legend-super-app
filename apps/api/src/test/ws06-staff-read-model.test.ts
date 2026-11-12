import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  stockCountQuerySchema,
  wasteLogQuerySchema,
} from "@starter/shared/inventory";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  getStockCountDetail,
  getStockCountSheet,
  listStockCounts,
} from "../services/inventory-count.service.ts";
import { listWasteLogs } from "../services/inventory-waste.service.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0]!.id;
const outletB = cafeLegendPlatformFixtures.outlets[1]!.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const viewerId = randomUUID();
const counterId = randomUUID();
const foreignId = randomUUID();
const roleId = randomUUID();
const locationId = randomUUID();
const countId = randomUUID();
const approvedCountId = randomUUID();
const wasteId = randomUUID();
const foreignWasteId = randomUUID();
const context = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "domain" }),
  { kind: "outlets", outletIds: [outletIdSchema.parse(outletA)] },
);

beforeAll(async () => {
  for (const [id, name] of [
    [viewerId, "WS06 Viewer"],
    [counterId, "Sari Opname"],
    [foreignId, "Private Other Outlet"],
  ])
    await owner.query(
      'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
      [id, name, `${id}@private.example`],
    );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, permissions, allowed_scope_types) VALUES ($1, $2, 'Petugas Stok WS06', $3, '["outlet"]')`,
    [
      roleId,
      tenantId,
      JSON.stringify(["inventory.stock.view", "inventory.opname.count"]),
    ],
  );
  for (const [id, outlet] of [
    [viewerId, outletA],
    [counterId, outletA],
    [foreignId, outletB],
  ])
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by) VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
      [tenantId, id, roleId, outlet],
    );
  await owner.query(
    `INSERT INTO stock_locations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, $4, 'warehouse')`,
    [locationId, tenantId, outletA, `WS06 Staff ${locationId}`],
  );
  await owner.query(
    `INSERT INTO stock_counts (id, tenant_id, outlet_id, location_id, type, status, blind, business_date, counted_by, create_idempotency_key, create_fingerprint) VALUES ($1, $2, $3, $4, 'full', 'draft', false, '2026-11-01', $5, $6, $7)`,
    [
      countId,
      tenantId,
      outletA,
      locationId,
      counterId,
      `staff-${countId}`,
      "a".repeat(64),
    ],
  );
  await owner.query(
    `INSERT INTO stock_counts (id, tenant_id, outlet_id, location_id, type, status, blind, business_date, counted_by, approved_by, counted_at, approved_at, posted_at, approval_chain_id, approval_version, count_version, lines_hash, create_idempotency_key, create_fingerprint) VALUES ($1, $2, $3, $4, 'full', 'posted', false, '2026-11-01', $5, $6, now(), now(), now(), $7, 1, 1, $8, $9, $8)`,
    [
      approvedCountId,
      tenantId,
      outletA,
      locationId,
      counterId,
      viewerId,
      randomUUID(),
      "b".repeat(64),
      `staff-${approvedCountId}`,
    ],
  );
  for (const [id, actor] of [
    [wasteId, counterId],
    [foreignWasteId, foreignId],
  ])
    await owner.query(
      `INSERT INTO waste_logs (id, tenant_id, outlet_id, location_id, target_type, target_id, quantity, reason, value_idr, logged_by, occurred_at) VALUES ($1, $2, $3, $4, 'inventory_item', $5, 1, 'expired', 1000, $6, now())`,
      [id, tenantId, outletA, locationId, randomUUID(), actor],
    );
});
afterAll(async () => {
  await owner.query("DELETE FROM waste_logs WHERE id = ANY($1::uuid[])", [
    [wasteId, foreignWasteId],
  ]);
  await owner.query("DELETE FROM stock_counts WHERE id = ANY($1::uuid[])", [
    [countId, approvedCountId],
  ]);
  await owner.query("DELETE FROM stock_locations WHERE id = $1", [locationId]);
  await owner.query("DELETE FROM role_assignments WHERE role_id = $1", [
    roleId,
  ]);
  await owner.query("DELETE FROM roles WHERE id = $1", [roleId]);
  await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
    [viewerId, counterId, foreignId],
  ]);
  await owner.end();
});
const staff = {
  userId: counterId,
  displayName: "Sari Opname",
  role: "Petugas Stok WS06",
};

describe("legend-mgy0 operational staff attribution", () => {
  it("shows only user id, display name and role on count list and detail", async () => {
    const page = await listStockCounts(
      context,
      viewerId,
      stockCountQuerySchema.parse({ outletId: outletA, locationId }),
    );
    const count = page.data.find((row) => row.id === countId)!;
    expect(Reflect.get(count, "countedByStaff")).toEqual(staff);
    const detail = await getStockCountDetail(context, viewerId, countId);
    expect(Reflect.get(detail.count, "countedByStaff")).toEqual(staff);
    expect(Reflect.get(detail.count, "approvedByStaff")).toBeNull();
    expect(JSON.stringify(detail)).not.toContain("@private.example");
  });

  it("resolves waste logger only when they belong to the waste outlet", async () => {
    const page = await listWasteLogs(
      context,
      viewerId,
      wasteLogQuerySchema.parse({ outletId: outletA, locationId }),
    );
    expect(
      Reflect.get(
        page.data.find((row) => row.id === wasteId)!,
        "loggedByStaff",
      ),
    ).toEqual(staff);
    expect(
      Reflect.get(
        page.data.find((row) => row.id === foreignWasteId)!,
        "loggedByStaff",
      ),
    ).toBeNull();
    expect(JSON.stringify(page)).not.toContain("Private Other Outlet");
    expect(JSON.stringify(page)).not.toContain("@private.example");
  });

  it("does not grant access to a different outlet through attribution", async () => {
    await expect(
      listWasteLogs(
        context,
        viewerId,
        wasteLogQuerySchema.parse({ outletId: outletB }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("prefers an active role over a newer expired temporary assignment", async () => {
    const temporaryRole = randomUUID();
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, permissions, allowed_scope_types) VALUES ($1, $2, 'Expired Temporary Role', '[]', '["outlet"]')`,
      [temporaryRole, tenantId],
    );
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, valid_until, assigned_by) VALUES ($1, $2, $3, 'outlet', $4, now() - interval '30 minutes', now() - interval '10 minutes', $2)`,
      [tenantId, counterId, temporaryRole, outletA],
    );
    try {
      const detail = await getStockCountDetail(context, viewerId, countId);
      expect(Reflect.get(detail.count, "countedByStaff")).toEqual(staff);
    } finally {
      await owner.query("DELETE FROM role_assignments WHERE role_id = $1", [
        temporaryRole,
      ]);
      await owner.query("DELETE FROM roles WHERE id = $1", [temporaryRole]);
    }
  });
  it("resolves names on the counter sheet and approved-count meta", async () => {
    const sheet = await getStockCountSheet(context, viewerId, countId);
    expect(Reflect.get(sheet.count, "countedByStaff")).toEqual(staff);
    const approved = await getStockCountDetail(
      context,
      viewerId,
      approvedCountId,
    );
    expect(Reflect.get(approved.count, "approvedByStaff")).toEqual({
      userId: viewerId,
      displayName: "WS06 Viewer",
      role: "Petugas Stok WS06",
    });
  });

  it("keeps historical names after grant expiry but excludes future and empty grants", async () => {
    try {
      await owner.query(
        "UPDATE role_assignments SET valid_until = now() - interval '10 minutes' WHERE user_id = $1 AND role_id = $2",
        [counterId, roleId],
      );
      expect(
        Reflect.get(
          (await getStockCountDetail(context, viewerId, countId)).count,
          "countedByStaff",
        ),
      ).toEqual(staff);
      await owner.query(
        "UPDATE role_assignments SET valid_from = now() + interval '1 day', valid_until = null WHERE user_id = $1 AND role_id = $2",
        [counterId, roleId],
      );
      expect(
        Reflect.get(
          (await getStockCountDetail(context, viewerId, countId)).count,
          "countedByStaff",
        ),
      ).toBeNull();
      await owner.query(
        "UPDATE role_assignments SET valid_from = now() - interval '30 minutes', valid_until = now() - interval '30 minutes' WHERE user_id = $1 AND role_id = $2",
        [counterId, roleId],
      );
      expect(
        Reflect.get(
          (await getStockCountDetail(context, viewerId, countId)).count,
          "countedByStaff",
        ),
      ).toBeNull();
    } finally {
      await owner.query(
        "UPDATE role_assignments SET valid_from = now() - interval '1 hour', valid_until = null WHERE user_id = $1 AND role_id = $2",
        [counterId, roleId],
      );
    }
  });
});
