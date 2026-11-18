// Fail-first regression tests for legend-48ft7: a refund payout role
// (cash_on_hand, customer_deposit, edc_clearing, loyalty_liability) must never
// credit an account the SALE used for service charge or tax, and the check must
// hold at POSTING time, not only when the refund facts are built.
//
// Contract is docs/briefs/sub-money-journal-refund.md section 48ft7, not the
// implementation. Required cases:
//   (1) payout map collides with a tax / service-charge account -> refused;
//   (2) mapping changed between fact build and posting -> refused, no journal row;
//   (3) an earlier refund already reversed -> still correct;
//   (4) no party paid more, outlet not at a loss.
//
// Assumptions (stated, not read from src):
// - A refused refund is "parked" with AUTO_JOURNAL_PAYLOAD_INVALID and adds no
//   journal row (same as accounting-service-charge-liability-refund.test.ts).
//   For the race cases (2, 4) the delivery must NOT throw: it parks as
//   ACCOUNT_MAPPING_MISSING with a retryable row, so the sweep can post the
//   same event once the mapping is fixed.
// - Refund tender -> payout role: cash -> cash_on_hand, edc -> edc_clearing,
//   points -> loyalty_liability. Case 1 remaps ALL four payout roles at once
//   (customer_deposit included) so it does not depend on that map; a control
//   world proves each tender posts when the mapping is clean (so a refusal can
//   only come from the collision, never from a wrong tender name).
// - Gateway refunds are NOT covered: a valid gateway refund needs a payment
//   intent plus a completed gateway refund (see accounting-auto-journal.test.ts
//   seeding), which the plain-bucket setup here cannot build; the first run
//   parked it as POSTING_AMOUNTS_MISMATCH (setup error, not the bug).
// - The race (case 2) is simulated without touching src: the pg client query
//   method is wrapped for the duration of one delivery. A probe delivery in a
//   mirror world counts how many statements read account_mappings; in the real
//   world the mapping is remapped (committed on a separate connection) right
//   BEFORE the last of those reads, i.e. after the fact builder and before the
//   posting read. If that seam never fires the test fails with an explicit
//   "seam did not fire" message instead of silently passing or failing for the
//   wrong reason. Assumption: the posting read is the last mapping read.

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { businessDateSchema } from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { retryParkedAutoJournals } from "../services/accounting-auto-journal-consumer.ts";
import { reverseJournalInTransaction } from "../services/accounting-journal.service.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  asTenant,
  balanceOf,
  BUSINESS_DATE,
  contextOf,
  createUlid,
  deliver,
  journalCount,
  linesOf,
  orderPaid,
  orderRefunded,
  owner,
  seedPosOrder,
  totalOf,
  makeWorld,
  type Role,
  type Sale,
  type World,
} from "./accounting-tax-split-helpers.ts";

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.end();
});

/** Gross 100.000, PBJT 10.000, service charge 10.000: total 120.000. */
const SERVICE_CHARGE = 10_000;
const TAX = 10_000;
const sale: Sale = {
  grossSalesIdr: 100_000,
  snapshots: { pbjt: { baseIdr: 100_000, taxIdr: TAX, rateBp: 1000 } },
};
const SALE_TOTAL = totalOf(sale) + SERVICE_CHARGE;

type Tender = "cash" | "edc" | "points";
const BUCKET = {
  cash: ["paidCashIdr", "refundCashIdr"],
  edc: ["paidEdcIdr", "refundEdcIdr"],
  points: ["paidPointsIdr", "refundPointsIdr"],
} as const;
const PAYOUT_ROLES: Role[] = [
  "cash_on_hand",
  "customer_deposit",
  "edc_clearing",
  "loyalty_liability",
];
/** Accounts the sale credited for service charge / tax. */
type Protected = "service_charge" | "tax_payable_pbjt";
const PROTECTED: Protected[] = ["service_charge", "tax_payable_pbjt"];

type Refund = {
  grossSalesIdr: number;
  serviceChargeIdr: number;
  taxIdr: number;
};

const posted = (status: string) =>
  ["posted", "already_posted"].includes(status);

/** "posted", or the parked error code, so a failure names its reason. */
const outcomeOf = (result: { status: string; code?: string }): string =>
  result.status === "parked" ? `parked:${result.code}` : result.status;

