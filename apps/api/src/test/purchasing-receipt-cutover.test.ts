// legend-7e0q4: cutover path for goods receipts that have no journal.
// Written fail-first from the card text (brief 642 card B), the founder
// decision Q20 / F2 and docs/briefs/ws-purchasing-posting-design.md sections
// 2.3 and 9, not from the implementation.
//
// Money rules under test (founder: nobody is paid more, the outlet never loses):
// - A receipt made while the posting flag was off has no journal, so an invoice
//   or a return of it is refused (409 GOODS_RECEIPT_NOT_JOURNALED) until
//   finance journalizes the receipt (decision Q20).
// - The finance command "jurnalkan penerimaan" books exactly one Dr inventory /
//   Cr GRNI journal at the received value; a repeat books nothing more.
// - Only after that can the invoice (clears GRNI to zero) and a return succeed.
//
// Assumptions (the contract fixes the endpoint, a few details are open):
// - Endpoint: POST /api/inventory/goods-receipts/:goodsReceiptId/journalize,
//   empty body, answer `{ data: { goodsReceiptId, status: "posted" |
//   "already_posted", journalEntryId } }` (shared endpoint contract).
// - Finance = template role `finance` assigned tenant-wide; "no permission" =
//   a signed-in user with no role. Any success status 200 or 201 is accepted.
// - While the posting flag is off the command is refused with 409 (the code is
//   not asserted, only that nothing is booked).
// - CUT-07: "a receipt that is not visible to the caller" -> 404: an id of no
//   receipt, and a finance user assigned to another outlet (403 or 404
//   accepted, "tidak bocor"). CUT-10: a real second tenant (own domain, own
//   finance role) asking for this tenant's receipt -> 404.
// - A zero-value receipt is one whose PO line unit price is 0 -> 422.
// - Ids CUT-nn name the cases below.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ROLE_TEMPLATES } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { setPurchaseReturnPostingEnabled } from "../services/purchase-return.service.ts";
import {
  createSupplierInvoice,
  setSupplierInvoicePostingEnabled,
} from "../services/purchasing-invoice.service.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import {
  addDays,
  apLedger,
  closeOwner,
  hex,
  journalCount,
  key,
  outletScope,
  owner,
  returnPo,
  seedReceivedPo,
  setupApWorld,
  stockOf,
  tenantId,
  type ApWorld,
  type ReceivedPo,
} from "./purchasing-ap-world.ts";

const app = createApp();
const otherOutletId = cafeLegendPlatformFixtures.outlets[0]!.id;

beforeAll(() => {
  setAuditWriter(coreAuditWriter);
  setPurchaseReturnPostingEnabled(true);
  setSupplierInvoicePostingEnabled(true);
});

afterEach(() => {
  setPurchaseReturnPostingEnabled(true);
  setSupplierInvoicePostingEnabled(true);
});

afterAll(async () => {
  setAuditWriter(null);
  setPurchaseReturnPostingEnabled(null);
  setSupplierInvoicePostingEnabled(null);
  await closeOwner();
});

type Fixture = { world: ApWorld; fx: ReceivedPo };

/**
 * A world with one fully received PO (10 units at 10.000, receipt value
 * 100.000) made while the posting flag is OFF: the receipt event is ignored, so
 * the receipt has no journal. The flag is switched back on afterwards.
 */
async function legacyReceipt(unitPriceIdr = 10_000): Promise<Fixture> {
  setSupplierInvoicePostingEnabled(false);
  try {
    const world = await setupApWorld();
    const fx = await seedReceivedPo(world, { unitPriceIdr });
    return { world, fx };
  } finally {
    setSupplierInvoicePostingEnabled(true);
  }
}

type Client = ReturnType<typeof agent>;

async function userWith(
  label: string,
  assignment?: { scope: "tenant" } | { scope: "outlet"; outletId: string },
): Promise<Client> {
  const client = agent(app);
  const email = await signUp(client, label);
  await verifySessionMfa(email);
  if (assignment) {
    const session = await client.get("/api/auth/get-session");
    const userId = session.body.user.id as string;
    const { rows } = await owner.query<{ id: string }>(
      "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'finance'",
      [tenantId],
    );
    if (!rows[0]) throw new Error("No finance role template");
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
      [
        tenantId,
        userId,
        rows[0].id,
        assignment.scope,
        assignment.scope === "outlet" ? assignment.outletId : null,
      ],
    );
  }
  return client;
}

const financeUser = () => userWith("Cutover finance", { scope: "tenant" });

