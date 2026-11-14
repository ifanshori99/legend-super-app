// Cross-tenant isolation for payments/refund and inventory (bead legend-wwsa;
// PRD v1.7 TEN-01, TEN-03). Tenant A is the seeded Cafe Legend tenant, tenant B
// is a throwaway tenant. Each module is proven three ways: the real service
// with a context minted for one tenant, table RLS as the legend_app login, and
// one authenticated HTTP request per module.
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { listRefunds } from "../services/payment-admin.service";
import {
  approveRefund,
  rejectRefund,
} from "../services/payment-refund.service";
import {
  getInventoryItem,
  listInventoryItems,
  updateInventoryItem,
} from "../services/inventory.service";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";
import {
  createAppPool,
  createOwnerPool,
  createSecondTenant,
  expectRowsIsolated,
  removeSecondTenant,
  requireDisposableDatabase,
  tenantAId,
  tenantContext,
  type SecondTenant,
} from "./tenant-isolation-harness";

const app = createApp();
const outletAId = cafeLegendPlatformFixtures.outlets[0]!.id;

let owner: Pool;
let appPool: Pool;
let tenantB: SecondTenant;
let client: ReturnType<typeof agent>;
// Tenant A actor (owner of Cafe Legend) and tenant B actor (same owner role,
// copied into tenant B), so a denial can only come from tenant scoping.
let actorId: string;
let actorBId: string;
const createdUsers: string[] = [];

const linkA = randomUUID();
const linkB = randomUUID();
const intentA = randomUUID();
const intentB = randomUUID();
const refundA = randomUUID();
const refundB = randomUUID();
const uomA = randomUUID();
const uomB = randomUUID();
const itemA = randomUUID();
const itemB = randomUUID();
// Keep the owned fixture beyond page one even when this file runs alone.
const earlierItemIds = Array.from({ length: 101 }, () => randomUUID());
const locationA = randomUUID();
const locationB = randomUUID();

async function insertPaymentGraph(
  tenantId: string,
  outletId: string,
  ids: { link: string; intent: string; refund: string },
): Promise<void> {
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, 100000, 100000, 100000, 'seed')`,
    [
      ids.link,
      tenantId,
      outletId,
      randomBytes(32).toString("hex"),
      `ISO-${ids.link.slice(0, 8)}`,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', 100000, $5, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
    [ids.intent, tenantId, outletId, ids.link, `iso-${ids.intent}`],
  );
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
     VALUES ($1, $2, $3, $4, 10000, 'Isolation refund', 'pending', $5)`,
    [ids.refund, tenantId, outletId, ids.intent, randomUUID()],
  );
}

async function insertInventoryGraph(
  tenantId: string,
  outletId: string,
  ids: { uom: string; item: string; location: string },
): Promise<void> {
  const suffix = ids.uom.slice(0, 8);
  await owner.query(
    "INSERT INTO uoms (id, tenant_id, code, name) VALUES ($1, $2, $3, 'Isolation unit')",
    [ids.uom, tenantId, `iso-${suffix.slice(0, 6)}`],
  );
  await owner.query(
    `INSERT INTO inventory_items (id, tenant_id, name, category, type, base_uom_id)
     VALUES ($1, $2, $3, 'Bahan Baku', 'raw_material', $4)`,
    [ids.item, tenantId, `Isolation item ${suffix}`, ids.uom],
  );
  await owner.query(
    "INSERT INTO stock_locations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, $4, 'warehouse')",
    [ids.location, tenantId, outletId, `Isolation location ${suffix}`],
  );
}

async function listAllInventoryItemIds(
  context: Parameters<typeof listInventoryItems>[0],
  actorUserId: string,
): Promise<string[]> {
  const ids: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await listInventoryItems(context, actorUserId, {
      limit: 100,
      cursor,
    });
    ids.push(...page.data.map((row) => row.id));
    cursor = page.meta.nextCursor ?? undefined;
    if (cursor) {
      expect(seenCursors.has(cursor)).toBe(false);
      seenCursors.add(cursor);
    }
  } while (cursor);
  expect(new Set(ids).size).toBe(ids.length);
  return ids;
}

