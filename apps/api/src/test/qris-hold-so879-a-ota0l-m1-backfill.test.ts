// legend-ota0l (SO-879 second opinion, card A): the cutover must not silently
// skip a provider QR code that may still be collectible. On m1 a cashier can
// replace a QR with cash: the tender is voided and the link closed LOCALLY, the
// provider code stays alive; a guest split can expire locally the same way; a
// superseded guest code is only "expired" in our books.
//
// Written from docs/briefs/so-879-qris-hold-fix.md (CTO decision) and the first
// finding of docs/qa/second-opinion-qris-hold.md:
// "migration/cutover creates a hold for every provider code that may still be
//  collectible (tender void locally, link/split expired locally, intent
//  superseded) until the provider proves it dead. Do not skip ambiguous history."
//
// Pattern of pos-qris-hold-0368-guest-backfill-migration.test.ts: the backfill
// statements of the QRIS hold migration are applied inside a transaction that is
// rolled back, after the database is put into the m1 shape (no holds, local
// void/expiry). `session_replication_role = replica` only switches triggers off
// while the m1 shape is built; the backfill itself runs with triggers on.
//
// Assumptions (the brief names behavior, not SQL):
// - "Backfill statements" = every statement of the QRIS hold migration from the
//   first `NO FORCE ROW LEVEL SECURITY` up to the statement that restores
//   `FORCE ROW LEVEL SECURITY` (same as the sibling test). The migration is
//   edited in place (tag 0401) per the brief; if the engineer moves the new rule
//   to a later migration, add its tag to EXTRA_TAGS below.
// - A code is "ambiguous" when its intent has a provider_ref, is not paid, and
//   nothing proves the provider closed it. The m1 shape marks the intent
//   `expired` or leaves it `pending` with its link closed; both are tested.
// - A held code = one `pos_qris_holds` row with that payment_intent_id,
//   state `open`, `backfilled = true`, amount = intent amount.
// - One ambiguous code on a bill must be HELD (the migration must not raise).
//   Two or more ambiguous codes on one bill: either every one is held or the
//   migration raises (cutover refuses until reconciliation, the finding allows
//   both). Never: no raise and a code without a hold.
// - The freeze is judged by the DB trigger: a DP write on the bill is refused
//   with QRIS_HOLD_ACTIVE after the backfill (same refusal as QH-20).
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/qris-hold-so879-a-ota0l-m1-backfill.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tenantIdSchema, ulidToUuid, userIdSchema } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { setStaffPin } from "../services/device-pin.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { owner } from "./floor-test-helpers.ts";
import { agent, signUp } from "./helpers.ts";
import { secretFor } from "./payer-secret-helpers.ts";
import {
  HOLD_RELEASE_AFTER_MIN,
  holdFixture,
  issueQris,
  newSubmittedOrder,
  payNotice,
  postRelease,
  resetHoldPorts,
  type HoldFixture,
  type ManagerApproval,
} from "./pos-qris-hold-test-helpers.ts";

vi.setConfig({ testTimeout: 120_000 });

const TAG = "0401_pos_qris_holds";
const EXTRA_TAGS: string[] = [];
const BILL_IDR = 33_000;
const SUPERVISOR_PIN = "582914";

function backfillOf(tag: string): string[] {
  const statements = readFileSync(
    new URL(`../../drizzle/${tag}.sql`, import.meta.url),
    "utf8",
  )
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
  const from = statements.findIndex((s) =>
    /NO FORCE ROW LEVEL SECURITY/i.test(s),
  );
  const to = statements.findIndex(
    (s, i) =>
      i > from &&
      /\bFORCE ROW LEVEL SECURITY/i.test(s) &&
      !/NO FORCE ROW LEVEL SECURITY/i.test(s),
  );
  return from >= 0 && to > from ? statements.slice(from, to) : [];
}
const backfill = [TAG, ...EXTRA_TAGS].flatMap(backfillOf);

