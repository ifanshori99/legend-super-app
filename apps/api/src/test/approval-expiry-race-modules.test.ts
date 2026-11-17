// Approval expiry race for synchronous settlers: POS phone override and stock
// count (brief sub-100-approval-expiry-race, slice E; PRD v1.7 §3 F7 "Kotak
// Approval" "batas waktu", AUTH-06, INV-03).
//
// Bug: the module reads the chain outcome without the chain lock, sees
// `pending` past the deadline and decides "expired" while an inbox decision
// (which holds the chain-head lock) is still uncommitted. The decision then
// commits `approved` but the module already rejected its row, so the effect is
// lost. Contract: a decision already in flight commits first and wins; without
// one, the deadline expires the chain and a later decision is refused.
//
// Deterministic, no sleeps: a raw owner connection plays the inbox decide that
// has not committed (BEGIN, lock the chain head FOR UPDATE, set `approved`).
// The module settle runs with `now` past the deadline; we wait on a database
// condition (the settle is blocked by that connection, bounded polling of
// pg_locks) and only then COMMIT.
//
// Assumptions:
// - Stock count: an unanswered, overdue count expires its approval request
//   (row `expired`, late decision -> APPROVAL_REQUEST_EXPIRED) and goes back to
//   `counting` (existing F5 behavior).
// - Two-level count: an inbox decision that approves level 1 and opens level 2
//   (fresh deadline, as decide does) while the settle waits leaves the count
//   `pending_approval` with level 2 still `pending`; level 2's deadline is set
//   well after the settle's `now`.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import {
  createPosOverrideSchema,
  type PosOverrideView,
} from "@starter/shared/access/override";
import {
  decimal4,
  outletIdSchema,
  ulidToUuid,
  type OutletId,
  type ScopedTenantContext,
  type TenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  createStockCountInputSchema,
  transitionStockCountInputSchema,
  updateStockCountLineInputSchema,
} from "@starter/shared/inventory";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { setAuditWriter } from "../services/audit-writer.ts";
import {
  createStockCount,
  transitionStockCount,
  updateStockCountLine,
} from "../services/inventory-count.service.ts";
import { recordStockMovement } from "../services/inventory.service.ts";
import { decideApprovalRequest } from "../services/platform-approval.service.ts";
import {
  createPosOverride,
  settlePosOverrideForApproval,
} from "../services/staff-override.service.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const bandung = cafeLegendAccessFixtures.outletIds.bandung;
const outletA = outletIdSchema.parse(
  cafeLegendPlatformFixtures.outlets[0]!.id,
) as OutletId;
const ACTIONS = ["void", "stock_adjustment"];

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 6,
});
const createdUserIds: string[] = [];
const createdCountIds: string[] = [];
let savedPolicies: Record<string, unknown>[] = [];

const tenant: TenantContext = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});
const workerContext: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "job" }),
  { kind: "tenant" },
);
const outletContext: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "domain" }),
  { kind: "outlets", outletIds: [outletA] },
);

// ------------------------------------------------------------------ fixtures

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