/** Asserts the promise rejects with the service's 404 NOT_FOUND (not a permission error). */
async function expectNotFound(run: Promise<unknown>): Promise<void> {
  const error = await run.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ status: 404, code: "NOT_FOUND" });
}

/** Signs up a user, remembers it for cleanup and returns its id. */
async function createUser(
  label: string,
  who: ReturnType<typeof agent>,
): Promise<{ id: string; email: string }> {
  const email = await signUp(who, label);
  const session = await who.get("/api/auth/get-session");
  const id = session.body.user.id as string;
  createdUsers.push(id);
  return { id, email };
}

async function assignOwner(
  tenantId: string,
  roleId: string,
  userId: string,
): Promise<void> {
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenantId, userId, roleId],
  );
}

/** Runs every step even when one fails, then rethrows the first error. */
async function runAll(steps: Array<() => Promise<unknown>>): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw errors[0];
}

beforeAll(async () => {
  requireDisposableDatabase();
  owner = createOwnerPool();
  appPool = createAppPool();
  tenantB = await createSecondTenant(owner, "payinv");
  await insertPaymentGraph(tenantAId, outletAId, {
    link: linkA,
    intent: intentA,
    refund: refundA,
  });
  await insertPaymentGraph(tenantB.tenantId, tenantB.outletId, {
    link: linkB,
    intent: intentB,
    refund: refundB,
  });
  await insertInventoryGraph(tenantAId, outletAId, {
    uom: uomA,
    item: itemA,
    location: locationA,
  });
  await insertInventoryGraph(tenantB.tenantId, tenantB.outletId, {
    uom: uomB,
    item: itemB,
    location: locationB,
  });
  await owner.query(
    `INSERT INTO inventory_items (id, tenant_id, name, category, type, base_uom_id)
     SELECT fixture.id, $2, '000 TEN-01 item ' || fixture.id, 'Bahan Baku', 'raw_material', $3
     FROM unnest($1::uuid[]) AS fixture(id)`,
    [earlierItemIds, tenantAId, uomA],
  );

  // Tenant A owner for the service and route checks.
  client = agent(app);
  const userA = await createUser("Isolation payment inventory", client);
  actorId = userA.id;
  await verifySessionMfa(userA.email);
  const roleA = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'owner'",
    [tenantAId],
  );
  await assignOwner(tenantAId, roleA.rows[0]!.id, actorId);

  // Tenant B owner: the same permissions as tenant A's owner role.
  const roleB = await owner.query<{ id: string }>(
    `INSERT INTO roles (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     SELECT $1, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
     FROM roles WHERE id = $2
     RETURNING id`,
    [tenantB.tenantId, roleA.rows[0]!.id],
  );
  const userB = await createUser("Isolation payment inventory B", agent(app));
  actorBId = userB.id;
  await assignOwner(tenantB.tenantId, roleB.rows[0]!.id, actorBId);
});

afterAll(async () => {
  const tenants = [tenantAId, tenantB?.tenantId].filter(Boolean);
  await runAll([
    () =>
      owner.query("DELETE FROM payment_refunds WHERE id = ANY($1::uuid[])", [
        [refundA, refundB],
      ]),
    () =>
      owner.query("DELETE FROM payment_intents WHERE id = ANY($1::uuid[])", [
        [intentA, intentB],
      ]),
    () =>
      owner.query("DELETE FROM payment_links WHERE id = ANY($1::uuid[])", [
        [linkA, linkB],
      ]),
    () =>
      owner.query("DELETE FROM stock_locations WHERE id = ANY($1::uuid[])", [
        [locationA, locationB],
      ]),
    () =>
      owner.query(
        "DELETE FROM inventory_items WHERE id = ANY($1::uuid[]) AND tenant_id = ANY($2::uuid[])",
        [[itemA, itemB, ...earlierItemIds], tenants],
      ),
    () =>
      owner.query("DELETE FROM uoms WHERE id = ANY($1::uuid[])", [
        [uomA, uomB],
      ]),
    () =>
      owner.query(
        "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
        [createdUsers],
      ),
    () =>
      tenantB
        ? owner.query("DELETE FROM roles WHERE tenant_id = $1", [
            tenantB.tenantId,
          ])
        : Promise.resolve(),
    () =>
      owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
        createdUsers,
      ]),
    () => (tenantB ? removeSecondTenant(owner, tenantB) : Promise.resolve()),
    () => appPool?.end() ?? Promise.resolve(),
    () => owner?.end() ?? Promise.resolve(),
  ]);
});