const journalize = (client: Client, receiptId: string) =>
  client
    .post(
      `/api/inventory/goods-receipts/${encodeURIComponent(receiptId)}/journalize`,
    )
    .set(originHeader)
    .send({});

const receiptKey = (fx: ReceivedPo) => `aj:goods-receipt:${fx.receiptId}`;

async function entriesByKey(world: ApWorld, idempotencyKey: string) {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM journal_entries
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND idempotency_key = $3`,
    [tenantId, world.entityId, idempotencyKey],
  );
  return rows.map((row) => row.id);
}

type Sides = { debit: number; credit: number };

async function linesOf(entryId: string): Promise<Map<string, Sides>> {
  const { rows } = await owner.query<{
    account_id: string;
    debit: string;
    credit: string;
  }>(
    `SELECT account_id, sum(debit_idr)::text AS debit, sum(credit_idr)::text AS credit
       FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2 GROUP BY account_id`,
    [tenantId, entryId],
  );
  return new Map(
    rows.map((row) => [
      row.account_id,
      { debit: Number(row.debit), credit: Number(row.credit) },
    ]),
  );
}

async function creditBalance(accountId: string): Promise<number> {
  const { rows } = await owner.query<{ balance: string }>(
    `SELECT coalesce(sum(credit_idr - debit_idr), 0)::text AS balance
       FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
    [tenantId, accountId],
  );
  return Number(rows[0]!.balance);
}

function invoiceReceipt(world: ApWorld, fx: ReceivedPo, ppnIdr = 11_000) {
  return createSupplierInvoice(
    outletScope(world.outletId),
    world.buyer.userId,
    {
      outletId: world.outletId,
      supplierId: world.supplierId,
      purchaseOrderId: fx.poId,
      number: `INV-${hex()}`,
      invoiceDate: fx.receivedOn,
      dueDate: addDays(fx.receivedOn, 30),
      lines: [
        {
          purchaseOrderLineId: fx.poLineId,
          kind: "goods",
          description: "Tepung",
          quantity: "10.0000",
          unitPriceIdr: `${fx.unitPriceIdr}.0000`,
        },
      ],
      ppnIdr,
      pph23Idr: 0,
      idempotencyKey: key(),
    } as unknown as Parameters<typeof createSupplierInvoice>[2],
  );
}

const isOk = (status: number) => [200, 201].includes(status);

describe("legend-7e0q4 a receipt without journal is unbillable until finance journalizes it", () => {
  it("CUT-01 a receipt made with the flag off cannot be invoiced or returned: 409 GOODS_RECEIPT_NOT_JOURNALED, nothing written", async () => {
    const { world, fx } = await legacyReceipt();
    expect(await entriesByKey(world, receiptKey(fx))).toHaveLength(0);
    const journalsBefore = await journalCount(world);
    const stockBefore = await stockOf(fx.locationId, fx.itemId);

    await expect(invoiceReceipt(world, fx)).rejects.toMatchObject({
      status: 409,
      code: "GOODS_RECEIPT_NOT_JOURNALED",
    });
    await expect(returnPo(world, fx, 2)).rejects.toMatchObject({
      status: 409,
      code: "GOODS_RECEIPT_NOT_JOURNALED",
    });

    expect(await journalCount(world)).toBe(journalsBefore);
    expect(await stockOf(fx.locationId, fx.itemId)).toBe(stockBefore);
    expect(await apLedger(world)).toBe(0);
    expect(await creditBalance(world.accounts.grni)).toBe(0);
  });

  it("CUT-02 the command is refused 409 while the posting flag is off and books nothing", async () => {
    const { world, fx } = await legacyReceipt();
    const finance = await financeUser();
    const journalsBefore = await journalCount(world);

    setSupplierInvoicePostingEnabled(false);
    const refused = await journalize(finance, fx.receiptId);

    expect(refused.status).toBe(409);
    expect(await entriesByKey(world, receiptKey(fx))).toHaveLength(0);
    expect(await journalCount(world)).toBe(journalsBefore);
    expect(await creditBalance(world.accounts.grni)).toBe(0);
  });
});

