// legend-98etn: a supplier_payment matrix needs a base tier (level 1, floor
// null/0) because a supplier payment always needs a second person (Q27).
// Written from the brief and docs/CONTRACT.md conventions, not from the
// implementation. Test ids:
// - BT-1 legacy tenant (tiers only from Rp 5.000.000) gets a base tier with
//        the lowest tier's level-1 role(s), and then any amount needs a second
//        person
// - BT-2 a tenant that already has a base tier (floor 0 or null) is unchanged
// - BT-3 running the backfill twice adds nothing the second time
// - BT-4 other tenants and other action types are untouched; no row deleted or
//        changed; only level 1 / floor 0 / distinct-actor rows are added
// - BT-5 PUT /api/access/approval-policies without a base tier -> 422
//        SUPPLIER_PAYMENT_BASE_TIER_REQUIRED with the Indonesian text; valid
//        matrix still 200 and the stored matrix does not change on refusal
//
// Assumptions: the backfill copies EVERY row (all levels, all roles) of the
// lowest existing supplier_payment tier to floor 0, so the base tier needs at
// least the approvals the lowest tier needed (coordinator decision). The
// invoice payable is Rp 100.000, so "a payment below the old floor" is paid
// with Rp 60.000 (a Rp 1.000.000 payment would exceed the invoice). Migration
// SQL runs in a rolled-back transaction (as supplier-payment-approval.test.ts
// SP-15 does) so the shared test database is not touched; the rows it would
// write are then inserted by hand to prove the payment behaviour.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { approvalResolvedEvent } from "@starter/shared/identity";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { seedTenantRoleTemplates } from "../services/access.service.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { setPurchaseReturnPostingEnabled } from "../services/purchase-return.service.ts";
import { setSupplierInvoicePostingEnabled } from "../services/purchasing-invoice.service.ts";
import { decideApprovalRequest } from "../services/platform-approval.service.ts";
import { handlePurchasingApprovalResolved } from "../services/purchasing-approval-consumer.ts";
import { originHeader, verifySessionMfa } from "./helpers.ts";
import {
  addUser,
  api,
  appPool,
  codeOf,
  contextFor,
  createInvoice,
  createWorld,
  invoiceBody,
  invoiceIdOf,
  key,
  owner,
  receive,
  seedPo,
  today,
  type Session,
  type World,
} from "./purchasing-apar-helpers.ts";

const PAYABLE = 100_000;
const MESSAGE =
  "Pembayaran supplier wajib punya tingkat dasar: tingkat 1 untuk semua nominal (batas 0). Tambahkan tingkat 1 dengan batas 0, supaya satu orang tidak bisa membayar supplier sendirian.";

type Row = [threshold: number | null, roleId: string, level: number];

type Tenant = {
  world: World;
  financeRoleId: string;
  ownerRoleId: string;
  buyer: Session;
  warehouse: Session;
  approver: Session; // holds the finance template role
  soleOwner: Session; // holds the owner template role
};

// ---- fixtures --------------------------------------------------------------