describe("TEN-01 payment and refund tenant isolation", () => {
  it("TEN-01 listRefunds returns each tenant only its own refund", async () => {
    const pageA = await listRefunds(tenantContext(tenantAId), actorId, {
      limit: 100,
    });
    const idsA = pageA.data.map((row: { id: string }) => row.id);
    expect(idsA).toContain(refundA);
    expect(idsA).not.toContain(refundB);

    // Tenant B's owner has the same role, so B's own refund is visible to it.
    const pageB = await listRefunds(tenantContext(tenantB.tenantId), actorBId, {
      limit: 100,
    });
    const idsB = pageB.data.map((row: { id: string }) => row.id);
    expect(idsB).toContain(refundB);
    expect(idsB).not.toContain(refundA);
  });

  it("TEN-01 tenant A cannot approve or reject tenant B's refund, and it stays pending", async () => {
    const context = tenantContext(tenantAId);
    await expectNotFound(
      approveRefund(
        context,
        actorId,
        { refundId: refundB },
        { idempotencyKey: `iso-approve-${randomUUID()}` },
        `iso-approve-${randomUUID()}`,
        { mfaVerified: true },
      ),
    );
    await expectNotFound(
      rejectRefund(
        context,
        actorId,
        { refundId: refundB },
        { reason: "Cross tenant reject" },
        `iso-reject-${randomUUID()}`,
        { mfaVerified: true },
      ),
    );
    const { rows } = await owner.query(
      "SELECT status, approved_by, decided_at FROM payment_refunds WHERE id = $1",
      [refundB],
    );
    expect(rows[0]).toEqual({
      status: "pending",
      approved_by: null,
      decided_at: null,
    });
  });

  it("TEN-01 tenant B's owner cannot approve or reject tenant A's refund, and it stays pending", async () => {
    // The lookup of the refund runs before any permission check, so a 404
    // NOT_FOUND here is tenant scoping and not a missing role: tenant B's
    // owner reads its own refund through the same service above.
    const context = tenantContext(tenantB.tenantId);
    await expectNotFound(
      approveRefund(
        context,
        actorBId,
        { refundId: refundA },
        { idempotencyKey: `iso-approve-${randomUUID()}` },
        `iso-approve-${randomUUID()}`,
        { mfaVerified: true },
      ),
    );
    await expectNotFound(
      rejectRefund(
        context,
        actorBId,
        { refundId: refundA },
        { reason: "Cross tenant reject" },
        `iso-reject-${randomUUID()}`,
        { mfaVerified: true },
      ),
    );
    const { rows } = await owner.query(
      "SELECT status, approved_by, decided_at FROM payment_refunds WHERE id = $1",
      [refundA],
    );
    expect(rows[0]).toEqual({
      status: "pending",
      approved_by: null,
      decided_at: null,
    });
  });

  it("TEN-01 payment links, intents and refunds are isolated by row-level security", async () => {
    await expectRowsIsolated(
      appPool,
      {
        table: "payment_links",
        updateSet: "reference = reference || 'x'",
        tenantA: { tenantId: tenantAId, rowId: linkA },
        tenantB: { tenantId: tenantB.tenantId, rowId: linkB },
      },
      owner,
    );
    await expectRowsIsolated(
      appPool,
      {
        table: "payment_intents",
        updateSet: "idempotency_key = idempotency_key || 'x'",
        tenantA: { tenantId: tenantAId, rowId: intentA },
        tenantB: { tenantId: tenantB.tenantId, rowId: intentB },
      },
      owner,
    );
    await expectRowsIsolated(
      appPool,
      {
        table: "payment_refunds",
        updateSet: "reason = reason || 'x'",
        tenantA: { tenantId: tenantAId, rowId: refundA },
        tenantB: { tenantId: tenantB.tenantId, rowId: refundB },
      },
      owner,
    );
  });

  it("TEN-01 the refund routes list only the caller's tenant and refuse tenant B's refund id", async () => {
    const list = await client.get("/api/payments/admin/refunds?limit=100");
    expect(list.status).toBe(200);
    const ids = list.body.data.map((row: { id: string }) => row.id);
    expect(ids).toContain(refundA);
    expect(ids).not.toContain(refundB);

    // Gate control on the caller's own refund: an empty body passes the
    // permission and MFA gate of this route and is only stopped by validation
    // (422). Nothing is approved, so the refund stays untouched.
    const own = await client
      .post(`/api/payments/admin/refunds/${refundA}/approve`)
      .set(originHeader)
      .send({});
    expect(own.status).toBe(422);

    const approve = await client
      .post(`/api/payments/admin/refunds/${refundB}/approve`)
      .set(originHeader)
      .send({ idempotencyKey: `iso-route-${randomUUID()}` });
    expect(approve.status).toBe(404);
    expect(approve.body.error.code).toBe("NOT_FOUND");
    const { rows } = await owner.query(
      "SELECT status FROM payment_refunds WHERE id = $1",
      [refundB],
    );
    expect(rows[0]).toEqual({ status: "pending" });
  });
});