/** Seeds an order and builds an order.paid that carries the service charge,
 *  paid through one tender. */
async function seedSale(
  world: World,
  tender: Tender = "cash",
): Promise<{ orderUlid: string; paid: EventEnvelope }> {
  const orderUlid = createUlid();
  await seedPosOrder(world, orderUlid, sale);
  const event = orderPaid(world, orderUlid, sale);
  const paid = {
    ...event,
    payload: {
      ...(event.payload as Record<string, unknown>),
      serviceChargeIdr: SERVICE_CHARGE,
      totalIdr: SALE_TOTAL,
      paidCashIdr: 0,
      paidGatewayIdr: 0,
      paidEdcIdr: 0,
      paidPointsIdr: 0,
      [BUCKET[tender][0]]: SALE_TOTAL,
      tenders: [{ method: tender, amountIdr: SALE_TOTAL }],
    },
  } as EventEnvelope;
  return { orderUlid, paid };
}

function refundEvent(
  world: World,
  orderUlid: string,
  refund: Refund,
  tender: Tender = "cash",
): EventEnvelope {
  const event = orderRefunded(world, orderUlid, createUlid(), {
    grossSalesIdr: refund.grossSalesIdr,
    taxIdr: refund.taxIdr,
  });
  const amount = refund.grossSalesIdr + refund.serviceChargeIdr + refund.taxIdr;
  return {
    ...event,
    payload: {
      ...(event.payload as Record<string, unknown>),
      amountIdr: amount,
      serviceChargeIdr: refund.serviceChargeIdr,
      refundCashIdr: 0,
      refundGatewayIdr: 0,
      refundEdcIdr: 0,
      refundPointsIdr: 0,
      [BUCKET[tender][1]]: amount,
      lines: [{ method: tender, amountIdr: amount }],
    },
  } as EventEnvelope;
}

async function postSale(world: World, paid: EventEnvelope): Promise<void> {
  const result = await deliver(world, paid);
  expect(outcomeOf(result)).toBe("posted");
}