async function templateRoleId(world: World, templateKey: string) {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [world.tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} template role`);
  return rows[0].id;
}

async function assignTemplate(world: World, userId: string, roleId: string) {
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
    [world.tenantId, userId, roleId],
  );
}

async function replacePolicies(
  world: World,
  actionType: string,
  rows: Row[],
): Promise<void> {
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = $2",
    [world.tenantId, actionType],
  );
  for (const [threshold, roleId, level] of rows)
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [world.tenantId, actionType, threshold, roleId, level],
    );
}

/** Seeded tenant (default matrix) with a bank account, users and a sole owner. */
async function setupTenant(label: string): Promise<Tenant> {
  const world = await createWorld(label);
  await withTenant(db, contextFor(world, null), (tx) =>
    seedTenantRoleTemplates(tx, world.tenantId),
  );
  const bank = await owner.query<{ id: string }>(
    `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $2, '1103', 'Bank Operasional', 'asset', 'cash_and_equivalents') RETURNING id`,
    [world.tenantId, world.entityId],
  );
  await owner.query(
    `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
     VALUES ($1, $2, 'bank', $3)`,
    [world.tenantId, world.entityId, bank.rows[0]!.id],
  );
  const financeRoleId = await templateRoleId(world, "finance");
  const ownerRoleId = await templateRoleId(world, "owner");
  const approver = await addUser(world, `${label} approver`, []);
  await assignTemplate(world, approver.userId, financeRoleId);
  const soleOwner = await addUser(world, `${label} sole owner`, []);
  await assignTemplate(world, soleOwner.userId, ownerRoleId);
  return {
    world,
    financeRoleId,
    ownerRoleId,
    approver,
    soleOwner,
    buyer: await addUser(world, `${label} buyer`, [
      { role: "purchasing", outletId: world.outletId },
    ]),
    warehouse: await addUser(world, `${label} warehouse`, [
      { role: "warehouse", outletId: world.outletId },
    ]),
  };
}

// ---- migration runner ------------------------------------------------------

const MIGRATION = fileURLToPath(
  new URL(
    "../../drizzle/0638_supplier_payment_base_tier_backfill.sql",
    import.meta.url,
  ),
);

function migrationStatements(): string[] {
  return readFileSync(MIGRATION, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Runs `fn` inside a transaction that is always rolled back. */
async function rolledBack<T>(
  fn: (client: PoolClient, run: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const statements = migrationStatements();
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const run = async () => {
      for (const statement of statements) await client.query(statement);
    };
    return await fn(client, run);
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

/** Every approval_policies row, whole (ids and timestamps included). */
async function snapshot(client: Pick<PoolClient, "query">): Promise<string[]> {
  const { rows } = await client.query<{ j: string }>(
    "SELECT to_jsonb(p)::text AS j FROM approval_policies p ORDER BY 1",
  );
  return rows.map((r) => r.j);
}

type Policy = {
  tenant_id: string;
  action_type: string;
  threshold: number | null;
  levels: number;
  approver_role_id: string;
  requires_distinct_actor: boolean;
};

async function policiesOf(
  client: Pick<PoolClient, "query">,
  world: World,
  actionType = "supplier_payment",
): Promise<Policy[]> {
  const { rows } = await client.query<Policy>(
    `SELECT tenant_id, action_type, threshold_idr::int AS threshold, levels,
            approver_role_id, requires_distinct_actor
       FROM approval_policies
      WHERE tenant_id = $1 AND action_type = $2
      ORDER BY threshold_idr NULLS FIRST, levels, approver_role_id`,
    [world.tenantId, actionType],
  );
  return rows;
}

async function legacyTenantIds(
  client: Pick<PoolClient, "query">,
): Promise<string[]> {
  const { rows } = await client.query<{ tenant_id: string }>(
    `SELECT DISTINCT p.tenant_id FROM approval_policies p
      WHERE p.action_type = 'supplier_payment'
        AND NOT EXISTS (
          SELECT 1 FROM approval_policies b
           WHERE b.tenant_id = p.tenant_id AND b.action_type = 'supplier_payment'
             AND b.levels = 1 AND coalesce(b.threshold_idr, 0) = 0)
      ORDER BY 1`,
  );
  return rows.map((r) => r.tenant_id);
}

/** Floor-0 (or null) rows as sorted "level:roleId" pairs. */
const baseRows = (rows: Policy[]) =>
  rows
    .filter((r) => (r.threshold ?? 0) === 0)
    .map((r) => `${r.levels}:${r.approver_role_id}`)
    .sort();

// ---- payment helpers (supplier-payment-two-person.test.ts conventions) -----

const payPath = (invoiceId: string) =>
  `/supplier-invoices/${invoiceId}/payments`;

async function invoiceFor(t: Tenant): Promise<string> {
  const po = await receive(t.world, t.warehouse, await seedPo(t.world));
  const res = await createInvoice(
    t.world,
    t.buyer,
    invoiceBody(t.world, po, {}),
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return invoiceIdOf(res);
}

async function requestPayment(
  t: Tenant,
  who: Session,
  invoiceId: string,
  amountIdr: number,
) {
  const res = await api.post(t.world, who, payPath(invoiceId), {
    amountIdr,
    paidOn: today(),
    idempotencyKey: key(),
  });
  expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
  return (res.body as { data: { id: string; status: string } }).data;
}

async function chainOf(t: Tenant, paymentId: string): Promise<string> {
  const { rows } = await owner.query<{ approval_chain_id: string | null }>(
    "SELECT approval_chain_id FROM supplier_payments WHERE tenant_id = $1 AND id = $2",
    [t.world.tenantId, paymentId],
  );
  expect(rows[0]?.approval_chain_id).toBeTruthy();
  return rows[0]!.approval_chain_id!;
}

async function journalCount(t: Tenant): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM journal_entries
      WHERE tenant_id = $1 AND source_type = 'supplier_payment'`,
    [t.world.tenantId],
  );
  return rows[0]!.n;
}