describe("TEN-01 inventory tenant isolation", () => {
  it("TEN-01 listInventoryItems returns each tenant only its own item", async () => {
    const idsA = await listAllInventoryItemIds(
      tenantContext(tenantAId),
      actorId,
    );
    expect(idsA).toContain(itemA);
    expect(idsA).toEqual(expect.arrayContaining(earlierItemIds));
    expect(idsA).not.toContain(itemB);

    const idsB = await listAllInventoryItemIds(
      tenantContext(tenantB.tenantId),
      actorBId,
    );
    expect(idsB).toContain(itemB);
    expect(idsB).not.toContain(itemA);
  });

  it("TEN-01 tenant A cannot get or update tenant B's item, and it is unchanged", async () => {
    const context = tenantContext(tenantAId);
    // Control: tenant A reads and updates its own item with the same calls.
    const ownItem = await getInventoryItem(context, actorId, itemA);
    expect(ownItem.id).toBe(itemA);
    const updated = await updateInventoryItem(context, actorId, itemA, {
      name: "Renamed by tenant A",
      expectedUpdatedAt: ownItem.updatedAt,
    });
    expect(updated.name).toBe("Renamed by tenant A");

    const before = await owner.query<{ name: string; updated_at: Date }>(
      "SELECT name, updated_at FROM inventory_items WHERE id = $1",
      [itemB],
    );
    await expectNotFound(getInventoryItem(context, actorId, itemB));
    await expectNotFound(
      updateInventoryItem(context, actorId, itemB, {
        name: "Hijacked by tenant A",
        expectedUpdatedAt: before.rows[0]!.updated_at.toISOString(),
      }),
    );
    const after = await owner.query<{ name: string; updated_at: Date }>(
      "SELECT name, updated_at FROM inventory_items WHERE id = $1",
      [itemB],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("TEN-01 tenant B's owner cannot read or update tenant A's item, and it is unchanged", async () => {
    const context = tenantContext(tenantB.tenantId);
    // Control: tenant B's owner reads and updates its own item.
    const ownItem = await getInventoryItem(context, actorBId, itemB);
    expect(ownItem.id).toBe(itemB);
    const updated = await updateInventoryItem(context, actorBId, itemB, {
      name: "Renamed by tenant B",
      expectedUpdatedAt: ownItem.updatedAt,
    });
    expect(updated.name).toBe("Renamed by tenant B");

    const before = await owner.query<{ name: string; updated_at: Date }>(
      "SELECT name, updated_at FROM inventory_items WHERE id = $1",
      [itemA],
    );
    await expectNotFound(getInventoryItem(context, actorBId, itemA));
    await expectNotFound(
      updateInventoryItem(context, actorBId, itemA, {
        name: "Hijacked by tenant B",
        expectedUpdatedAt: before.rows[0]!.updated_at.toISOString(),
      }),
    );
    const after = await owner.query<{ name: string; updated_at: Date }>(
      "SELECT name, updated_at FROM inventory_items WHERE id = $1",
      [itemA],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("TEN-01 units, items and stock locations are isolated by row-level security", async () => {
    await expectRowsIsolated(
      appPool,
      {
        table: "uoms",
        updateSet: "name = name || 'x'",
        tenantA: { tenantId: tenantAId, rowId: uomA },
        tenantB: { tenantId: tenantB.tenantId, rowId: uomB },
      },
      owner,
    );
    await expectRowsIsolated(
      appPool,
      {
        table: "inventory_items",
        updateSet: "name = name || 'x'",
        tenantA: { tenantId: tenantAId, rowId: itemA },
        tenantB: { tenantId: tenantB.tenantId, rowId: itemB },
      },
      owner,
    );
    await expectRowsIsolated(
      appPool,
      {
        table: "stock_locations",
        updateSet: "name = name || 'x'",
        tenantA: { tenantId: tenantAId, rowId: locationA },
        tenantB: { tenantId: tenantB.tenantId, rowId: locationB },
      },
      owner,
    );
  });

  it("TEN-01 the item routes list only the caller's tenant and refuse tenant B's item id", async () => {
    // Follow the cursor: the tenant fixture can hold more than one page of
    // items (shared database), so a single page may not contain itemA.
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page += 1) {
      const list: Awaited<ReturnType<typeof client.get>> = await client.get(
        `/api/inventory/items?limit=100${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
        }`,
      );
      expect(list.status).toBe(200);
      ids.push(...list.body.data.map((row: { id: string }) => row.id));
      cursor = list.body.meta.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(ids).toContain(itemA);
    expect(ids).not.toContain(itemB);

    // Control: the same calls on the caller's own item succeed.
    const ownRead = await client.get(`/api/inventory/items/${itemA}`);
    expect(ownRead.status).toBe(200);
    expect(ownRead.body.data.id).toBe(itemA);
    const ownUpdate = await client
      .patch(`/api/inventory/items/${itemA}`)
      .set(originHeader)
      .send({
        name: "Renamed over HTTP",
        expectedUpdatedAt: ownRead.body.data.updatedAt,
      });
    expect(ownUpdate.status).toBe(200);

    // The foreign update carries tenant B's real version, so only tenant
    // scoping can refuse it.
    const { rows: version } = await owner.query<{ updated_at: Date }>(
      "SELECT updated_at FROM inventory_items WHERE id = $1",
      [itemB],
    );
    const read = await client.get(`/api/inventory/items/${itemB}`);
    expect(read.status).toBe(404);
    expect(read.body.error.code).toBe("NOT_FOUND");
    const update = await client
      .patch(`/api/inventory/items/${itemB}`)
      .set(originHeader)
      .send({
        name: "Hijacked over HTTP",
        expectedUpdatedAt: version[0]!.updated_at.toISOString(),
      });
    expect(update.status).toBe(404);
    expect(update.body.error.code).toBe("NOT_FOUND");
    const { rows } = await owner.query<{ name: string }>(
      "SELECT name FROM inventory_items WHERE id = $1",
      [itemB],
    );
    expect(rows[0]!.name).not.toBe("Hijacked over HTTP");
  });
});