describe("legend-7e0q4 finance journalizes the receipt (flag on)", () => {
  it("CUT-03 the command posts one balanced Dr inventory / Cr GRNI journal at the receipt value; a repeat books nothing more", async () => {
    const { world, fx } = await legacyReceipt();
    const finance = await financeUser();

    const first = await journalize(finance, fx.receiptId);
    expect(isOk(first.status)).toBe(true);
    expect(first.body.data).toMatchObject({
      goodsReceiptId: fx.receiptId,
      status: "posted",
    });

    const entries = await entriesByKey(world, receiptKey(fx));
    expect(entries).toHaveLength(1);
    expect(first.body.data.journalEntryId).toBe(entries[0]);
    const lines = await linesOf(entries[0]!);
    expect(lines.size).toBe(2);
    expect(lines.get(world.accounts.inventory)).toEqual({
      debit: 100_000,
      credit: 0,
    });
    expect(lines.get(world.accounts.grni)).toEqual({
      debit: 0,
      credit: 100_000,
    });
    const journalsAfterFirst = await journalCount(world);

    // Replay (twice): nothing more is booked, the same journal is answered.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const again = await journalize(finance, fx.receiptId);
      expect(isOk(again.status)).toBe(true);
      expect(again.body.data).toMatchObject({
        goodsReceiptId: fx.receiptId,
        status: "already_posted",
        journalEntryId: entries[0],
      });
    }
    expect(await entriesByKey(world, receiptKey(fx))).toHaveLength(1);
    expect(await journalCount(world)).toBe(journalsAfterFirst);
    expect(await creditBalance(world.accounts.grni)).toBe(100_000);
    expect(await creditBalance(world.accounts.inventory)).toBe(-100_000);
  });

  it("CUT-04 after the command the invoice succeeds: GRNI is cleared to zero and the payable is the bill", async () => {
    const { world, fx } = await legacyReceipt();
    await expect(invoiceReceipt(world, fx)).rejects.toMatchObject({
      status: 409,
      code: "GOODS_RECEIPT_NOT_JOURNALED",
    });

    expect(
      isOk((await journalize(await financeUser(), fx.receiptId)).status),
    ).toBe(true);

    const { invoice } = await invoiceReceipt(world, fx);
    expect(invoice.status).toBe("matched");
    expect(invoice.payableIdr).toBe(111_000);
    expect(await creditBalance(world.accounts.grni)).toBe(0);
    expect(await creditBalance(world.accounts.inventory)).toBe(-100_000);
    // Nobody is owed more than the bill.
    expect(await apLedger(world)).toBe(111_000);
  });

  it("CUT-05 after the command a return of the uninvoiced goods succeeds: GRNI is cleared, nothing is owed", async () => {
    const { world, fx } = await legacyReceipt();
    await expect(returnPo(world, fx, 2)).rejects.toMatchObject({
      status: 409,
      code: "GOODS_RECEIPT_NOT_JOURNALED",
    });

    expect(
      isOk((await journalize(await financeUser(), fx.receiptId)).status),
    ).toBe(true);

    const { purchaseReturn } = await returnPo(world, fx, 2);
    expect(purchaseReturn.id).toBeTruthy();
    expect(await stockOf(fx.locationId, fx.itemId)).toBe("8.0000");
    // The goods never invoiced go back: no payable was ever created.
    expect(await apLedger(world)).toBe(0);
  });
});