async function createUser(templateKey: string, outletId: string) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`,
    [id, `Race ${templateKey}`, `${id}@example.test`],
  );
  createdUserIds.push(id);
  // Backdated: the container clock may drift from the Node clock.
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
    [tenantId, id, await roleIdOf(templateKey), outletId],
  );
  return id;
}

/** The chain's level-1 row: id, deadline and every level's status. */
async function chainOf(chainId: string) {
  const { rows } = await owner.query<{
    status: string;
    decided_by: string | null;
    deadline_at: Date;
  }>(
    `SELECT status, decided_by, deadline_at FROM approval_requests
     WHERE tenant_id = $1 AND chain_id = $2 ORDER BY level`,
    [tenantId, chainId],
  );
  return rows;
}

/** A moment safely after the (single-level) chain's deadline. */
async function afterDeadline(chainId: string): Promise<Date> {
  const [head] = await chainOf(chainId);
  return new Date(head!.deadline_at.getTime() + 60_000);
}

// ------------------------------------------------- the inbox decide in flight

type InFlightDecision = {
  pid: number;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
};

/**
 * Plays decideApprovalRequest before it commits: locks the chain head (the
 * lock every decide takes) and marks the level approved by `approverId`.
 */
async function startInboxDecision(
  chainId: string,
  approverId: string,
  options: { opensLevelTwo?: boolean } = {},
): Promise<InFlightDecision> {
  const client: PoolClient = await owner.connect();
  let open = true;
  const finish = async (statement: "COMMIT" | "ROLLBACK") => {
    if (!open) return;
    open = false;
    try {
      await client.query(statement);
    } finally {
      client.release();
    }
  };
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const { rows } = await client.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    await client.query(
      "SELECT id FROM approval_requests WHERE id = $1 FOR UPDATE",
      [chainId],
    );
    await client.query(
      `UPDATE approval_requests
         SET status = 'approved', decided_by = $2, decided_at = now(),
             reason = 'Disetujui dari kotak approval.', updated_at = now()
       WHERE tenant_id = $3 AND chain_id = $1 AND status = 'pending'`,
      [chainId, approverId, tenantId],
    );
    if (options.opensLevelTwo)
      // What decide does for a multi-level chain: the next level opens with a
      // fresh deadline (here far after level 1's, so only level 1 is overdue).
      await client.query(
        `INSERT INTO approval_requests
           (tenant_id, outlet_id, chain_id, source_module, action_type, object_type,
            object_id, payload, requested_by, source, level, required_levels,
            required_steps, threshold_idr, amount_idr, status, request_reason,
            deadline_at, created_at, updated_at)
         SELECT tenant_id, outlet_id, chain_id, source_module, action_type, object_type,
                object_id, payload, requested_by, source, 2, required_levels,
                required_steps, threshold_idr, amount_idr, 'pending', request_reason,
                deadline_at + interval '2 days', now(), now()
         FROM approval_requests WHERE tenant_id = $2 AND id = $1`,
        [chainId, tenantId],
      );
    return {
      pid: rows[0]!.pid,
      commit: () => finish("COMMIT"),
      rollback: () => finish("ROLLBACK"),
    };
  } catch (error) {
    await finish("ROLLBACK");
    throw error;
  }
}

/**
 * True once another session waits on a lock held by `pid`; false when the
 * watched work finished without ever waiting. Polls a database condition (no
 * fixed delay), bounded so a bug cannot hang the run.
 */
async function waitUntilBlockedBy(
  pid: number,
  finished: () => boolean,
): Promise<boolean> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const { rows } = await owner.query(
      `SELECT 1 FROM pg_locks
       WHERE NOT granted AND $1::int = ANY(pg_blocking_pids(pid)) LIMIT 1`,
      [pid],
    );
    if (rows.length > 0) return true;
    if (finished()) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/**
 * Runs `settle` while `decision` is uncommitted, commits it once the settle
 * waits (or ended without waiting) and returns what the settle returned.
 */
async function settleDuringDecision<T>(
  decision: InFlightDecision,
  settle: () => Promise<T>,
): Promise<{ result: T; waited: boolean }> {
  let finished = false;
  const running = settle().finally(() => {
    finished = true;
  });
  // A rejection is surfaced below, after the lock is released.
  running.catch(() => undefined);
  try {
    const waited = await waitUntilBlockedBy(decision.pid, () => finished);
    await decision.commit();
    return { result: await running, waited };
  } finally {
    await decision.rollback();
  }
}

// -------------------------------------------------------------- POS override

async function phoneOverride(cashier: string): Promise<PosOverrideView> {
  const { override } = await createPosOverride(
    tenant,
    cashier,
    createPosOverrideSchema.parse({
      outletId: bandung,
      action: "void",
      valueIdr: 45_000,
      reason: "Tamu membatalkan menu sebelum dimasak.",
      objectType: "order",
      objectId: randomUUID(),
      approval: { method: "supervisor_phone" },
    }),
    { idempotencyKey: null },
  );
  return override;
}

async function overrideRow(id: string) {
  const { rows } = await owner.query<{
    status: string;
    approved_by: string | null;
  }>("SELECT status, approved_by FROM pos_overrides WHERE id = $1", [
    ulidToUuid(id),
  ]);
  return rows[0];
}

async function recordedEvents(overrideId: string) {
  const { rows } = await owner.query<{ name: string }>(
    `SELECT event->>'name' AS name FROM domain_event_outbox
     WHERE tenant_id = $1 AND aggregate_type = 'pos_override' AND aggregate_id = $2`,
    [tenantId, ulidToUuid(overrideId)],
  );
  return rows.map((row) => row.name);
}

// --------------------------------------------------------------- stock count

async function seedCountedStock(counter: string, counted: string) {
  const uom = await owner.query<{ id: string }>(
    "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
    [tenantId, `g${randomUUID().slice(0, 6)}`],
  );
  const location = await owner.query<{ id: string }>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'warehouse') RETURNING id",
    [tenantId, outletA, `Race ${randomUUID().slice(0, 6)}`],
  );
  const item = await owner.query<{ id: string }>(
    `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
     VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3, true) RETURNING id`,
    [tenantId, `Race ${randomUUID().slice(0, 6)}`, uom.rows[0]!.id],
  );
  const locationId = location.rows[0]!.id;
  const itemId = item.rows[0]!.id;
  await recordStockMovement(outletContext, {
    outletId: outletA,
    locationId,
    inventoryItemId: itemId,
    movementType: "receipt",
    quantity: decimal4("10.0000"),
    unitCostIdr: decimal4("1500.0000"),
    batchId: null,
    sourceType: "goods_receipt",
    sourceId: randomUUID(),
    actor: { type: "system" },
  });

  const { count } = await createStockCount(
    outletContext,
    counter,
    createStockCountInputSchema.parse({
      outletId: outletA,
      locationId,
      type: "cycle",
      blind: false,
      businessDate: new Date().toISOString().slice(0, 10),
      inventoryItemIds: [itemId],
      idempotencyKey: `sc-${randomUUID()}`,
    }),
  );
  createdCountIds.push(count.id);
  const step = (action: string) =>
    transitionStockCount(
      outletContext,
      counter,
      count.id,
      transitionStockCountInputSchema.parse({
        action,
        idempotencyKey: `${action}-${randomUUID()}`,
      }),
      { mfaVerified: false },
    );
  await step("start");
  const { rows: lines } = await owner.query<{ id: string }>(
    "SELECT id FROM stock_count_lines WHERE stock_count_id = $1",
    [count.id],
  );
  await updateStockCountLine(
    outletContext,
    counter,
    count.id,
    lines[0]!.id,
    updateStockCountLineInputSchema.parse({ countedQty: counted }),
  );
  const submitted = await step("submit");
  expect(submitted.status).toBe("pending_approval");
  return { countId: count.id, locationId, itemId };
}

async function countApproval(countId: string) {
  const { rows } = await owner.query<{ id: string; chain_id: string }>(
    `SELECT request.id, request.chain_id FROM approval_requests AS request
     JOIN stock_counts AS count
       ON count.tenant_id = request.tenant_id AND count.approval_chain_id = request.chain_id
     WHERE request.tenant_id = $1 AND request.source_module = 'inventory_count'
       AND count.id = $2 AND request.object_id = count.id::text AND request.level = 1`,
    [tenantId, countId],
  );
  expect(rows, "the submitted count opened one approval chain").toHaveLength(1);
  return rows[0]!;
}

function postCount(actor: string, countId: string, now: Date) {
  return transitionStockCount(
    outletContext,
    actor,
    countId,
    transitionStockCountInputSchema.parse({
      action: "post",
      idempotencyKey: `post-${randomUUID()}`,
    }),
    { mfaVerified: true, now },
  );
}

function rejectCount(actor: string, countId: string, now: Date) {
  return transitionStockCount(
    outletContext,
    actor,
    countId,
    transitionStockCountInputSchema.parse({
      action: "reject",
      idempotencyKey: `reject-${randomUUID()}`,
    }),
    { mfaVerified: true, now },
  );
}

async function ledgerOf(countId: string) {
  const { rows } = await owner.query<{ quantity: string }>(
    `SELECT quantity::text AS quantity FROM stock_ledger
     WHERE tenant_id = $1 AND source_id = $2`,
    [tenantId, countId],
  );
  return rows;
}

async function balanceOf(locationId: string, itemId: string) {
  const { rows } = await owner.query<{ quantity: string }>(
    `SELECT quantity::text AS quantity FROM stock_balances
     WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3`,
    [tenantId, locationId, itemId],
  );
  return rows[0]?.quantity ?? null;
}

async function countStatus(countId: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM stock_counts WHERE tenant_id = $1 AND id = $2",
    [tenantId, countId],
  );
  return rows[0]!.status;
}

/** Adds a two-level stock_adjustment policy beside the one-level one while `run` executes. */
async function withTwoLevelPolicy(run: () => Promise<void>) {
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'stock_adjustment', NULL, $2, 2)`,
    [tenantId, await roleIdOf("outlet_manager")],
  );
  try {
    await run();
  } finally {
    await owner.query(
      `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'stock_adjustment' AND levels = 2`,
      [tenantId],
    );
  }
}