async function outstanding(t: Tenant, invoiceId: string): Promise<number> {
  const { rows } = await owner.query<{ outstanding: string }>(
    `SELECT (original_idr - settled_idr)::text AS outstanding
       FROM accounting_open_items
      WHERE tenant_id = $1 AND kind = 'payable' AND id = $2`,
    [t.world.tenantId, invoiceId],
  );
  return Number(rows[0]!.outstanding);
}

/** Each level is its own approval_requests row; chain_id is the level-1 id. */
async function pendingRequestId(
  t: Tenant,
  chainId: string,
  level: number,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM approval_requests
      WHERE tenant_id = $1 AND chain_id = $2 AND level = $3 AND status = 'pending'`,
    [t.world.tenantId, chainId, level],
  );
  expect(rows, `pending level ${level}`).toHaveLength(1);
  return rows[0]!.id;
}

async function paymentStatus(t: Tenant, paymentId: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM supplier_payments WHERE tenant_id = $1 AND id = $2",
    [t.world.tenantId, paymentId],
  );
  return rows[0]!.status;
}

async function decideOnly(t: Tenant, who: Session, requestId: string) {
  await decideApprovalRequest(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(t.world.tenantId),
      brandId: null,
      source: "domain",
    }),
    who.userId,
    requestId,
    { decision: "approved", reason: "Sesuai tagihan dan bukti pemasok." },
    { mfaVerified: true, idempotencyKey: null },
  );
}

async function approveAndApply(
  t: Tenant,
  who: Session,
  requestId: string,
  chainId: string,
) {
  await decideApprovalRequest(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(t.world.tenantId),
      brandId: null,
      source: "domain",
    }),
    who.userId,
    requestId,
    { decision: "approved", reason: "Sesuai tagihan dan bukti pemasok." },
    { mfaVerified: true, idempotencyKey: null },
  );
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND destination = 'cloud-sync'
        AND event->>'name' = 'approval.resolved'
        AND event->'payload'->>'chainId' = $2`,
    [t.world.tenantId, chainId],
  );
  expect(rows).toHaveLength(1);
  await handlePurchasingApprovalResolved(
    contextFor(t.world, null),
    approvalResolvedEvent.envelopeSchema.parse(rows[0]!.event),
  );
}

// ---- setup -----------------------------------------------------------------

let LEGACY: Tenant; // tiers only from 5.000.000: finance L1, owner L2
let MULTI: Tenant; // 2.000.000 finance L1; 5.000.000 owner L1 + L2
let HIGHER: Tenant; // 2.000.000 finance L1 + owner L2; 8.000.000 owner L1 + L2
let TWOROLES: Tenant; // 3.000.000 finance L1 + owner L1
let CORRECT: Tenant; // default matrix (floor 0)
let NULLBASE: Tenant; // floor null L1 plus a positive tier
let NOSUPPLIER: Tenant; // no supplier_payment rows, only cash_out
let OTHERS: Tenant; // legacy supplier_payment + other action types