describe("legend-7e0q4 refusals of the command", () => {
  it("CUT-06 a signed-out caller gets 401, a user without the accounting permission 403, and nothing is booked", async () => {
    const { world, fx } = await legacyReceipt();
    const journalsBefore = await journalCount(world);

    const anonymous = await journalize(agent(app), fx.receiptId);
    expect(anonymous.status).toBe(401);

    const plain = await userWith("Cutover plain user");
    expect((await journalize(plain, fx.receiptId)).status).toBe(403);

    expect(await entriesByKey(world, receiptKey(fx))).toHaveLength(0);
    expect(await journalCount(world)).toBe(journalsBefore);
  });

  it("CUT-07 a receipt the caller cannot see is 404 or 403: an unknown id, and finance of another outlet", async () => {
    const { world, fx } = await legacyReceipt();
    const finance = await financeUser();
    const journalsBefore = await journalCount(world);

    expect((await journalize(finance, randomUUID())).status).toBe(404);

    const otherOutlet = await userWith("Cutover other outlet finance", {
      scope: "outlet",
      outletId: otherOutletId,
    });
    expect([403, 404]).toContain(
      (await journalize(otherOutlet, fx.receiptId)).status,
    );

    expect(await entriesByKey(world, receiptKey(fx))).toHaveLength(0);
    expect(await journalCount(world)).toBe(journalsBefore);
  });

  // Round 1 review (T2). Assumption: the tenant is resolved from the Host
  // header (registered domain), as in accounting-journal-expiry-race. Tenant B is
  // a real second tenant with its own finance role, its own domain and a
  // finance user assigned tenant-wide; that user asks for tenant A's receipt
  // id under tenant B's host. The receipt is invisible there: 404 NOT_FOUND, not
  // 403 and not TENANT_NOT_FOUND (the tenant resolves; the receipt does not).
  // Round 2 (Bug2): a positive control proves host B resolves to tenant B.
  it("CUT-10 a finance user of another tenant gets 404 for this tenant's receipt and nothing is booked", async () => {
    const { world, fx } = await legacyReceipt();
    const journalsBefore = await journalCount(world);

    const tenantB = randomUUID();
    const brandB = randomUUID();
    const hostB = `cutover-other-${tenantB}.example.test`;
    const fixture = cafeLegendPlatformFixtures;
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       VALUES ($1, $2, 'Cutover other tenant', $3, 'active', 'shared', $4, $5, $6)`,
      [
        tenantB,
        `cutover-other-${tenantB}`,
        fixture.tenant.plan,
        JSON.stringify(fixture.tenant.featureFlags),
        JSON.stringify(fixture.tenant.limits),
        fixture.tenant.createdBy,
      ],
    );
    await owner.query(
      "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'other', 'Other brand')",
      [brandB, tenantB],
    );
    await owner.query(
      `INSERT INTO tenant_domains (tenant_id, brand_id, hostname, kind, tls_status, verified_at)
       VALUES ($1, $2, $3, 'custom', 'active', now())`,
      [tenantB, brandB, hostB],
    );
    const template = ROLE_TEMPLATES.find((role) => role.key === "finance")!;
    const { rows: role } = await owner.query<{ id: string }>(
      `INSERT INTO roles (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, true, 'finance', $3, $4, $5) RETURNING id`,
      [
        tenantB,
        template.defaultName,
        JSON.stringify(template.permissions),
        template.mfaRequired,
        JSON.stringify(template.allowedScopeTypes),
      ],
    );
    const foreign = agent(app);
    const email = await signUp(foreign, "Cutover tenant B finance");
    await verifySessionMfa(email);
    const session = await foreign.get("/api/auth/get-session");
    const userId = session.body.user.id as string;
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenantB, userId, role[0]!.id],
    );
    foreign.set("Host", hostB);

    // Positive control: host B really resolves to tenant B. This user has a
    // finance role only in tenant B, so reading tenant B's purchasing policy
    // answers 200; if the host resolved to tenant A the user would hold no role
    // there and get 403.
    const control = await foreign.get("/api/inventory/purchasing-policy");
    expect(control.status, JSON.stringify(control.body)).toBe(200);

    const foreignAttempt = await journalize(foreign, fx.receiptId);
    expect(foreignAttempt.status).toBe(404);
    // The receipt is simply not found there: NOT_FOUND, not a tenant error.
    expect(
      (foreignAttempt.body as { error?: { code?: string } }).error?.code,
    ).toBe("NOT_FOUND");

    expect(await entriesByKey(world, receiptKey(fx))).toHaveLength(0);
    expect(await journalCount(world)).toBe(journalsBefore);
    expect(await creditBalance(world.accounts.grni)).toBe(0);
    const { rows: booked } = await owner.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1",
      [tenantB],
    );
    expect(Number(booked[0]!.n)).toBe(0);

    // Control: finance of the owning tenant can journalize the same receipt.
    const own = await journalize(await financeUser(), fx.receiptId);
    expect(isOk(own.status)).toBe(true);
    expect(await entriesByKey(world, receiptKey(fx))).toHaveLength(1);
  });

  it("CUT-08 a zero-value receipt is refused 422 and no journal is booked", async () => {
    const { world, fx } = await legacyReceipt(0);
    const finance = await financeUser();
    const journalsBefore = await journalCount(world);

    const refused = await journalize(finance, fx.receiptId);

    expect(refused.status).toBe(422);
    expect(await entriesByKey(world, receiptKey(fx))).toHaveLength(0);
    expect(await journalCount(world)).toBe(journalsBefore);
  });

  it("CUT-09 a malformed receipt id is refused 422 and a body with extra fields is refused 422", async () => {
    const { fx } = await legacyReceipt();
    const finance = await financeUser();

    expect((await journalize(finance, "not-a-uuid")).status).toBe(422);
    const smuggled = await finance
      .post(
        `/api/inventory/goods-receipts/${encodeURIComponent(fx.receiptId)}/journalize`,
      )
      .set(originHeader)
      .send({ tenantId: randomUUID() });
    expect(smuggled.status).toBe(422);
  });
});