// ---------------------------------------------------------------- lifecycle

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter({ record: async () => undefined });
  savedPolicies = (
    await owner.query(
      `SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = ANY($2::text[])`,
      [tenantId, ACTIONS],
    )
  ).rows;
  await owner.query(
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = ANY($2::text[])`,
    [tenantId, ACTIONS],
  );
  // §3.7 matrix: a void goes to a supervisor, a stock adjustment to an outlet
  // manager; one level each.
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'void', NULL, $2, 1), ($1, 'stock_adjustment', NULL, $3, 1)`,
    [tenantId, await roleIdOf("supervisor"), await roleIdOf("outlet_manager")],
  );
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.query(
    `DELETE FROM pos_overrides WHERE tenant_id = $1 AND requested_by = ANY($2::text[])`,
    [tenantId, createdUserIds],
  );
  await owner.query(
    `DELETE FROM approval_requests WHERE tenant_id = $1 AND
       (requested_by = ANY($2::text[]) OR object_id = ANY($3::text[]))`,
    [tenantId, createdUserIds, createdCountIds],
  );
  await owner.query(
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = ANY($2::text[])`,
    [tenantId, ACTIONS],
  );
  for (const row of savedPolicies)
    await owner.query(
      `INSERT INTO approval_policies (id, tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        row.id,
        row.tenant_id,
        row.action_type,
        row.threshold_idr,
        row.approver_role_id,
        row.levels,
        row.requires_distinct_actor,
      ],
    );
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantId, createdUserIds],
  );
  await owner.end();
});