let fx: HoldFixture;
beforeAll(async () => {
  fx = await holdFixture("qris-hold-so879-ota0l");
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

async function inRolledBackTx(work: (client: PoolClient) => Promise<void>) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [fx.tenant.tenantId],
    );
    await work(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/** The database as m1 left it: no holds at all (also those other files
 * committed, the statements are not tenant scoped). Rolled back with the tx. */
async function removeHolds(client: PoolClient) {
  await client.query("LOCK TABLE pos_qris_holds IN EXCLUSIVE MODE");
  await client.query("SET LOCAL session_replication_role = replica");
  await client.query("DELETE FROM pos_qris_holds");
  await client.query("SET LOCAL session_replication_role = origin");
}

async function asM1<T>(client: PoolClient, work: () => Promise<T>) {
  await client.query("SET LOCAL session_replication_role = replica");
  try {
    return await work();
  } finally {
    await client.query("SET LOCAL session_replication_role = origin");
  }
}

async function runBackfill(client: PoolClient) {
  for (const statement of backfill) await client.query(statement);
}

/** Runs the backfill; a raise is reported, not thrown, and undone. */
async function tryBackfill(client: PoolClient) {
  await client.query("SAVEPOINT before_backfill");
  try {
    await runBackfill(client);
    await client.query("RELEASE SAVEPOINT before_backfill");
    return { raised: false as const };
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT before_backfill");
    return { raised: true as const, message: String(error) };
  }
}

type HoldRow = {
  payment_intent_id: string;
  state: string;
  backfilled: boolean;
  amount_idr: number;
  bill_split_id: string | null;
};
async function holdsOfOrder(client: PoolClient, orderUuid: string) {
  const { rows } = await client.query<HoldRow>(
    `SELECT payment_intent_id::text, state, backfilled, amount_idr::int AS amount_idr,
            bill_split_id::text
       FROM pos_qris_holds WHERE tenant_id=$1 AND order_id=$2 ORDER BY opened_at, id`,
    [fx.tenant.tenantId, orderUuid],
  );
  return rows;
}

function expectHeld(rows: HoldRow[], intentId: string, amountIdr: number) {
  const mine = rows.filter((r) => r.payment_intent_id === intentId);
  expect(
    mine,
    `provider code ${intentId} may still be collectible: it needs exactly one hold`,
  ).toHaveLength(1);
  expect(mine[0]).toMatchObject({ state: "open", backfilled: true });
  expect(mine[0]!.amount_idr).toBe(amountIdr);
}

async function expectBillFrozen(client: PoolClient, orderUuid: string) {
  await client.query("SAVEPOINT freeze_probe");
  let refused = "";
  try {
    await client.query(
      "UPDATE orders SET deposit_applied_idr=10000 WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, orderUuid],
    );
  } catch (error) {
    refused = String((error as Error).message);
  }
  await client.query("ROLLBACK TO SAVEPOINT freeze_probe");
  expect(
    refused,
    "the bill must be frozen (QRIS_HOLD_ACTIVE) while the old code may be paid",
  ).toContain("QRIS_HOLD_ACTIVE");
}

let supervisorUserId: string | null = null;
async function supervisor(): Promise<string> {
  if (supervisorUserId) return supervisorUserId;
  const client = agent(fx.app);
  await signUp(client, "Manajer Backfill QRIS");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Manajer QRIS Uji', true, 'supervisor', $3, false, '["tenant"]')`,
    [
      roleId,
      fx.tenant.tenantId,
      JSON.stringify(["order.view", "pos.void.approve"]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [fx.tenant.tenantId, userId, roleId],
  );
  await setStaffPin(
    tenantContext(),
    userId,
    { outletId: fx.tenant.outletId, userId },
    { pin: SUPERVISOR_PIN },
  );
  supervisorUserId = userId;
  return userId;
}

function tenantContext() {
  return establishTenantContext({
    tenantId: tenantIdSchema.parse(fx.tenant.tenantId),
    brandId: null,
    source: "session",
  });
}

/** Approved manager PIN override (pos-overrides flow), requested by the cashier. */
async function managerApproval(
  orderId: string,
  valueIdr: number,
): Promise<ManagerApproval> {
  const approver = await supervisor();
  const { override } = await createPosOverride(
    tenantContext(),
    fx.staff.userId,
    {
      outletId: fx.tenant.outletId,
      action: "void",
      valueIdr,
      reason: "Penyedia QRIS tidak merespons",
      objectType: "order",
      objectId: orderId,
      approval: {
        method: "supervisor_pin",
        approverUserId: userIdSchema.parse(approver),
        pin: SUPERVISOR_PIN,
      },
    } as Parameters<typeof createPosOverride>[2],
    { idempotencyKey: randomUUID() },
  );
  expect(override.status).toBe("approved");
  return { approvedBy: approver, overrideId: override.id };
}

// ---- m1 shapes ------------------------------------------------------------

/** m1: the cashier replaced the QR with cash. Tender voided, link closed, the
 * provider code untouched. `intentStatus` is how m1 left the local intent. */
async function posQrVoidedLocally(
  client: PoolClient,
  qr: Awaited<ReturnType<typeof issueQris>>,
  intentStatus: "pending" | "expired",
) {
  await removeHolds(client);
  await asM1(client, async () => {
    await client.query(
      `UPDATE pos_order_tenders SET status='voided', resolved_at=now()
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, qr.tenderId],
    );
    await client.query(
      `UPDATE payment_intents SET status=$3
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, qr.intentId, intentStatus],
    );
    await client.query(
      `UPDATE payment_links SET expires_at = now() - interval '1 minute'
        WHERE tenant_id=$1 AND id=(SELECT payment_link_id FROM payment_intents
                                    WHERE tenant_id=$1 AND id=$2)`,
      [fx.tenant.tenantId, qr.intentId],
    );
  });
}

async function guestSplitWithQr() {
  const guest = await fx.newGuest();
  const order = await fx.qrOrder(guest);
  expect(order.totalIdr).toBe(BILL_IDR);
  const split = await fx.guestPost(guest, "/splits", {
    method: "equal",
    parts: 2,
    idempotencyKey: randomUUID(),
  });
  expect(split.status, JSON.stringify(split.body)).toBe(201);
  const parts = split.body.data.splits as { id: string; amountIdr: number }[];
  const paid = await fx.guestPost(guest, "/payments", {
    target: { kind: "split", billSplitId: parts[0]!.id },
    method: "qris",
    payerSecret: secretFor(parts[0]!.id),
    idempotencyKey: randomUUID(),
  });
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  const { rows } = await owner.query<{ id: string; amount_idr: number }>(
    `SELECT id::text AS id, amount_idr::int AS amount_idr FROM payment_intents
      WHERE tenant_id=$1 AND bill_split_id=$2`,
    [fx.tenant.tenantId, parts[0]!.id],
  );
  expect(rows).toHaveLength(1);
  expect(
    (
      await owner.query(
        `SELECT 1 FROM payment_intents WHERE id=$1 AND provider_ref IS NOT NULL`,
        [rows[0]!.id],
      )
    ).rowCount,
    "the issued split QR has a provider code",
  ).toBe(1);
  return {
    orderUuid: ulidToUuid(order.id),
    parts,
    intentId: rows[0]!.id,
    amountIdr: rows[0]!.amount_idr,
  };
}

/** Pay-first guest bill with one order-wide QR (code A). */
async function guestOrderWithQr() {
  const guest = await fx.newGuest();
  const order = await fx.qrOrder(guest);
  expect(order.totalIdr).toBe(BILL_IDR);
  const paid = await fx.guestPost(guest, "/payments", {
    target: { kind: "order", orderId: order.id },
    method: "qris",
    idempotencyKey: randomUUID(),
  });
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  const intentId = paid.body.data.id as string;
  return { orderUuid: ulidToUuid(order.id), intentId, amountIdr: BILL_IDR };
}

// ---- tests ----------------------------------------------------------------

describe("legend-ota0l cutover holds every provider code that may still be collectible", () => {
  it("legend-ota0l the migration file is found and its backfill part is not empty", () => {
    expect(backfill.length).toBeGreaterThan(0);
    expect(backfill.join("\n")).toMatch(/pos_qris_holds/);
  });

  for (const intentStatus of ["pending", "expired"] as const) {
    it(`legend-ota0l POS: QR tender voided locally (intent ${intentStatus}, link closed), provider code alive -> open backfilled hold; the bill is frozen`, async () => {
      const order = await newSubmittedOrder(fx, 0);
      const qr = await issueQris(fx, order.id);
      expect(qr.providerRef).toBeTruthy();
      const orderUuid = ulidToUuid(order.id);
      await inRolledBackTx(async (client) => {
        await posQrVoidedLocally(client, qr, intentStatus);
        const outcome = await runBackfillAndExpectNoRaise(client);
        expect(outcome.raised).toBe(false);
        expectHeld(
          await holdsOfOrder(client, orderUuid),
          qr.intentId,
          BILL_IDR,
        );
        await expectBillFrozen(client, orderUuid);
      });
    });
  }

  it("legend-ota0l guest split: split QR expired locally (intent and link), provider code alive -> open backfilled hold on that split", async () => {
    const split = await guestSplitWithQr();
    await inRolledBackTx(async (client) => {
      await removeHolds(client);
      await asM1(client, async () => {
        await client.query(
          `UPDATE payment_intents SET status='expired', expires_at = now() - interval '1 minute'
            WHERE tenant_id=$1 AND id=$2`,
          [fx.tenant.tenantId, split.intentId],
        );
        await client.query(
          `UPDATE payment_links SET expires_at = now() - interval '1 minute'
            WHERE tenant_id=$1 AND id=(SELECT payment_link_id FROM payment_intents
                                        WHERE tenant_id=$1 AND id=$2)`,
          [fx.tenant.tenantId, split.intentId],
        );
      });
      const outcome = await tryBackfill(client);
      expect(
        outcome.raised,
        `a single ambiguous split code must be held, not refused: ${"message" in outcome ? outcome.message : ""}`,
      ).toBe(false);
      const holds = await holdsOfOrder(client, split.orderUuid);
      expectHeld(holds, split.intentId, split.amountIdr);
      expect(
        holds.find((h) => h.payment_intent_id === split.intentId),
      ).toMatchObject({ bill_split_id: split.parts[0]!.id });
      await expectBillFrozen(client, split.orderUuid);
    });
  });

  it("legend-ota0l guest order: code A superseded by code B (A only 'expired' in our books) -> A is not skipped: held, or the cutover refuses until reconciled", async () => {
    const guestOrder = await guestOrderWithQr();
    await inRolledBackTx(async (client) => {
      await removeHolds(client);
      // m1: A expired locally as "superseded"; B is the live replacement.
      await asM1(client, async () => {
        await cloneIntent(client, guestOrder.intentId);
        await client.query(
          `UPDATE payment_intents SET status='expired', expires_at = now() - interval '1 minute'
            WHERE tenant_id=$1 AND id=$2`,
          [fx.tenant.tenantId, guestOrder.intentId],
        );
      });
      const outcome = await tryBackfill(client);
      if (outcome.raised) return; // cutover refuses until reconciliation: allowed
      expectHeld(
        await holdsOfOrder(client, guestOrder.orderUuid),
        guestOrder.intentId,
        guestOrder.amountIdr,
      );
      await expectBillFrozen(client, guestOrder.orderUuid);
    });
  });

  it("legend-ota0l POS: voided QR A and a live QR B on the same bill -> no silent skip: both held, or the cutover refuses", async () => {
    // Natural m1-like state built through the services: A issued, then
    // released by a manager (tender A voided, link closed, hold closed, the
    // provider code untouched); B issued afterwards (allowed, hold closed).
    const order = await newSubmittedOrder(fx, 0);
    const qrA = await issueQris(fx, order.id);
    await owner.query(
      `UPDATE payment_intents SET expires_at = now() - $3::int * interval '1 minute'
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, qrA.intentId, HOLD_RELEASE_AFTER_MIN + 1],
    );
    const approval = await managerApproval(order.id, BILL_IDR);
    const released = await postRelease(fx, order.id, approval);
    expect(released.status, JSON.stringify(released.body)).toBeLessThan(300);
    const qrB = await issueQris(fx, order.id);
    expect(qrB.intentId).not.toBe(qrA.intentId);
    const orderUuid = ulidToUuid(order.id);
    await inRolledBackTx(async (client) => {
      await removeHolds(client);
      const outcome = await tryBackfill(client);
      if (outcome.raised) return;
      const holds = await holdsOfOrder(client, orderUuid);
      expectHeld(holds, qrA.intentId, BILL_IDR);
      expectHeld(holds, qrB.intentId, BILL_IDR);
    });
  });

  it("legend-ota0l control: voided tender whose intent never reached the provider (no provider_ref) gets no hold and does not refuse the cutover", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    const orderUuid = ulidToUuid(order.id);
    await inRolledBackTx(async (client) => {
      await posQrVoidedLocally(client, qr, "expired");
      await asM1(client, () =>
        client.query(
          `UPDATE payment_intents SET provider_ref=NULL WHERE tenant_id=$1 AND id=$2`,
          [fx.tenant.tenantId, qr.intentId],
        ),
      );
      const outcome = await tryBackfill(client);
      expect(outcome.raised).toBe(false);
      expect(
        (await holdsOfOrder(client, orderUuid)).filter(
          (h) => h.payment_intent_id === qr.intentId,
        ),
      ).toEqual([]);
    });
  });

  it("legend-ota0l control: a QR that was paid and captured is not frozen again (nothing left to collect)", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    await payNotice(fx, qr.intentId, BILL_IDR, new Date(), qr.providerRef!);
    const orderUuid = ulidToUuid(order.id);
    await inRolledBackTx(async (client) => {
      await removeHolds(client);
      const outcome = await tryBackfill(client);
      expect(outcome.raised).toBe(false);
      expect(
        (await holdsOfOrder(client, orderUuid)).filter(
          (h) => h.state === "open",
        ),
      ).toEqual([]);
    });
  });
});

async function runBackfillAndExpectNoRaise(client: PoolClient) {
  const outcome = await tryBackfill(client);
  expect(
    outcome.raised,
    `a single ambiguous code must be held, not refused: ${"message" in outcome ? outcome.message : ""}`,
  ).toBe(false);
  return outcome;
}

/** Copy of a payment_intents row on the same link with a new provider code,
 * status pending (the live replacement code). Triggers must be off (m1 shape). */
async function cloneIntent(client: PoolClient, intentId: string) {
  const cols = (
    await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='payment_intents' AND table_schema='public'
          AND is_generated='NEVER' ORDER BY ordinal_position`,
    )
  ).rows.map((r) => r.column_name);
  const copy = (name: string) =>
    name === "id"
      ? "gen_random_uuid()"
      : name === "idempotency_key"
        ? "'so879-clone-' || gen_random_uuid()::text"
        : name === "provider_ref"
          ? "'so879-clone-ref-' || gen_random_uuid()::text"
          : name === "status"
            ? "'pending'"
            : `"${name}"`;
  const cloned = await client.query<{ id: string }>(
    `INSERT INTO payment_intents (${cols.map((n) => `"${n}"`).join(",")})
     SELECT ${cols.map(copy).join(",")}
       FROM payment_intents WHERE tenant_id=$1 AND id=$2
     RETURNING id::text AS id`,
    [fx.tenant.tenantId, intentId],
  );
  return cloned.rows[0]!.id;
}
