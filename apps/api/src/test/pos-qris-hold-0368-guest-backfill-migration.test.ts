// Fail-first migration test for legend-eh9i4 card A2 (docs/briefs/sub-codex-money.md):
// migration 0368 (QRIS hold table + backfill) is edited IN PLACE (it is not on
// m1 yet, no new number). Its backfill must also cover guest (split) QRIS
// intents, and it must FAIL the migration when one bill has more than one
// collectible QR.
//
// Pattern: like order-issue-charge-cash-migration.test.ts, the migration text is
// read from drizzle/ and its backfill statements are applied inside a
// transaction that is rolled back. The state before the backfill is simulated
// by removing the holds the running code opened (session_replication_role =
// replica switches triggers off inside the rolled-back transaction).
//
// Assumptions (the brief names the behavior, not the SQL):
// - "Backfill statements" = every statement of 0368 from the first
//   `NO FORCE ROW LEVEL SECURITY` up to (not including) the first statement that
//   restores `FORCE ROW LEVEL SECURITY`. Splitting on `--> statement-breakpoint`.
// - A guest split QR is a `payment_intents` row with `bill_split_id` set and a
//   status other than paid/expired, referenced by `bill_splits.payment_intent_id`.
//   Its hold: one `pos_qris_holds` row with that `payment_intent_id` and
//   `bill_split_id`, state `open`, `backfilled = true`, amount = intent amount.
// - The failing guard is judged by "the migration statements raise an error";
//   the message wording is not pinned (the existing POS guard says
//   "QRIS hold backfill: more than one ...").
// - Out of scope here: `db:generate` empty / drizzle/meta consistency (checked
//   by the heavy runner, not by this file). The journal check below only pins
//   that 0368 is still the single entry of that tag.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/pos-qris-hold-0368-guest-backfill-migration.test.ts" pnpm test
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import { owner } from "./floor-test-helpers.ts";
import { secretFor } from "./payer-secret-helpers.ts";
import {
  holdFixture,
  issueQris,
  newSubmittedOrder,
  resetHoldPorts,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";

vi.setConfig({ testTimeout: 120_000 });

const TAG = "0401_pos_qris_holds";
const sql0368 = readFileSync(
  new URL(`../../drizzle/${TAG}.sql`, import.meta.url),
  "utf8",
);
const statements = sql0368
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

/** The data-backfill part of 0368 (see the assumption above). */
const backfill = (() => {
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
})();

let fx: HoldFixture;
beforeAll(async () => {
  fx = await holdFixture("qris-hold-0368-guest-backfill");
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

/** Guest bill split in two; the first part has a QR (201). */
async function guestSplitWithQr() {
  const guest = await fx.newGuest();
  const order = await fx.qrOrder(guest);
  expect(order.totalIdr).toBe(33_000);
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
  const { rows } = await owner.query<{ id: string; amount_idr: string }>(
    `SELECT id::text AS id, amount_idr::text FROM payment_intents
      WHERE tenant_id=$1 AND bill_split_id=$2`,
    [fx.tenant.tenantId, parts[0]!.id],
  );
  expect(rows).toHaveLength(1);
  return {
    orderId: ulidToUuid(order.id),
    parts,
    intentId: rows[0]!.id,
    intentAmount: Number(rows[0]!.amount_idr),
  };
}

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

/** The database as it was before the backfill ran: no holds at all. The
 *  backfill statements are not tenant-scoped, so holds that other test files
 *  committed (in a combined run) must go too, or the backfill would insert a
 *  second hold for their intents. Rolled back with the transaction. */
async function removeHolds(client: PoolClient) {
  // Block writers from other test files running in parallel: one that commits a
  // hold for a pending intent after the DELETE would make the backfill insert a
  // duplicate. Released by the ROLLBACK.
  await client.query("LOCK TABLE pos_qris_holds IN EXCLUSIVE MODE");
  await client.query("SET LOCAL session_replication_role = replica");
  await client.query("DELETE FROM pos_qris_holds");
  await client.query("SET LOCAL session_replication_role = origin");
}

async function runBackfill(client: PoolClient) {
  for (const statement of backfill) await client.query(statement);
}

/** Set (or clear, with null) the provider reference of an intent. The backfill
 *  only counts and freezes guest intents that have one. */
async function setProviderRef(
  client: PoolClient,
  intentId: string,
  ref: string | null,
) {
  await client.query(
    `UPDATE payment_intents SET provider_ref=$3 WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, intentId, ref],
  );
}

/** A second collectible QR on the same bill: a copy of the first intent that
 *  belongs to the second part of the split. */
async function cloneIntentOntoPart(
  client: PoolClient,
  intentId: string,
  partId: string,
) {
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
      : name === "bill_split_id"
        ? "$3::uuid"
        : name === "idempotency_key"
          ? "'0419-clone-' || gen_random_uuid()::text"
          : name === "provider_ref"
            ? "'0419-clone-ref-' || gen_random_uuid()::text"
            : `"${name}"`;
  const cloned = await client.query<{ id: string }>(
    `INSERT INTO payment_intents (${cols.map((n) => `"${n}"`).join(",")})
     SELECT ${cols.map(copy).join(",")}
       FROM payment_intents WHERE tenant_id=$1 AND id=$2
     RETURNING id::text AS id`,
    [fx.tenant.tenantId, intentId, partId],
  );
  await client.query(
    `UPDATE bill_splits SET payment_intent_id=$3 WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, partId, cloned.rows[0]!.id],
  );
}

describe("legend-eh9i4 A2 migration 0368 guest QRIS backfill", () => {
  it("0368 is still one journal entry and its backfill part is found", () => {
    const journal = JSON.parse(
      readFileSync(
        new URL("../../drizzle/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ) as { entries: { tag: string }[] };
    expect(journal.entries.filter((e) => e.tag === TAG)).toHaveLength(1);
    expect(backfill.length).toBeGreaterThan(0);
    expect(backfill.join("\n")).toMatch(/pos_qris_holds/);
  });

  it("legend-eh9i4 backfill gives a guest split QR (intent with bill_split_id, not paid) an open backfilled hold", async () => {
    const qr = await guestSplitWithQr();
    await inRolledBackTx(async (client) => {
      await removeHolds(client);
      await setProviderRef(client, qr.intentId, `0419-ref-${randomUUID()}`);
      await runBackfill(client);
      const { rows } = await client.query<{
        order_id: string;
        bill_split_id: string | null;
        state: string;
        backfilled: boolean;
        amount_idr: string;
      }>(
        `SELECT order_id::text, bill_split_id::text, state, backfilled, amount_idr::text
           FROM pos_qris_holds WHERE tenant_id=$1 AND payment_intent_id=$2`,
        [fx.tenant.tenantId, qr.intentId],
      );
      expect(
        rows,
        "the guest split QR must get exactly one hold from the backfill",
      ).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        order_id: qr.orderId,
        bill_split_id: qr.parts[0]!.id,
        state: "open",
        backfilled: true,
      });
      expect(Number(rows[0]!.amount_idr)).toBe(qr.intentAmount);
    });
  });

  it("legend-eh9i4 backfill fails the migration when one bill has more than one collectible guest QR", async () => {
    const qr = await guestSplitWithQr();
    await inRolledBackTx(async (client) => {
      await removeHolds(client);
      await setProviderRef(client, qr.intentId, `0419-ref-${randomUUID()}`);
      await cloneIntentOntoPart(client, qr.intentId, qr.parts[1]!.id);
      // Two collectible QRs on one bill: the money cannot be frozen safely.
      await client.query("SAVEPOINT before_backfill");
      let raised: unknown = null;
      try {
        await runBackfill(client);
      } catch (error) {
        raised = error;
      }
      expect(
        raised,
        "the backfill must raise when a bill has more than one collectible QR",
      ).not.toBeNull();
      await client.query("ROLLBACK TO SAVEPOINT before_backfill");
    });
  });

  it("legend-eh9i4 backfill skips a guest intent without provider_ref: no hold and it does not trip the one-QR guard", async () => {
    const qr = await guestSplitWithQr();
    await inRolledBackTx(async (client) => {
      await removeHolds(client);
      await setProviderRef(client, qr.intentId, `0419-ref-${randomUUID()}`);
      // The second QR on the bill has no provider_ref: it must not be counted.
      await cloneIntentOntoPart(client, qr.intentId, qr.parts[1]!.id);
      await client.query(
        `UPDATE payment_intents SET provider_ref=NULL
          WHERE tenant_id=$1 AND bill_split_id=$2`,
        [fx.tenant.tenantId, qr.parts[1]!.id],
      );
      await runBackfill(client);
      const { rows } = await client.query<{
        payment_intent_id: string;
        bill_split_id: string | null;
      }>(
        `SELECT payment_intent_id::text, bill_split_id::text
           FROM pos_qris_holds WHERE tenant_id=$1 AND order_id=$2`,
        [fx.tenant.tenantId, qr.orderId],
      );
      expect(
        rows,
        "only the intent with a provider_ref gets a hold; the one without gets none",
      ).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        payment_intent_id: qr.intentId,
        bill_split_id: qr.parts[0]!.id,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// so-879 ota0l: the backfill must also hold every provider code that may still
// be collectible although the system stopped collecting it locally (voided POS
// tender, expired or superseded split code), on bills that are not final yet.

/** Plain writes to history rows, with the guard triggers off (rolled back). */
async function rawHistory(client: PoolClient, text: string, params: unknown[]) {
  await client.query("SET LOCAL session_replication_role = replica");
  await client.query(text, params);
  await client.query("SET LOCAL session_replication_role = origin");
}

async function expireIntent(client: PoolClient, intentId: string) {
  await rawHistory(
    client,
    `UPDATE payment_intents SET status='expired', provider_ref=coalesce(provider_ref, $3)
      WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, intentId, `879-ref-${randomUUID()}`],
  );
}

/** A POS QRIS bill whose tender the system voided locally while the provider
 *  code was never cancelled: tender voided, intent still pending at the provider. */
async function voidedTenderWithLiveCode() {
  const order = await newSubmittedOrder(fx);
  const qr = await issueQris(fx, order.id);
  return {
    orderId: ulidToUuid(order.id),
    tenderId: qr.tenderId,
    intentId: qr.intentId,
    amountIdr: qr.amountIdr,
  };
}

async function voidTenderLocally(
  client: PoolClient,
  tenderId: string,
  intentId: string,
) {
  await rawHistory(
    client,
    `UPDATE pos_order_tenders SET status='voided', resolved_at=now()
      WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, tenderId],
  );
  await setProviderRef(client, intentId, `879-ref-${randomUUID()}`);
}

async function holdsOfOrder(client: PoolClient, orderId: string) {
  const { rows } = await client.query<{
    payment_intent_id: string;
    tender_id: string | null;
    bill_split_id: string | null;
    state: string;
    backfilled: boolean;
    amount_idr: string;
    next_check_at: Date | null;
  }>(
    `SELECT payment_intent_id::text, tender_id::text, bill_split_id::text, state,
            backfilled, amount_idr::text, next_check_at
       FROM pos_qris_holds WHERE tenant_id=$1 AND order_id=$2
      ORDER BY payment_intent_id`,
    [fx.tenant.tenantId, orderId],
  );
  return rows;
}

describe("so-879 ota0l backfill of ambiguous provider codes", () => {
  it("the per-bill unique index only counts non-backfilled active holds", async () => {
    const { rows } = await owner.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename='pos_qris_holds' AND indexname='pos_qris_holds_active_order_key'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toMatch(/NOT backfilled/i);
    expect(sql0368).toMatch(/AND NOT "pos_qris_holds"\."backfilled"/);
  });

  it("a voided POS tender whose provider code is not proven dead gets an open backfilled hold", async () => {
    const bill = await voidedTenderWithLiveCode();
    await inRolledBackTx(async (client) => {
      await removeHolds(client);
      await voidTenderLocally(client, bill.tenderId, bill.intentId);
      await runBackfill(client);
      const holds = await holdsOfOrder(client, bill.orderId);
      expect(
        holds,
        "the voided tender's live provider code must freeze the bill",
      ).toHaveLength(1);
      expect(holds[0]).toMatchObject({
        payment_intent_id: bill.intentId,
        tender_id: bill.tenderId,
        state: "open",
        backfilled: true,
      });
      expect(Number(holds[0]!.amount_idr)).toBe(bill.amountIdr);
      expect(holds[0]!.next_check_at).not.toBeNull();
    });
  });

  it("an expired (superseded) provider code of a voided tender is also held", async () => {
    const bill = await voidedTenderWithLiveCode();
    await inRolledBackTx(async (client) => {
      await removeHolds(client);
      await voidTenderLocally(client, bill.tenderId, bill.intentId);
      await expireIntent(client, bill.intentId);
      await runBackfill(client);
      const holds = await holdsOfOrder(client, bill.orderId);
      expect(holds).toHaveLength(1);
      expect(holds[0]).toMatchObject({
        payment_intent_id: bill.intentId,
        state: "open",
        backfilled: true,
      });
    });
  });

  it("a provider code that failed or has no provider_ref is not held", async () => {
    const bill = await voidedTenderWithLiveCode();
    await inRolledBackTx(async (client) => {
      await removeHolds(client);
      await voidTenderLocally(client, bill.tenderId, bill.intentId);
      await rawHistory(
        client,
        `UPDATE payment_intents SET status='failed' WHERE tenant_id=$1 AND id=$2`,
        [fx.tenant.tenantId, bill.intentId],
      );
      await runBackfill(client);
      expect(await holdsOfOrder(client, bill.orderId)).toHaveLength(0);
    });
    await inRolledBackTx(async (client) => {
      await removeHolds(client);
      await voidTenderLocally(client, bill.tenderId, bill.intentId);
      await setProviderRef(client, bill.intentId, null);
      await runBackfill(client);
      expect(await holdsOfOrder(client, bill.orderId)).toHaveLength(0);
    });
  });

  it("a final bill is skipped: no hold for its voided tender or expired split code", async () => {
    const bill = await voidedTenderWithLiveCode();
    const qr = await guestSplitWithQr();
    await inRolledBackTx(async (client) => {
      await removeHolds(client);
      await voidTenderLocally(client, bill.tenderId, bill.intentId);
      await expireIntent(client, qr.intentId);
      for (const orderId of [bill.orderId, qr.orderId])
        await rawHistory(
          client,
          `UPDATE orders SET status='completed' WHERE tenant_id=$1 AND id=$2`,
          [fx.tenant.tenantId, orderId],
        );
      await runBackfill(client);
      expect(await holdsOfOrder(client, bill.orderId)).toHaveLength(0);
      expect(await holdsOfOrder(client, qr.orderId)).toHaveLength(0);
    });
  });

  it("an expired split code gets an open backfilled hold with its bill_split_id", async () => {
    const qr = await guestSplitWithQr();
    await inRolledBackTx(async (client) => {
      await removeHolds(client);
      await expireIntent(client, qr.intentId);
      await runBackfill(client);
      const holds = await holdsOfOrder(client, qr.orderId);
      expect(holds).toHaveLength(1);
      expect(holds[0]).toMatchObject({
        payment_intent_id: qr.intentId,
        tender_id: null,
        bill_split_id: qr.parts[0]!.id,
        state: "open",
        backfilled: true,
      });
      expect(Number(holds[0]!.amount_idr)).toBe(qr.intentAmount);
    });
  });

  it("two ambiguous codes on one bill each get a hold and the one-collectible guard stays quiet", async () => {
    const qr = await guestSplitWithQr();
    await inRolledBackTx(async (client) => {
      await removeHolds(client);
      await setProviderRef(client, qr.intentId, `879-ref-${randomUUID()}`);
      await cloneIntentOntoPart(client, qr.intentId, qr.parts[1]!.id);
      await rawHistory(
        client,
        `UPDATE payment_intents SET status='expired'
          WHERE tenant_id=$1 AND bill_split_id IN ($2, $3)`,
        [fx.tenant.tenantId, qr.parts[0]!.id, qr.parts[1]!.id],
      );
      await runBackfill(client);
      const holds = await holdsOfOrder(client, qr.orderId);
      expect(holds).toHaveLength(2);
      expect(holds.every((h) => h.backfilled && h.state === "open")).toBe(true);
      expect(new Set(holds.map((h) => h.payment_intent_id)).size).toBe(2);
    });
  });

  it("one collectible code plus one ambiguous code on a bill: both held, the guard counts only the collectible", async () => {
    const qr = await guestSplitWithQr();
    await inRolledBackTx(async (client) => {
      await removeHolds(client);
      await setProviderRef(client, qr.intentId, `879-ref-${randomUUID()}`);
      await cloneIntentOntoPart(client, qr.intentId, qr.parts[1]!.id);
      await rawHistory(
        client,
        `UPDATE payment_intents SET status='expired'
          WHERE tenant_id=$1 AND bill_split_id=$2`,
        [fx.tenant.tenantId, qr.parts[1]!.id],
      );
      await runBackfill(client);
      expect(await holdsOfOrder(client, qr.orderId)).toHaveLength(2);
    });
  });

  it("running the backfill twice does not duplicate a hold per intent", async () => {
    const qr = await guestSplitWithQr();
    await inRolledBackTx(async (client) => {
      await removeHolds(client);
      await expireIntent(client, qr.intentId);
      await runBackfill(client);
      await client.query("SAVEPOINT again");
      let raised = false;
      try {
        await runBackfill(client);
      } catch {
        raised = true;
      }
      if (raised) await client.query("ROLLBACK TO SAVEPOINT again");
      expect(await holdsOfOrder(client, qr.orderId)).toHaveLength(1);
    });
  });
});