const mfaVerified = new Set<string>();

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  setPurchaseReturnPostingEnabled(true);
  setSupplierInvoicePostingEnabled(true);

  LEGACY = await setupTenant("bt-legacy");
  await replacePolicies(LEGACY.world, "supplier_payment", [
    [5_000_000, LEGACY.financeRoleId, 1],
    [5_000_000, LEGACY.ownerRoleId, 2],
  ]);
  MULTI = await setupTenant("bt-multi");
  await replacePolicies(MULTI.world, "supplier_payment", [
    [5_000_000, MULTI.ownerRoleId, 1],
    [5_000_000, MULTI.ownerRoleId, 2],
    [2_000_000, MULTI.financeRoleId, 1],
  ]);
  HIGHER = await setupTenant("bt-higher");
  await replacePolicies(HIGHER.world, "supplier_payment", [
    [2_000_000, HIGHER.financeRoleId, 1],
    [2_000_000, HIGHER.ownerRoleId, 2],
    [8_000_000, HIGHER.ownerRoleId, 1],
    [8_000_000, HIGHER.ownerRoleId, 2],
  ]);
  TWOROLES = await setupTenant("bt-two");
  await replacePolicies(TWOROLES.world, "supplier_payment", [
    [3_000_000, TWOROLES.financeRoleId, 1],
    [3_000_000, TWOROLES.ownerRoleId, 1],
  ]);
  CORRECT = await setupTenant("bt-correct");
  NULLBASE = await setupTenant("bt-null");
  await replacePolicies(NULLBASE.world, "supplier_payment", [
    [null, NULLBASE.financeRoleId, 1],
    [4_000_000, NULLBASE.ownerRoleId, 2],
  ]);
  NOSUPPLIER = await setupTenant("bt-none");
  await replacePolicies(NOSUPPLIER.world, "supplier_payment", []);
  await replacePolicies(NOSUPPLIER.world, "cash_out", [
    [100_000, NOSUPPLIER.financeRoleId, 1],
  ]);
  OTHERS = await setupTenant("bt-others");
  await replacePolicies(OTHERS.world, "supplier_payment", [
    [5_000_000, OTHERS.financeRoleId, 1],
  ]);
  await replacePolicies(OTHERS.world, "cash_out", [
    [100_000, OTHERS.financeRoleId, 1],
    [100_000, OTHERS.ownerRoleId, 2],
  ]);
});

afterAll(async () => {
  setSupplierInvoicePostingEnabled(null);
  setPurchaseReturnPostingEnabled(null);
  setAuditWriter(null);
  await appPool.end();
  await owner.end();
});