// -------------------------------------------------------------------- tests

describe("approval expiry race: POS phone override", () => {
  it("an inbox approval already in flight wins over the deadline: the override is recorded, not expired", async () => {
    const cashier = await createUser("cashier", bandung);
    const supervisor = await createUser("supervisor", bandung);
    const pending = await phoneOverride(cashier);
    const chainId = pending.approvalRequestId!;
    const now = await afterDeadline(chainId);

    const decision = await startInboxDecision(chainId, supervisor);
    const { result, waited } = await settleDuringDecision(decision, () =>
      settlePosOverrideForApproval(workerContext, chainId, now),
    );

    expect(waited, "the settle waits for the uncommitted decision").toBe(true);
    expect(result?.status).toBe("approved");
    expect(await overrideRow(pending.id)).toMatchObject({
      status: "approved",
      approved_by: supervisor,
    });
    expect(await recordedEvents(pending.id)).toEqual(["pos_override.recorded"]);
    expect((await chainOf(chainId)).map((row) => row.status)).toEqual([
      "approved",
    ]);
  });

  it("past the deadline with no decision the override expires, the request is expired and a late inbox decision is refused", async () => {
    const cashier = await createUser("cashier", bandung);
    const supervisor = await createUser("supervisor", bandung);
    const pending = await phoneOverride(cashier);
    const chainId = pending.approvalRequestId!;

    const settled = await settlePosOverrideForApproval(
      workerContext,
      chainId,
      await afterDeadline(chainId),
    );

    expect(settled?.status).toBe("expired");
    expect(await overrideRow(pending.id)).toMatchObject({
      status: "expired",
      approved_by: null,
    });
    expect(await recordedEvents(pending.id)).toEqual([]);
    expect((await chainOf(chainId)).map((row) => row.status)).toEqual([
      "expired",
    ]);
    await expect(
      decideApprovalRequest(
        tenant,
        supervisor,
        chainId,
        { decision: "approved", reason: "Sesuai bukti transaksi." },
        { mfaVerified: true, idempotencyKey: null },
      ),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUEST_EXPIRED" });
    expect(await overrideRow(pending.id)).toMatchObject({ status: "expired" });
  });
});

describe("approval expiry race: stock count", () => {
  it("an inbox approval already in flight wins over the deadline: the count posts its adjustment", async () => {
    const counter = await createUser("warehouse", outletA);
    const approver = await createUser("outlet_manager", outletA);
    const prepared = await seedCountedStock(counter, "6.0000");
    const approval = await countApproval(prepared.countId);
    const now = await afterDeadline(approval.chain_id);

    const decision = await startInboxDecision(approval.chain_id, approver);
    const { result, waited } = await settleDuringDecision(decision, () =>
      postCount(approver, prepared.countId, now),
    );

    expect(waited, "the settle waits for the uncommitted decision").toBe(true);
    expect(result.status).toBe("posted");
    expect(await countStatus(prepared.countId)).toBe("posted");
    expect(await ledgerOf(prepared.countId)).toHaveLength(1);
    expect(await balanceOf(prepared.locationId, prepared.itemId)).toBe(
      "6.0000",
    );
    expect((await chainOf(approval.chain_id)).map((row) => row.status)).toEqual(
      ["approved"],
    );
  });

  it("past the deadline with no decision the count returns to counting, the request is closed and a late inbox decision is refused", async () => {
    const counter = await createUser("warehouse", outletA);
    const approver = await createUser("outlet_manager", outletA);
    const prepared = await seedCountedStock(counter, "7.0000");
    const approval = await countApproval(prepared.countId);

    const settled = await postCount(
      approver,
      prepared.countId,
      await afterDeadline(approval.chain_id),
    );

    expect(settled.status).toBe("counting");
    expect(await ledgerOf(prepared.countId)).toEqual([]);
    expect(await balanceOf(prepared.locationId, prepared.itemId)).toBe(
      "10.0000",
    );
    expect((await chainOf(approval.chain_id)).map((row) => row.status)).toEqual(
      ["expired"],
    );
    await expect(
      decideApprovalRequest(
        tenant,
        approver,
        approval.chain_id,
        { decision: "approved", reason: "Disetujui dari kotak approval." },
        { mfaVerified: true, idempotencyKey: null },
      ),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUEST_EXPIRED" });
    expect(await countStatus(prepared.countId)).toBe("counting");
  });

  it("a reject races an inbox approval already in flight: the reject waits for the chain lock, sees the approval and settles nothing (legend-2tcj)", async () => {
    const counter = await createUser("warehouse", outletA);
    const approver = await createUser("outlet_manager", outletA);
    const prepared = await seedCountedStock(counter, "6.0000");
    const approval = await countApproval(prepared.countId);
    // Past the deadline the reject skips decideApprovalRequest and settles
    // itself, so only the chain lock can order it against the inbox decision.
    const now = await afterDeadline(approval.chain_id);

    const decision = await startInboxDecision(approval.chain_id, approver);
    const { result, waited } = await settleDuringDecision(decision, () =>
      rejectCount(approver, prepared.countId, now).then(
        (count) => count,
        (error: unknown) => error,
      ),
    );

    expect(waited, "the reject waits for the uncommitted decision").toBe(true);
    expect(result).toMatchObject({ code: "STOCK_COUNT_INVALID_TRANSITION" });
    expect(await countStatus(prepared.countId)).toBe("pending_approval");
    expect(await ledgerOf(prepared.countId)).toEqual([]);
    expect((await chainOf(approval.chain_id)).map((row) => row.status)).toEqual(
      ["approved"],
    );
  });

  it("a level-1 approval in flight that opens level 2 keeps the count pending: the overdue level 1 is not expired", async () => {
    await withTwoLevelPolicy(async () => {
      const counter = await createUser("warehouse", outletA);
      const approver = await createUser("outlet_manager", outletA);
      const prepared = await seedCountedStock(counter, "6.0000");
      const approval = await countApproval(prepared.countId);
      expect(
        (await chainOf(approval.chain_id)).length,
        "the chain starts with level 1 only",
      ).toBe(1);
      const now = await afterDeadline(approval.chain_id);

      const decision = await startInboxDecision(approval.chain_id, approver, {
        opensLevelTwo: true,
      });
      // The count cannot post yet, so the settle may return the count or
      // refuse; either way it must not expire or move the count.
      const { waited } = await settleDuringDecision(decision, () =>
        postCount(approver, prepared.countId, now).then(
          (count) => count,
          (error: unknown) => error,
        ),
      );

      expect(waited, "the settle waits for the uncommitted decision").toBe(
        true,
      );
      expect(await countStatus(prepared.countId)).toBe("pending_approval");
      expect(await ledgerOf(prepared.countId)).toEqual([]);
      expect(await balanceOf(prepared.locationId, prepared.itemId)).toBe(
        "10.0000",
      );
      expect(
        (await chainOf(approval.chain_id)).map((row) => row.status),
      ).toEqual(["approved", "pending"]);
    });
  });
});