/** Total debit and credit booked on one role's account over the whole ledger. */
async function totalsOf(
  world: World,
  role: Role,
): Promise<{ debit: number; credit: number }> {
  const { rows } = await owner.query<{ debit: string; credit: string }>(
    `SELECT coalesce(sum(debit_idr), 0)::text AS debit, coalesce(sum(credit_idr), 0)::text AS credit
       FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
    [world.tenant.id, world.accounts[role]],
  );
  return { debit: Number(rows[0]!.debit), credit: Number(rows[0]!.credit) };
}

/** Points one or more roles at another role's account (committed). */
async function remap(
  world: World,
  roles: Role[],
  target: Protected,
): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query(
      `UPDATE account_mappings SET account_id = $4
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = ANY($3::text[])`,
      [world.tenant.id, world.entity, roles, world.accounts[target]],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Puts roles back on their own accounts. */
async function restoreMapping(world: World, roles: Role[]): Promise<void> {
  for (const role of roles)
    await owner.query(
      `UPDATE account_mappings SET account_id = $4
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = $3`,
      [world.tenant.id, world.entity, role, world.accounts[role]],
    );
}

/** Credits booked on payout roles by refund journals, over the whole ledger. */
async function refundPayoutCredit(world: World): Promise<number> {
  const { rows } = await owner.query<{ credit: string }>(
    `SELECT coalesce(sum(l.credit_idr), 0)::text AS credit
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.tenant_id = $1 AND e.source_type = 'refund'
        AND l.account_id = ANY($2::uuid[])`,
    [world.tenant.id, PAYOUT_ROLES.map((role) => world.accounts[role])],
  );
  return Number(rows[0]!.credit);
}

async function parkedRows(world: World) {
  return asTenant(world.tenant, (client) =>
    client.query<{ error_code: string; retryable: boolean }>(
      "SELECT error_code, retryable FROM auto_journal_parked WHERE tenant_id = $1",
      [world.tenant.id],
    ),
  );
}

// ---- race seam: wrap pg Client.query for one delivery ----------------------

type QueryFn = (this: unknown, ...args: unknown[]) => unknown;
const clientProto = (
  pg as unknown as { Client: { prototype: { query: QueryFn } } }
).Client.prototype;

const queryText = (arg: unknown): string =>
  typeof arg === "string"
    ? arg
    : typeof arg === "object" && arg !== null && "text" in arg
      ? String((arg as { text: unknown }).text)
      : "";
// Single-role lookups (`"role" = $n ... limit`, e.g. the petty_cash read of the
// GL 1102 poster guard that runs AFTER the posting read) are not the posting
// read; the seam must keep targeting the full mapping read the lines are built
// from (legend-48ft7; seam updated after 4f0d9291a added a later read).
const isSingleRoleLookup = (text: string): boolean =>
  /"role"\s*=\s*\$\d+/i.test(text) && /\blimit\b/i.test(text);
const isMappingRead = (text: string): boolean =>
  /^\s*(with\b[\s\S]*?)?select\b/i.test(text) &&
  /account_mappings/i.test(text) &&
  !isSingleRoleLookup(text);

/** How many statements read account_mappings while `run` executes. */
async function countMappingReads(run: () => Promise<unknown>): Promise<number> {
  const original = clientProto.query;
  let reads = 0;
  clientProto.query = function (this: unknown, ...args: unknown[]) {
    if (isMappingRead(queryText(args[0]))) reads += 1;
    return original.apply(this, args);
  };
  try {
    await run();
  } finally {
    clientProto.query = original;
  }
  return reads;
}

type Delivery =
  | { threw: false; status: string; code?: string }
  | { threw: true; status: "threw"; error: unknown };

/** Delivers `event`; right before the `lastRead`-th mapping read the payout
 *  roles are remapped onto `target` on a separate, committed connection. */
async function deliverWithLateRemap(
  world: World,
  event: EventEnvelope,
  lastRead: number,
  roles: Role[],
  target: Protected,
): Promise<{ delivery: Delivery; fired: boolean }> {
  const original = clientProto.query;
  let reads = 0;
  let fired = false;
  clientProto.query = function (this: unknown, ...args: unknown[]) {
    if (!fired && isMappingRead(queryText(args[0]))) {
      reads += 1;
      if (reads === lastRead && typeof args[args.length - 1] !== "function") {
        fired = true;
        return remap(world, roles, target).then(() =>
          original.apply(this, args),
        );
      }
    }
    return original.apply(this, args);
  };
  try {
    const delivery: Delivery = await deliver(world, event).then(
      (result) => ({ threw: false as const, ...result }),
      (error: unknown) => ({ threw: true as const, status: "threw", error }),
    );
    return { delivery, fired };
  } finally {
    clientProto.query = original;
  }
}

/** Number of mapping reads of one refund delivery, measured in a mirror world
 *  with the same history (`history` runs first and is not counted). */
async function probeMappingReads(
  history: (world: World, orderUlid: string) => Promise<void>,
  refund: Refund,
): Promise<number> {
  const mirror = await makeWorld();
  const { orderUlid, paid } = await seedSale(mirror);
  await postSale(mirror, paid);
  await history(mirror, orderUlid);
  let outcome = "";
  const reads = await countMappingReads(async () => {
    outcome = outcomeOf(
      await deliver(mirror, refundEvent(mirror, orderUlid, refund)),
    );
  });
  expect(outcome).toBe("posted"); // probe must be a clean, successful refund
  expect(reads).toBeGreaterThan(0);
  return reads;
}

// ---- case 1: payout map collides with a sale tax / service charge account ---

describe("48ft7 case 1: payout role mapped onto a sale tax or service charge account", () => {
  const tenders: Tender[] = ["cash", "edc", "points"];

  for (const tender of tenders)
    it(`control: a clean mapping refunds a ${tender} sale`, async () => {
      const world = await makeWorld();
      const { orderUlid, paid } = await seedSale(world, tender);
      await postSale(world, paid);
      const result = await deliver(
        world,
        refundEvent(
          world,
          orderUlid,
          { grossSalesIdr: 40_000, serviceChargeIdr: 4_000, taxIdr: 4_000 },
          tender,
        ),
      );
      expect(outcomeOf(result)).toBe("posted");
    });

  for (const target of PROTECTED)
    for (const tender of tenders)
      it(`${tender} refund is refused when every payout role sits on the ${target} account`, async () => {
        const world = await makeWorld();
        const { orderUlid, paid } = await seedSale(world, tender);
        await postSale(world, paid);
        const before = await totalsOf(world, target);
        await remap(world, PAYOUT_ROLES, target);

        const result = await deliver(
          world,
          refundEvent(
            world,
            orderUlid,
            { grossSalesIdr: 40_000, serviceChargeIdr: 4_000, taxIdr: 4_000 },
            tender,
          ),
        );

        expect(outcomeOf(result)).toBe("parked:AUTO_JOURNAL_PAYLOAD_INVALID");
        expect(await journalCount(world)).toBe(1);
        expect(await totalsOf(world, target)).toEqual(before);
        expect((await parkedRows(world)).rows).toEqual([
          { error_code: "AUTO_JOURNAL_PAYLOAD_INVALID", retryable: false },
        ]);
      });

  for (const target of PROTECTED)
    it(`cash_on_hand alone on the ${target} account: the cash refund is refused, nothing credits that account`, async () => {
      const world = await makeWorld();
      const { orderUlid, paid } = await seedSale(world);
      await postSale(world, paid);
      const before = await totalsOf(world, target);
      await remap(world, ["cash_on_hand"], target);

      const result = await deliver(
        world,
        refundEvent(world, orderUlid, {
          grossSalesIdr: 40_000,
          serviceChargeIdr: 4_000,
          taxIdr: 4_000,
        }),
      );

      expect(posted(result.status)).toBe(false);
      expect(await journalCount(world)).toBe(1);
      expect(await totalsOf(world, target)).toEqual(before);
    });
});

// ---- case 2: mapping changes between fact build and posting ----------------

describe("48ft7 case 2: mapping changed between fact build and posting", () => {
  const refund: Refund = {
    grossSalesIdr: 40_000,
    serviceChargeIdr: 4_000,
    taxIdr: 4_000,
  };

  for (const target of PROTECTED)
    it(`cash_on_hand remapped onto ${target} after the facts were built: refund refused, no journal row`, async () => {
      const lastRead = await probeMappingReads(async () => {}, refund);
      const world = await makeWorld();
      const { orderUlid, paid } = await seedSale(world);
      await postSale(world, paid);
      const before = await totalsOf(world, target);
      const cashBefore = await totalsOf(world, "cash_on_hand");

      const { delivery, fired } = await deliverWithLateRemap(
        world,
        refundEvent(world, orderUlid, refund),
        lastRead,
        ["cash_on_hand"],
        target,
      );

      expect(fired, "seam did not fire: no late account_mappings read").toBe(
        true,
      );
      // Refused by parking, not by throwing; the row stays retryable.
      expect(delivery.threw).toBe(false);
      expect(outcomeOf(delivery)).toBe("parked:ACCOUNT_MAPPING_MISSING");
      expect((await parkedRows(world)).rows).toEqual([
        { error_code: "ACCOUNT_MAPPING_MISSING", retryable: true },
      ]);
      expect(await journalCount(world)).toBe(1);
      expect(await totalsOf(world, target)).toEqual(before);
      expect(await totalsOf(world, "cash_on_hand")).toEqual(cashBefore);
      expect(await refundPayoutCredit(world)).toBe(0);
    });
});

// ---- case 3: an earlier refund already reversed ----------------------------

describe("48ft7 case 3: earlier refund already reversed", () => {
  async function reverse(world: World, entryId: string): Promise<void> {
    const context = contextOf(world.tenant);
    await withTenant(db, context, (tx) =>
      reverseJournalInTransaction(tx, context, entryId, {
        entryDate: businessDateSchema.parse(BUSINESS_DATE),
        reason: "Refund dibatalkan",
        idempotencyKey: `reverse-${entryId}`,
        lateAdjustmentFrom: null,
        postedBy: null,
      }),
    );
  }

  async function firstRefundReversed(world: World) {
    const { orderUlid, paid } = await seedSale(world);
    await postSale(world, paid);
    const first = await deliver(
      world,
      refundEvent(world, orderUlid, {
        grossSalesIdr: 50_000,
        serviceChargeIdr: 5_000,
        taxIdr: 5_000,
      }),
    );
    expect(first.status).toBe("posted");
    if (first.status !== "posted") throw new Error("first refund not posted");
    await reverse(world, first.journalEntryId);
    return orderUlid;
  }

  it("the reversal's credit to service charge / tax does not park a later full refund; it posts exactly once with the right lines", async () => {
    const world = await makeWorld();
    const orderUlid = await firstRefundReversed(world);
    expect(await journalCount(world)).toBe(3); // sale, refund, reversal

    const full = await deliver(
      world,
      refundEvent(world, orderUlid, {
        grossSalesIdr: 100_000,
        serviceChargeIdr: SERVICE_CHARGE,
        taxIdr: TAX,
      }),
    );

    expect(outcomeOf(full)).toBe("posted");
    if (full.status !== "posted") throw new Error("full refund not posted");
    expect(await linesOf(world, full.journalEntryId)).toEqual(
      [
        { role: "cash_on_hand", debit: 0, credit: SALE_TOTAL },
        { role: "sales_revenue", debit: 100_000, credit: 0 },
        { role: "service_charge", debit: SERVICE_CHARGE, credit: 0 },
        { role: "tax_payable_pbjt", debit: TAX, credit: 0 },
      ].sort((a, b) => a.role.localeCompare(b.role)),
    );
    expect(await journalCount(world)).toBe(4);
    for (const role of [
      "cash_on_hand",
      "sales_revenue",
      "service_charge",
      "tax_payable_pbjt",
    ] as Role[])
      expect(await balanceOf(world, role)).toBe(0);

    // The sale is now fully refunded: one more IDR is refused.
    const extra = await deliver(
      world,
      refundEvent(world, orderUlid, {
        grossSalesIdr: 1,
        serviceChargeIdr: 0,
        taxIdr: 0,
      }),
    );
    expect(posted(extra.status)).toBe(false);
    expect(await journalCount(world)).toBe(4);
  });

  it("a reversed earlier refund does not hide a payout collision: the next refund is refused", async () => {
    const world = await makeWorld();
    const orderUlid = await firstRefundReversed(world);
    const before = await totalsOf(world, "service_charge");
    await remap(world, ["cash_on_hand"], "service_charge");

    const result = await deliver(
      world,
      refundEvent(world, orderUlid, {
        grossSalesIdr: 40_000,
        serviceChargeIdr: 4_000,
        taxIdr: 4_000,
      }),
    );

    expect(posted(result.status)).toBe(false);
    expect(await journalCount(world)).toBe(3);
    expect(await totalsOf(world, "service_charge")).toEqual(before);
  });
});

// ---- case 4: nobody paid more, outlet not at a loss -------------------------

describe("48ft7 case 4: payout never exceeds what was refunded; service charge and tax lines stay exact", () => {
  const refundHalf: Refund = {
    grossSalesIdr: 50_000,
    serviceChargeIdr: 5_000,
    taxIdr: 5_000,
  };
  const HALF = 60_000;

  it("a refund refused by the late remap pays nothing; the sweep retry pays the parked event exactly once; total paid equals the sale total", async () => {
    const history = async (world: World, orderUlid: string) => {
      const first = await deliver(
        world,
        refundEvent(world, orderUlid, refundHalf),
      );
      expect(outcomeOf(first)).toBe("posted");
    };
    const lastRead = await probeMappingReads(history, refundHalf);

    const world = await makeWorld();
    const { orderUlid, paid } = await seedSale(world);
    await postSale(world, paid);
    await history(world, orderUlid);
    expect(await refundPayoutCredit(world)).toBe(HALF);

    // Second half: payout role remapped onto the tax account at posting time.
    const { delivery, fired } = await deliverWithLateRemap(
      world,
      refundEvent(world, orderUlid, refundHalf),
      lastRead,
      ["cash_on_hand"],
      "tax_payable_pbjt",
    );
    expect(fired, "seam did not fire: no late account_mappings read").toBe(
      true,
    );
    expect(delivery.threw).toBe(false);
    expect(outcomeOf(delivery)).toBe("parked:ACCOUNT_MAPPING_MISSING");
    expect((await parkedRows(world)).rows).toEqual([
      { error_code: "ACCOUNT_MAPPING_MISSING", retryable: true },
    ]);
    expect(await journalCount(world)).toBe(2);
    // Nobody paid more: payouts still only the first half, and the sale's
    // service charge / tax were never credited by a refund.
    expect(await refundPayoutCredit(world)).toBe(HALF);
    const sc = await totalsOf(world, "service_charge");
    const tax = await totalsOf(world, "tax_payable_pbjt");
    expect(sc).toEqual({ debit: 5_000, credit: SERVICE_CHARGE });
    expect(tax).toEqual({ debit: 5_000, credit: TAX });

    // Mapping fixed again: the sweep posts the SAME parked event, exactly once
    // (no new refund event is delivered).
    await restoreMapping(world, ["cash_on_hand"]);
    const later = (hours: number) =>
      new Date(Date.now() + hours * 60 * 60 * 1000);
    expect(
      await retryParkedAutoJournals(contextOf(world.tenant), later(48)),
    ).toEqual({ posted: 1, stillParked: 0, failed: 0 });
    expect((await parkedRows(world)).rows).toEqual([]);
    expect(await journalCount(world)).toBe(3);
    // A second sweep finds nothing: still one payout for that event.
    expect(
      (await retryParkedAutoJournals(contextOf(world.tenant), later(96)))
        .posted,
    ).toBe(0);
    expect(await journalCount(world)).toBe(3);

    // Cap: total paid out == sale total, never more.
    expect(await refundPayoutCredit(world)).toBe(SALE_TOTAL);
    expect(await refundPayoutCredit(world)).toBeLessThanOrEqual(SALE_TOTAL);
    // Outlet not at a loss: the cash taken in is fully and only returned.
    expect(await balanceOf(world, "cash_on_hand")).toBe(0);
    // Service charge and tax lines: debit never above credit, credit unchanged.
    expect(await totalsOf(world, "service_charge")).toEqual({
      debit: SERVICE_CHARGE,
      credit: SERVICE_CHARGE,
    });
    expect(await totalsOf(world, "tax_payable_pbjt")).toEqual({
      debit: TAX,
      credit: TAX,
    });
    expect(await balanceOf(world, "sales_revenue")).toBe(0);

    // Anything more on the exhausted sale is refused and pays nothing.
    const over = await deliver(
      world,
      refundEvent(world, orderUlid, {
        grossSalesIdr: 1,
        serviceChargeIdr: 0,
        taxIdr: 0,
      }),
    );
    expect(posted(over.status)).toBe(false);
    expect(await journalCount(world)).toBe(3);
    expect(await refundPayoutCredit(world)).toBe(SALE_TOTAL);
  });

  it("with a clean mapping, staged refunds keep payout credits <= the refunded total and service charge / tax credits unchanged", async () => {
    const world = await makeWorld();
    const { orderUlid, paid } = await seedSale(world);
    await postSale(world, paid);

    for (const refund of [
      { grossSalesIdr: 30_000, serviceChargeIdr: 3_000, taxIdr: 3_000 },
      { grossSalesIdr: 30_000, serviceChargeIdr: 3_000, taxIdr: 3_000 },
    ]) {
      expect(
        outcomeOf(await deliver(world, refundEvent(world, orderUlid, refund))),
      ).toBe("posted");
    }
    expect(await refundPayoutCredit(world)).toBe(72_000);
    expect(await totalsOf(world, "service_charge")).toEqual({
      debit: 6_000,
      credit: SERVICE_CHARGE,
    });
    expect(await totalsOf(world, "tax_payable_pbjt")).toEqual({
      debit: 6_000,
      credit: TAX,
    });

    // Asking for more than is left is refused; payouts do not move.
    const tooMuch = await deliver(
      world,
      refundEvent(world, orderUlid, {
        grossSalesIdr: 60_000,
        serviceChargeIdr: 0,
        taxIdr: 0,
      }),
    );
    expect(posted(tooMuch.status)).toBe(false);
    expect(await refundPayoutCredit(world)).toBe(72_000);
    expect(await refundPayoutCredit(world)).toBeLessThanOrEqual(SALE_TOTAL);
  });
});