describe("legend-98etn supplier_payment base tier backfill (0638)", () => {
  it("BT-1 a legacy tenant (floor 5.000.000: Finance L1 + Owner L2) gets the same two levels at floor 0, so a payment below the old floor needs Finance then Owner", async () => {
    const t = LEGACY;
    const before = await policiesOf(owner, t.world);
    expect(baseRows(before)).toEqual([]);

    const after = await rolledBack(async (client, run) => {
      await run();
      return policiesOf(client, t.world);
    });
    // Existing rows stay exactly as they were; two rows are added.
    for (const row of before) expect(after).toContainEqual(row);
    expect(after).toHaveLength(before.length + 2);
    expect(baseRows(after)).toEqual(
      [`1:${t.financeRoleId}`, `2:${t.ownerRoleId}`].sort(),
    );
    for (const row of after.filter((r) => (r.threshold ?? 0) === 0))
      expect(row.requires_distinct_actor).toBe(true);
    // Rolled back: nothing leaked.
    expect(await policiesOf(owner, t.world)).toEqual(before);

    // The tenant's own approval chain, as the backfill writes it.
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
       VALUES ($1, 'supplier_payment', 0, $2, 1, true), ($1, 'supplier_payment', 0, $3, 2, true)`,
      [t.world.tenantId, t.financeRoleId, t.ownerRoleId],
    );
    const ownerTwo = await addUser(t.world, "bt-legacy owner two", []);
    await assignTemplate(t.world, ownerTwo.userId, t.ownerRoleId);

    // Below the old floor, any amount: pending, nothing posted.
    const invoiceId = await invoiceFor(t);
    for (const amount of [1, 10_000]) {
      const payment = await requestPayment(t, t.soleOwner, invoiceId, amount);
      expect(payment.status, `amount ${amount}`).toBe("pending_approval");
    }
    expect(await journalCount(t)).toBe(0);
    expect(await outstanding(t, invoiceId)).toBe(PAYABLE);

    // A large payment below the old floor needs Finance, then Owner: after the
    // Finance approval nothing is posted yet, and only the second level settles.
    const big = await requestPayment(t, t.soleOwner, invoiceId, 60_000);
    expect(big.status).toBe("pending_approval");
    const chainId = await chainOf(t, big.id);
    await decideOnly(t, t.approver, await pendingRequestId(t, chainId, 1)); // Finance
    // Still pending: a level-2 request is now waiting for the Owner.
    expect(await paymentStatus(t, big.id)).toBe("pending_approval");
    const level2 = await pendingRequestId(t, chainId, 2);
    expect(await journalCount(t)).toBe(0);
    expect(await outstanding(t, invoiceId)).toBe(PAYABLE);
    await approveAndApply(t, ownerTwo, level2, chainId); // Owner, level 2
    expect(await paymentStatus(t, big.id)).toBe("paid");
    expect(await journalCount(t)).toBe(1);
    expect(await outstanding(t, invoiceId)).toBe(PAYABLE - 60_000);
  });

  it("BT-1b the lowest tier alone is copied: a higher tier stays untouched; a lowest tier with two level-1 roles gives both", async () => {
    // Lowest tier has levels 1 and 2 and a higher tier exists.
    const beforeHigher = await policiesOf(owner, HIGHER.world);
    const afterHigher = await rolledBack(async (client, run) => {
      await run();
      return policiesOf(client, HIGHER.world);
    });
    expect(baseRows(afterHigher)).toEqual(
      [`1:${HIGHER.financeRoleId}`, `2:${HIGHER.ownerRoleId}`].sort(),
    );
    // Every earlier row (2.000.000 and 8.000.000) is identical, and the
    // 8.000.000 tier was not copied anywhere else.
    for (const row of beforeHigher) expect(afterHigher).toContainEqual(row);
    expect(afterHigher).toHaveLength(beforeHigher.length + 2);
    expect(afterHigher.filter((r) => r.threshold === 8_000_000)).toEqual(
      beforeHigher.filter((r) => r.threshold === 8_000_000),
    );

    // Lowest tier is the 2.000.000 one even though 5.000.000 has more levels.
    const multi = await rolledBack(async (client, run) => {
      await run();
      return policiesOf(client, MULTI.world);
    });
    expect(baseRows(multi)).toEqual([`1:${MULTI.financeRoleId}`]);

    // Two roles at level 1 of the lowest tier: both are copied.
    const two = await rolledBack(async (client, run) => {
      await run();
      return policiesOf(client, TWOROLES.world);
    });
    expect(baseRows(two)).toEqual(
      [`1:${TWOROLES.financeRoleId}`, `1:${TWOROLES.ownerRoleId}`].sort(),
    );
  });

  it("BT-2 a tenant that already has a base tier is unchanged", async () => {
    const watched = [CORRECT, NULLBASE];
    const before = await Promise.all(
      watched.map((t) => policiesOf(owner, t.world)),
    );
    await rolledBack(async (client, run) => {
      const rowsBefore = await snapshot(client);
      await run();
      for (let i = 0; i < watched.length; i++)
        expect(await policiesOf(client, watched[i]!.world)).toEqual(before[i]);
      // Whole-table: every earlier row is still there, byte for byte.
      const rowsAfter = new Set(await snapshot(client));
      for (const row of rowsBefore) expect(rowsAfter.has(row)).toBe(true);
    });
    expect(baseRows(before[1]!)).toEqual([`1:${NULLBASE.financeRoleId}`]);
  });

  it("BT-3 running the backfill twice adds nothing the second time", async () => {
    await rolledBack(async (client, run) => {
      await run();
      const once = await snapshot(client);
      await run();
      const twice = await snapshot(client);
      expect(twice).toEqual(once);
      expect(await legacyTenantIds(client)).toEqual([]);
    });
  });

  it("BT-4 other tenants and other action types are untouched; only base-tier rows are added, only for legacy tenants", async () => {
    await rolledBack(async (client, run) => {
      const legacyBefore = await legacyTenantIds(client);
      expect(legacyBefore).toEqual(
        expect.arrayContaining([
          // LEGACY got its base tier by hand in BT-1, so it is no longer legacy.
          MULTI.world.tenantId,
          HIGHER.world.tenantId,
          TWOROLES.world.tenantId,
          OTHERS.world.tenantId,
        ]),
      );
      expect(legacyBefore).not.toContain(CORRECT.world.tenantId);
      expect(legacyBefore).not.toContain(NULLBASE.world.tenantId);
      expect(legacyBefore).not.toContain(NOSUPPLIER.world.tenantId);

      const cashOutBefore = await policiesOf(client, OTHERS.world, "cash_out");
      const noSupplierBefore = await policiesOf(client, NOSUPPLIER.world);
      const before = await snapshot(client);
      await run();
      const after = await snapshot(client);

      // Nothing deleted or changed.
      const afterSet = new Set(after);
      for (const row of before) expect(afterSet.has(row)).toBe(true);
      // Only additions: base-tier supplier_payment rows of legacy tenants.
      const beforeSet = new Set(before);
      const added = after
        .filter((row) => !beforeSet.has(row))
        .map((row) => JSON.parse(row) as Record<string, unknown>);
      expect(added.length).toBeGreaterThan(0);
      for (const row of added) {
        expect(row.action_type).toBe("supplier_payment");
        expect(row.levels).toBeGreaterThanOrEqual(1);
        expect(Number(row.threshold_idr)).toBe(0);
        expect(row.requires_distinct_actor).toBe(true);
        expect(legacyBefore).toContain(row.tenant_id);
      }
      expect(
        [...new Set(added.map((r) => r.tenant_id as string))].sort(),
      ).toEqual(legacyBefore);
      // Other action types and no-supplier tenants are as they were.
      expect(await policiesOf(client, OTHERS.world, "cash_out")).toEqual(
        cashOutBefore,
      );
      expect(await policiesOf(client, NOSUPPLIER.world)).toEqual(
        noSupplierBefore,
      );
      expect(noSupplierBefore).toEqual([]);
    });
  });

  // ---- PUT -----------------------------------------------------------------

  async function put(t: Tenant, policies: object[]) {
    if (!mfaVerified.has(t.soleOwner.email)) {
      await verifySessionMfa(t.soleOwner.email);
      mfaVerified.add(t.soleOwner.email);
    }
    return t.soleOwner.client
      .put("/api/access/approval-policies")
      .set(originHeader)
      .set("Host", t.world.hostname)
      .send({ policies });
  }
  const tier = (
    thresholdIdr: number | null,
    approverRoleId: string,
    levels: number,
  ) => ({
    actionType: "supplier_payment",
    thresholdIdr,
    approverRoleId,
    levels,
  });

  it("BT-5 PUT without a base tier answers 422 SUPPLIER_PAYMENT_BASE_TIER_REQUIRED with the Indonesian text; a valid matrix still saves", async () => {
    const t = await setupTenant("bt-put");

    // Control: valid matrix, base tier from Rp 0 plus a tier that adds a level.
    const good = await put(t, [
      tier(0, t.financeRoleId, 1),
      tier(0, t.ownerRoleId, 1),
      tier(5_000_000, t.financeRoleId, 1),
      tier(5_000_000, t.ownerRoleId, 2),
    ]);
    expect(good.status, JSON.stringify(good.body)).toBe(200);
    const stored = await policiesOf(owner, t.world);

    const refused: [string, object[]][] = [
      ["only from 5.000.000", [tier(5_000_000, t.financeRoleId, 1)]],
      [
        "two roles only from 5.000.000",
        [
          tier(5_000_000, t.financeRoleId, 1),
          tier(5_000_000, t.ownerRoleId, 1),
        ],
      ],
      ["floor nobody reaches", [tier(1_000_000_000_000, t.ownerRoleId, 1)]],
      [
        "base tier at floor 0 but only level 2",
        [tier(0, t.ownerRoleId, 2), tier(5_000_000, t.financeRoleId, 1)],
      ],
    ];
    for (const [label, rows] of refused) {
      const res = await put(t, rows);
      expect(res.status, `${label} ${JSON.stringify(res.body)}`).toBe(422);
      expect(codeOf(res), label).toBe("SUPPLIER_PAYMENT_BASE_TIER_REQUIRED");
      expect((res.body as { error: { message: string } }).error.message).toBe(
        MESSAGE,
      );
      expect(await policiesOf(owner, t.world), label).toEqual(stored);
    }

    // Floor null counts as a base tier (any amount): accepted.
    const nullBase = await put(t, [tier(null, t.financeRoleId, 1)]);
    expect(nullBase.status, JSON.stringify(nullBase.body)).toBe(200);
  });
});
