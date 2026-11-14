// Supplier invoice, three-way match, hold/release (card ws/purchasing-apar,
// design docs/briefs/ws-purchasing-apar-design.md §2, §5, §7, §9, §12). Written
// fail-first from the design and the shared contract, through HTTP. Money rules
// (founder): an invoice above the PO or the receipt is held and cannot be paid;
// a failed posting leaves nothing behind; another tenant sees nothing.
//
// Ids used in test names:
// - PI-01 clean invoice posts AP (journal, open item, tax record) in one go
// - PI-02 quantity above the net received is held; nothing payable
// - PI-03 price tolerance is exact (default 0 bp, 200 / 201 / 200.4 bp)
// - PI-04 second invoice on the same receipt is held; parallel creates
// - PI-05 return then invoice; held invoice then return then release
// - PI-06 service line is held; PPN / PPh 23 limits answer 422
// - PI-07 duplicate number 409, reusable after reject
// - PI-08 release: separation of duties, permission, blocked issues, success
// - PI-09 matched cannot be rejected; held can; rematch posts AP when clean
// - PI-10 posting gate off (K5)
// - PI-11 full rollback (mapping, closed period, NPWP, failed release)
// - PI-12 tenant isolation, outlet reach, RLS, guards
//
// Assumptions (the design does not pin these down):
// - Responses are `{ data: { invoice, lines, match } }`; invoice has `status`
//   (matched|held|released|rejected), `matchStatus`, `matchNote`, amounts.
// - Create answers 201 for matched AND held; match/release/reject answer 200.
// - Errors are `{ error: { code } }`. Quoted codes come from design §8/§12.
// - Table columns follow design §1; the idempotency operation name contains
//   "invoice". Roles are the PRD templates (purchasing, finance, warehouse)
//   copied as custom roles; the session needs no second factor.
// - Held outcome is a successful write (the invoice is stored, no AP).
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { setPurchaseReturnPostingEnabled } from "../services/purchase-return.service.ts";
import { setSupplierInvoicePostingEnabled } from "../services/purchasing-invoice.service.ts";
import { withTenant } from "../db/tenant.ts";
import { db } from "../db/index.ts";
import { paySupplierInvoiceInTransaction } from "../services/accounting-ap.service.ts";
import { userIdSchema } from "@starter/shared/core";
import { agent, originHeader } from "./helpers.ts";
import {
  addDays,
  addUser,
  api,
  apCard,
  app,
  apLedger,
  appPool,
  asApp,
  closedPastDate,
  codeOf,
  contextFor,
  createInvoice,
  createWorld,
  decide,
  footprint,
  goodsLine,
  insertSupplier,
  invoiceBody,
  invoiceIdOf,
  invoiceRow,
  invoiceRowsOfPo,
  journalLines,
  journalOf,
  key,
  openItemOf,
  owner,
  receive,
  rematch,
  returnGoods,
  seedPo,
  serviceLine,
  setTolerance,
  taxRecordExists,
  today,
  type Po,
  type Session,
  type World,
} from "./purchasing-apar-helpers.ts";

let A: World;
let B: World;
let buyer: Session;
let finance1: Session;
let finance2: Session;
let warehouse: Session;
let outletTwoBuyer: Session;
let nobody: Session;
let financeB: Session;
let buyerB: Session;

/** A received PO (10 kg at Rp 10.000) of tenant A. */
async function receivedPo(
  options: { quantity?: string; unitPrice?: string; supplierId?: string } = {},
): Promise<Po> {
  const po = await seedPo(A, options);
  return receive(A, warehouse, po);
}

const invoiceOf = (res: { body: unknown }) =>
  (
    res.body as {
      data: {
        invoice: Record<string, unknown> & { id: string; status: string };
        match: { rows: { issues: string[] }[]; headerIssues: string[] } | null;
      };
    }
  ).data;

/** Creates a clean (matched) invoice of `quantity` kg and asserts 201. */
async function matchedInvoice(po: Po, quantity: string, who = buyer) {
  const res = await createInvoice(
    A,
    who,
    invoiceBody(A, po, { lines: [goodsLine(po, quantity)] }),
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(invoiceOf(res).invoice.status).toBe("matched");
  return invoiceIdOf(res);
}

/** Asserts that an invoice is held and left no AP behind. */
async function expectHeldWithoutAp(id: string) {
  const row = await invoiceRow(A, id);
  expect(row?.status).toBe("held");
  expect(row?.journal_entry_id).toBeNull();
  expect(await openItemOf(A, id)).toBeNull();
  expect(await taxRecordExists(A, id)).toBe(false);
  expect(await journalOf(A, id)).toBeNull();
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  setPurchaseReturnPostingEnabled(true);
  setSupplierInvoicePostingEnabled(true);
  A = await createWorld("a");
  B = await createWorld("b");
  buyer = await addUser(A, "PI buyer", [
    { role: "purchasing", outletId: A.outletId },
  ]);
  finance1 = await addUser(A, "PI finance 1", [
    { role: "finance", outletId: null },
  ]);
  finance2 = await addUser(A, "PI finance 2", [
    { role: "finance", outletId: null },
  ]);
  warehouse = await addUser(A, "PI warehouse", [
    { role: "warehouse", outletId: A.outletId },
  ]);
  outletTwoBuyer = await addUser(A, "PI buyer outlet 2", [
    { role: "purchasing", outletId: A.outletTwoId },
  ]);
  nobody = await addUser(A, "PI nobody", []);
  financeB = await addUser(B, "PI finance B", [
    { role: "finance", outletId: null },
  ]);
  buyerB = await addUser(B, "PI buyer B", [
    { role: "purchasing", outletId: B.outletId },
  ]);
});

afterEach(async () => {
  setSupplierInvoicePostingEnabled(true);
  await setTolerance(A, null, finance1.userId);
});

afterAll(async () => {
  setSupplierInvoicePostingEnabled(null);
  setPurchaseReturnPostingEnabled(null);
  setAuditWriter(null);
  await appPool.end();
  await owner.end();
});

describe("ws-purchasing-apar PI invoice posting and match", () => {
  it("PI-01 a clean invoice is matched and posts the journal, the open item and the tax record together", async () => {
    const po = await receivedPo();
    const res = await createInvoice(
      A,
      buyer,
      invoiceBody(A, po, { ppnIdr: 11_000 }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { invoice } = invoiceOf(res);
    expect(invoice.status).toBe("matched");
    expect(invoice.payableIdr).toBe(111_000);
    const id = invoice.id;
    expect((await invoiceRow(A, id))?.status).toBe("matched");
    expect(Number((await openItemOf(A, id))?.original_idr)).toBe(111_000);
    expect(await taxRecordExists(A, id)).toBe(true);
    const entry = await journalOf(A, id);
    expect(entry).not.toBeNull();
    expect(await journalLines(A, entry!)).toEqual({
      grni: { debit: 100_000, credit: 0 },
      ppn_input: { debit: 11_000, credit: 0 },
      accounts_payable: { debit: 0, credit: 111_000 },
    });
    // The supplier card equals the ledger.
    expect(await apCard(A)).toBe(await apLedger(A));
  });

  it("PI-02 quantity above the net received is held: no journal, open item or tax record, and it cannot be paid", async () => {
    const po = await receivedPo();
    const res = await createInvoice(
      A,
      buyer,
      invoiceBody(A, po, { lines: [goodsLine(po, "11.0000")] }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { invoice, match } = invoiceOf(res);
    expect(invoice.status).toBe("held");
    expect(invoice.matchStatus).toBe("discrepancy");
    expect(match?.rows.flatMap((row) => row.issues)).toContain(
      "quantity_exceeds_receipt",
    );
    await expectHeldWithoutAp(invoice.id);

    // Nothing to pay: the payment is refused and writes nothing.
    const context = contextFor(A, null);
    await expect(
      withTenant(db, context, (tx) =>
        paySupplierInvoiceInTransaction(
          tx,
          context,
          {
            supplierInvoiceId: invoice.id,
            supplierPaymentId: randomUUID(),
            amountIdr: 110_000,
            paidOn: today(),
            idempotencyKey: key(),
          },
          userIdSchema.parse(finance2.userId),
          new Date(),
        ),
      ),
    ).rejects.toThrow();
    expect(await openItemOf(A, invoice.id)).toBeNull();
  });

  it("PI-03 the price tolerance is exact: default 0 bp, then 200 bp passes, 201 bp and 200,4 bp are held", async () => {
    // Default (no policy row): 0 bp, so even Rp 1 per unit over is held.
    const strict = await receivedPo();
    const over = await createInvoice(
      A,
      buyer,
      invoiceBody(A, strict, {
        lines: [goodsLine(strict, "10.0000", "10001.0000")],
      }),
    );
    expect(invoiceOf(over).invoice.status).toBe("held");
    expect(invoiceOf(over).match?.rows[0]?.issues).toContain(
      "price_outside_tolerance",
    );
    await expectHeldWithoutAp(invoiceOf(over).invoice.id);
    // Exactly the PO price at 0 bp passes (control).
    const exact = await receivedPo();
    expect(await matchedInvoice(exact, "10.0000")).toBeTruthy();

    await setTolerance(A, 200, finance1.userId);
    const at200 = await receivedPo();
    const ok = await createInvoice(
      A,
      buyer,
      invoiceBody(A, at200, {
        lines: [goodsLine(at200, "10.0000", "10200.0000")],
      }),
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const matched = invoiceOf(ok).invoice;
    expect(matched.status).toBe("matched");
    expect(matched.priceVarianceIdr).toBe(2_000);
    expect(matched.payableIdr).toBe(102_000);
    const entry = await journalOf(A, matched.id);
    expect(await journalLines(A, entry!)).toEqual({
      grni: { debit: 100_000, credit: 0 },
      purchase_price_variance: { debit: 2_000, credit: 0 },
      accounts_payable: { debit: 0, credit: 102_000 },
    });
    expect((await invoiceRow(A, matched.id))?.tolerance_bp).toBe(200);

    for (const price of ["10201.0000", "10200.4000"]) {
      const po = await receivedPo();
      const res = await createInvoice(
        A,
        buyer,
        invoiceBody(A, po, { lines: [goodsLine(po, "10.0000", price)] }),
      );
      expect(res.status, price).toBe(201);
      expect(invoiceOf(res).invoice.status, price).toBe("held");
      await expectHeldWithoutAp(invoiceOf(res).invoice.id);
    }
  });

  it("PI-04 a second invoice on the same receipt is held, and parallel creates let only one be matched", async () => {
    const po = await receivedPo();
    await matchedInvoice(po, "10.0000");
    const second = await createInvoice(A, buyer, invoiceBody(A, po));
    expect(second.status).toBe(201);
    expect(invoiceOf(second).invoice.status).toBe("held");
    await expectHeldWithoutAp(invoiceOf(second).invoice.id);
    expect(await apCard(A)).toBe(await apLedger(A));

    const racing = await receivedPo();
    const before = await apLedger(A);
    const results = await Promise.all(
      [0, 1, 2].map(() => createInvoice(A, buyer, invoiceBody(A, racing))),
    );
    for (const res of results) expect(res.status).toBe(201);
    const statuses = results.map((res) => invoiceOf(res).invoice.status);
    expect(statuses.filter((status) => status === "matched")).toHaveLength(1);
    expect(statuses.filter((status) => status === "held")).toHaveLength(2);
    expect(await apLedger(A)).toBe(before + 100_000);
    const rows = await invoiceRowsOfPo(A, racing.poId);
    expect(rows.filter((row) => row.journal_entry_id !== null)).toHaveLength(1);
  });

  it("legend-btcex PO lines expose non-rejected billed quantity and excess cannot add payable or be released", async () => {
    const po = await receivedPo();
    const billed = async () => {
      const res = await api.get(A, buyer, `/purchase-orders/${po.poId}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const detail = res.body as {
        data: { lines: { id: string; quantityInvoiced: string }[] };
      };
      return detail.data.lines.find((line) => line.id === po.poLineId)
        ?.quantityInvoiced;
    };
    expect(await billed()).toBe("0.0000");
    const before = await apLedger(A);
    await matchedInvoice(po, "4.0000");
    expect(await billed()).toBe("4.0000");
    await matchedInvoice(po, "6.0000");
    expect(await billed()).toBe("10.0000");
    expect(await apLedger(A)).toBe(before + 100_000);

    const excess = await createInvoice(
      A,
      buyer,
      invoiceBody(A, po, { lines: [goodsLine(po, "0.0001")] }),
    );
    expect(excess.status, JSON.stringify(excess.body)).toBe(201);
    const id = invoiceIdOf(excess);
    await expectHeldWithoutAp(id);
    expect(invoiceOf(excess).match?.rows[0]?.issues).toContain(
      "quantity_exceeds_receipt",
    );
    expect(await billed()).toBe("10.0001");
    const release = await decide(A, finance1, id, "release");
    expect(release.status, JSON.stringify(release.body)).toBe(409);
    expect(codeOf(release)).toBe("SUPPLIER_INVOICE_RELEASE_BLOCKED");
    await expectHeldWithoutAp(id);
    expect(await apLedger(A)).toBe(before + 100_000);

    const rejected = await decide(A, buyer, id, "reject");
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(await billed()).toBe("10.0000");
    expect(await apLedger(A)).toBe(before + 100_000);
  });

  it("PI-05 after a return a full-quantity invoice is held; a held invoice cannot be released once a return makes it exceed the receipt", async () => {
    const po = await receivedPo();
    const ret = await returnGoods(A, warehouse, po, "3.0000");
    expect(ret.status, JSON.stringify(ret.body)).toBe(201);
    const full = await createInvoice(A, buyer, invoiceBody(A, po));
    expect(invoiceOf(full).invoice.status).toBe("held");
    expect(invoiceOf(full).match?.rows[0]?.issues).toContain(
      "quantity_exceeds_receipt",
    );
    await expectHeldWithoutAp(invoiceOf(full).invoice.id);
    // A held invoice still counts as billed (design §5 step 3), so a second
    // invoice is held until the held one is rejected.
    const rejectedFull = await decide(
      A,
      buyer,
      invoiceOf(full).invoice.id,
      "reject",
      "Qty melebihi penerimaan bersih, minta faktur koreksi",
    );
    expect(rejectedFull.status, JSON.stringify(rejectedFull.body)).toBe(200);
    // Control: the net received (7 kg) is invoiceable.
    expect(await matchedInvoice(po, "7.0000")).toBeTruthy();

    // A price-only hold, then a return, then the release is blocked.
    const po2 = await receivedPo();
    const held = await createInvoice(
      A,
      buyer,
      invoiceBody(A, po2, {
        lines: [goodsLine(po2, "10.0000", "10500.0000")],
      }),
    );
    const id = invoiceOf(held).invoice.id;
    expect(invoiceOf(held).invoice.status).toBe("held");
    expect((await returnGoods(A, warehouse, po2, "3.0000")).status).toBe(201);
    const release = await decide(A, finance2, id, "release");
    expect(release.status).toBe(409);
    expect(codeOf(release)).toBe("SUPPLIER_INVOICE_RELEASE_BLOCKED");
    await expectHeldWithoutAp(id);
  });

  it("PI-06 a service line is held for review; PPN above 12% of DPP, PPh 23 without service and PPh 23 above the service amount answer 422", async () => {
    const po = await receivedPo();
    const withService = await createInvoice(
      A,
      buyer,
      invoiceBody(A, po, { lines: [goodsLine(po), serviceLine(50_000)] }),
    );
    expect(withService.status, JSON.stringify(withService.body)).toBe(201);
    expect(invoiceOf(withService).invoice.status).toBe("held");
    expect(String(invoiceOf(withService).invoice.matchNote)).toContain(
      "service_lines_need_review",
    );
    await expectHeldWithoutAp(invoiceOf(withService).invoice.id);

    const before = await footprint(A);
    const cases: [string, Record<string, unknown>][] = [
      ["PPN 12,001%", { ppnIdr: 12_001 }],
      ["PPh 23 without service line", { pph23Idr: 1_000 }],
    ];
    for (const [label, extra] of cases) {
      const fresh = await receivedPo();
      const res = await createInvoice(A, buyer, invoiceBody(A, fresh, extra));
      expect(res.status, label).toBe(422);
    }
    const tooMuch = await receivedPo();
    const over = await createInvoice(
      A,
      buyer,
      invoiceBody(A, tooMuch, {
        lines: [goodsLine(tooMuch), serviceLine(10_000)],
        pph23Idr: 10_001,
      }),
    );
    expect(over.status).toBe(422);
    expect(await footprint(A)).toEqual(before);

    // Control: PPN exactly 12% of the DPP is accepted.
    const edge = await receivedPo();
    const ok = await createInvoice(
      A,
      buyer,
      invoiceBody(A, edge, { ppnIdr: 12_000 }),
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(invoiceOf(ok).invoice.status).toBe("matched");
  });

  it("PI-07 a duplicate number of the same supplier is refused with 409, even with other case and spaces; a rejected number can be reused", async () => {
    const supplierId = await insertSupplier(A);
    const po = await receive(A, warehouse, await seedPo(A, { supplierId }));
    const number = `DUP-${randomUUID().slice(0, 6)}`.toUpperCase();
    const first = await createInvoice(
      A,
      buyer,
      invoiceBody(A, po, {
        number,
        lines: [goodsLine(po, "5.0000", "10500.0000")],
      }),
    );
    expect(first.status).toBe(201);
    expect(invoiceOf(first).invoice.status).toBe("held");
    const before = await footprint(A);
    const dup = await createInvoice(
      A,
      buyer,
      invoiceBody(A, po, {
        number: ` ${number.toLowerCase()} `,
        lines: [goodsLine(po, "5.0000")],
      }),
    );
    expect(dup.status).toBe(409);
    expect(codeOf(dup)).toBe("SUPPLIER_INVOICE_DUPLICATE");
    expect(await footprint(A)).toEqual(before);

    const rejected = await decide(
      A,
      buyer,
      invoiceOf(first).invoice.id,
      "reject",
      "Pemasok salah harga, minta faktur koreksi",
    );
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    const again = await createInvoice(
      A,
      buyer,
      invoiceBody(A, po, { number, lines: [goodsLine(po, "5.0000")] }),
    );
    expect(again.status, JSON.stringify(again.body)).toBe(201);
  });
});

describe("ws-purchasing-apar PI hold, release, reject, rematch", () => {
  const heldByPrice = async (who = buyer, price = "10500.0000") => {
    const po = await receivedPo();
    const res = await createInvoice(
      A,
      who,
      invoiceBody(A, po, { lines: [goodsLine(po, "10.0000", price)] }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(invoiceOf(res).invoice.status).toBe("held");
    return { po, id: invoiceOf(res).invoice.id };
  };

  it("PI-08 release: the recorder, a purchasing user and a short note are refused; a quantity hold is blocked; finance releases a price hold for the invoice amount", async () => {
    const { id } = await heldByPrice();
    const before = await footprint(A);

    const byPurchasing = await decide(A, buyer, id, "release");
    expect(byPurchasing.status).toBe(403);
    const byNobody = await decide(A, nobody, id, "release");
    expect(byNobody.status).toBe(403);
    const shortNote = await decide(A, finance2, id, "release", "ok");
    expect(shortNote.status).toBe(422);
    await expectHeldWithoutAp(id);

    // The finance user who recorded the invoice cannot release it.
    const po = await receivedPo();
    const own = await createInvoice(
      A,
      finance1,
      invoiceBody(A, po, {
        lines: [goodsLine(po, "10.0000", "10500.0000")],
      }),
    );
    const ownId = invoiceOf(own).invoice.id;
    expect(invoiceOf(own).invoice.status).toBe("held");
    const self = await decide(A, finance1, ownId, "release");
    expect(self.status).toBe(403);
    expect(codeOf(self)).toBe("SUPPLIER_INVOICE_SELF_RELEASE");
    await expectHeldWithoutAp(ownId);

    // Quantity above the receipt cannot be released at all.
    const qtyPo = await receivedPo();
    const qty = await createInvoice(
      A,
      buyer,
      invoiceBody(A, qtyPo, { lines: [goodsLine(qtyPo, "11.0000")] }),
    );
    const qtyId = invoiceOf(qty).invoice.id;
    const blocked = await decide(A, finance2, qtyId, "release");
    expect(blocked.status).toBe(409);
    expect(codeOf(blocked)).toBe("SUPPLIER_INVOICE_RELEASE_BLOCKED");
    await expectHeldWithoutAp(qtyId);
    expect((await footprint(A)).journals).toBe(before.journals);

    // Finance (another person) releases the price hold: AP = the invoice amount.
    const released = await decide(A, finance2, id, "release");
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(invoiceOf(released).invoice.status).toBe("released");
    const row = await invoiceRow(A, id);
    expect(row?.status).toBe("released");
    expect(row?.decided_by).toBe(finance2.userId);
    expect(Number(row?.payable_idr)).toBe(105_000);
    expect(Number((await openItemOf(A, id))?.original_idr)).toBe(105_000);
    expect(await taxRecordExists(A, id)).toBe(true);
    expect(await journalLines(A, (await journalOf(A, id))!)).toEqual({
      grni: { debit: 100_000, credit: 0 },
      purchase_price_variance: { debit: 5_000, credit: 0 },
      accounts_payable: { debit: 0, credit: 105_000 },
    });
    expect(await apCard(A)).toBe(await apLedger(A));
    // Released twice: no second open item (still one, same amount).
    const again = await decide(A, finance2, id, "release");
    expect(again.status).toBe(409);
    expect(Number((await openItemOf(A, id))?.original_idr)).toBe(105_000);
  });

  it("PI-09 a matched invoice cannot be rejected; a held one can, and a rejected one cannot be released", async () => {
    const po = await receivedPo();
    const matchedId = await matchedInvoice(po, "10.0000");
    const rejectMatched = await decide(A, finance2, matchedId, "reject");
    expect(rejectMatched.status).toBe(409);
    expect((await invoiceRow(A, matchedId))?.status).toBe("matched");
    expect(await openItemOf(A, matchedId)).not.toBeNull();

    const { id } = await heldByPrice();
    const rejected = await decide(
      A,
      buyer,
      id,
      "reject",
      "Harga tidak sesuai PO, ditolak",
    );
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(invoiceOf(rejected).invoice.status).toBe("rejected");
    expect((await invoiceRow(A, id))?.decided_by).toBe(buyer.userId);
    expect(await openItemOf(A, id)).toBeNull();
    const release = await decide(A, finance2, id, "release");
    expect(release.status).toBe(409);
    expect(codeOf(release)).toBe("SUPPLIER_INVOICE_NOT_HELD");
  });

  it("PI-10 rematch uses the current tolerance: still held while out of tolerance, matched with AP once the policy allows it", async () => {
    const { id } = await heldByPrice(buyer, "10100.0000"); // +100 bp at 0 bp
    const still = await rematch(A, buyer, id);
    expect(still.status, JSON.stringify(still.body)).toBe(200);
    expect(invoiceOf(still).invoice.status).toBe("held");
    await expectHeldWithoutAp(id);

    await setTolerance(A, 200, finance1.userId);
    const now = await rematch(A, buyer, id);
    expect(now.status, JSON.stringify(now.body)).toBe(200);
    expect(invoiceOf(now).invoice.status).toBe("matched");
    expect(Number((await openItemOf(A, id))?.original_idr)).toBe(101_000);
    expect(await taxRecordExists(A, id)).toBe(true);
    expect(await journalOf(A, id)).not.toBeNull();
  });

  it("PI-11 the tolerance can be set through the policy endpoint and drives the match end to end", async () => {
    const put = await api.put(A, finance2, "/purchasing-policy", {
      threeWayMatchToleranceBp: 200,
      expectedUpdatedAt: null,
      idempotencyKey: key(),
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const po = await receivedPo();
    const res = await createInvoice(
      A,
      buyer,
      invoiceBody(A, po, {
        lines: [goodsLine(po, "10.0000", "10200.0000")],
      }),
    );
    expect(invoiceOf(res).invoice.status).toBe("matched");
  });
});

describe("ws-purchasing-apar PI posting gate (K5)", () => {
  it("PI-12 gate off: a matched outcome and a release answer 409 SUPPLIER_INVOICE_POSTING_DISABLED and write nothing; a held outcome is still stored", async () => {
    const po = await receivedPo();
    const po2 = await receivedPo();
    const heldPo = await receivedPo();
    const heldRes = await createInvoice(
      A,
      buyer,
      invoiceBody(A, heldPo, {
        lines: [goodsLine(heldPo, "10.0000", "10500.0000")],
      }),
    );
    const heldId = invoiceOf(heldRes).invoice.id;
    expect(invoiceOf(heldRes).invoice.status).toBe("held");

    setSupplierInvoicePostingEnabled(false);
    const before = await footprint(A);
    const body = invoiceBody(A, po);
    const refused = await createInvoice(A, buyer, body);
    expect(refused.status).toBe(409);
    expect(codeOf(refused)).toBe("SUPPLIER_INVOICE_POSTING_DISABLED");
    expect(await footprint(A)).toEqual(before);

    const heldAllowed = await createInvoice(
      A,
      buyer,
      invoiceBody(A, po2, { lines: [goodsLine(po2, "11.0000")] }),
    );
    expect(heldAllowed.status).toBe(201);
    expect(invoiceOf(heldAllowed).invoice.status).toBe("held");

    const release = await decide(A, finance2, heldId, "release");
    expect(release.status).toBe(409);
    expect(codeOf(release)).toBe("SUPPLIER_INVOICE_POSTING_DISABLED");
    await expectHeldWithoutAp(heldId);

    // Gate on again: the very same request now succeeds (nothing was claimed).
    setSupplierInvoicePostingEnabled(true);
    const retry = await createInvoice(A, buyer, body);
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    expect(invoiceOf(retry).invoice.status).toBe("matched");
  });
});

describe("ws-purchasing-apar PI idempotency and validation", () => {
  it("PI-13 the same key replays the first invoice; the same key with another body is refused; strict bodies", async () => {
    const po = await receivedPo();
    const body = invoiceBody(A, po);
    const first = await createInvoice(A, buyer, body);
    expect(first.status).toBe(201);
    const replay = await createInvoice(A, buyer, body);
    expect(replay.status, JSON.stringify(replay.body)).toBeLessThan(300);
    expect(invoiceIdOf(replay)).toBe(invoiceIdOf(first));
    expect(await invoiceRowsOfPo(A, po.poId)).toHaveLength(1);
    expect(await apLedger(A)).toBe(await apCard(A));

    const other = await createInvoice(A, buyer, {
      ...body,
      number: `${String(body.number)}-X`,
    });
    expect(other.status).toBe(409);
    expect(codeOf(other)).toBe("IDEMPOTENCY_KEY_REUSED");

    const unknownField = await createInvoice(
      A,
      buyer,
      invoiceBody(A, po, { tenantId: B.tenantId }),
    );
    expect(unknownField.status).toBe(422);
    const noKey = await createInvoice(A, buyer, {
      ...invoiceBody(A, po),
      idempotencyKey: undefined,
    });
    expect(noKey.status).toBe(422);
    const dueBefore = await createInvoice(
      A,
      buyer,
      invoiceBody(A, po, { dueDate: addDays(today(), -5) }),
    );
    expect(dueBefore.status).toBe(422);
  });
});

describe("ws-purchasing-apar PI full rollback (aturan uang 3)", () => {
  /** Removes a mapping, runs `act`, expects nothing written, restores. */
  async function withoutMapping(
    role: "grni" | "accounts_payable",
    act: () => Promise<void>,
  ) {
    const { rows } = await owner.query<{ account_id: string }>(
      "SELECT account_id FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = $3",
      [A.tenantId, A.entityId, role],
    );
    await owner.query(
      "DELETE FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = $3",
      [A.tenantId, A.entityId, role],
    );
    try {
      await act();
    } finally {
      await owner.query(
        `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
         VALUES ($1, $2, $3, $4)`,
        [A.tenantId, A.entityId, role, rows[0]!.account_id],
      );
    }
  }

  it.each(["grni", "accounts_payable"] as const)(
    "PI-14 a missing %s mapping fails the create with ACCOUNT_MAPPING_MISSING and leaves no row; the same key works after the mapping returns",
    async (role) => {
      const po = await receivedPo();
      const body = invoiceBody(A, po);
      const before = await footprint(A);
      await withoutMapping(role, async () => {
        const res = await createInvoice(A, buyer, body);
        expect(codeOf(res)).toBe("ACCOUNT_MAPPING_MISSING");
        expect(await footprint(A)).toEqual(before);
      });
      const retry = await createInvoice(A, buyer, body);
      expect(retry.status, JSON.stringify(retry.body)).toBe(201);
      expect(invoiceOf(retry).invoice.status).toBe("matched");
    },
  );

  it("PI-15 a closed fiscal period fails the create with PERIOD_CLOSED and leaves no row", async () => {
    const po = await receivedPo();
    const date = await closedPastDate(A);
    const before = await footprint(A);
    const res = await createInvoice(
      A,
      buyer,
      invoiceBody(A, po, { invoiceDate: date, dueDate: addDays(date, 30) }),
    );
    expect(res.status).toBe(409);
    expect(codeOf(res)).toBe("PERIOD_CLOSED");
    expect(await footprint(A)).toEqual(before);
  });

  it("PI-16 a release that cannot post (mapping missing) leaves the invoice held; after the mapping returns the release works", async () => {
    const po = await receivedPo();
    const held = await createInvoice(
      A,
      buyer,
      invoiceBody(A, po, {
        lines: [goodsLine(po, "10.0000", "10500.0000")],
      }),
    );
    const id = invoiceOf(held).invoice.id;
    const before = await footprint(A);
    await withoutMapping("accounts_payable", async () => {
      const res = await decide(A, finance2, id, "release");
      expect(codeOf(res)).toBe("ACCOUNT_MAPPING_MISSING");
      await expectHeldWithoutAp(id);
      expect((await invoiceRow(A, id))?.decided_by).toBeNull();
      expect(await footprint(A)).toEqual(before);
    });
    const ok = await decide(A, finance2, id, "release");
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await openItemOf(A, id)).not.toBeNull();
  });

  it("PI-17 PPh 23 without a supplier NPWP: the held invoice cannot be released and nothing is written; with the NPWP the release posts the withholding", async () => {
    const supplierId = await insertSupplier(A, null);
    const po = await receive(A, warehouse, await seedPo(A, { supplierId }));
    const res = await createInvoice(
      A,
      buyer,
      invoiceBody(A, po, {
        lines: [goodsLine(po), serviceLine(200_000)],
        ppnIdr: 33_000,
        pph23Idr: 4_000,
      }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const id = invoiceOf(res).invoice.id;
    expect(invoiceOf(res).invoice.status).toBe("held");
    expect(invoiceOf(res).invoice.payableIdr).toBe(329_000);
    const before = await footprint(A);
    const fail = await decide(A, finance2, id, "release");
    expect(fail.status).toBeGreaterThanOrEqual(400);
    expect(fail.status).toBeLessThan(500);
    await expectHeldWithoutAp(id);
    expect(await footprint(A)).toEqual(before);

    await owner.query(
      "UPDATE suppliers SET npwp = '01.234.567.8-901.000' WHERE id = $1",
      [supplierId],
    );
    const ok = await decide(A, finance2, id, "release");
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(Number((await openItemOf(A, id))?.original_idr)).toBe(329_000);
    const lines = await journalLines(A, (await journalOf(A, id))!);
    expect(lines.pph23_payable).toEqual({ debit: 0, credit: 4_000 });
    expect(lines.service_expense).toEqual({ debit: 200_000, credit: 0 });
    expect(lines.accounts_payable).toEqual({ debit: 0, credit: 329_000 });
  });
});

describe("ws-purchasing-apar PI tenant isolation (aturan uang 4)", () => {
  it("PI-18 another tenant cannot read, match, release or reject an invoice, and the invoice is unchanged", async () => {
    const po = await receivedPo();
    const held = await createInvoice(
      A,
      buyer,
      invoiceBody(A, po, {
        lines: [goodsLine(po, "10.0000", "10500.0000")],
      }),
    );
    const id = invoiceOf(held).invoice.id;
    const before = await footprint(A);

    // Positive control: the owner tenant reads it.
    const own = await api.get(A, finance2, `/supplier-invoices/${id}`);
    expect(own.status, JSON.stringify(own.body)).toBe(200);

    expect(
      (await api.get(B, financeB, `/supplier-invoices/${id}`)).status,
    ).toBe(404);
    expect((await rematch(B, financeB, id)).status).toBe(404);
    expect((await decide(B, financeB, id, "release")).status).toBe(404);
    expect((await decide(B, financeB, id, "reject")).status).toBe(404);
    const list = await api.get(
      B,
      financeB,
      `/supplier-invoices?outletId=${B.outletId}&limit=100`,
    );
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(
      (list.body as { data: { id: string }[] }).data.map((row) => row.id),
    ).not.toContain(id);
    await expectHeldWithoutAp(id);
    expect(await footprint(A)).toEqual(before);
  });

  it("PI-19 a create that names another tenant's order or supplier is refused and writes nothing", async () => {
    const po = await receivedPo();
    const foreignPo = await seedPo(B);
    const before = await footprint(A);
    const beforeB = await footprint(B);

    const foreignOrder = await createInvoice(
      A,
      buyer,
      invoiceBody(A, foreignPo, { supplierId: po.supplierId }),
    );
    expect([404, 422]).toContain(foreignOrder.status);
    const foreignSupplier = await createInvoice(
      A,
      buyer,
      invoiceBody(A, po, { supplierId: foreignPo.supplierId }),
    );
    expect([404, 422]).toContain(foreignSupplier.status);
    // A user of tenant B naming tenant A's outlet and order.
    const crossTenant = await createInvoice(B, buyerB, invoiceBody(A, po));
    expect([403, 404, 422]).toContain(crossTenant.status);
    expect(await footprint(A)).toEqual(before);
    expect(await footprint(B)).toEqual(beforeB);
  });

  it("PI-20 a user whose role covers only another outlet is refused; guards for anonymous and missing Origin", async () => {
    const po = await receivedPo();
    const deniedCreate = await createInvoice(
      A,
      outletTwoBuyer,
      invoiceBody(A, po),
    );
    expect(deniedCreate.status).toBe(403);
    const deniedList = await api.get(
      A,
      outletTwoBuyer,
      `/supplier-invoices?outletId=${A.outletId}`,
    );
    expect(deniedList.status).toBe(403);
    // Control: the same user may list its own outlet.
    const ownList = await api.get(
      A,
      outletTwoBuyer,
      `/supplier-invoices?outletId=${A.outletTwoId}`,
    );
    expect(ownList.status, JSON.stringify(ownList.body)).toBe(200);

    const id = await matchedInvoice(po, "10.0000");
    expect([403, 404]).toContain(
      (await api.get(A, outletTwoBuyer, `/supplier-invoices/${id}`)).status,
    );
    expect([403, 404]).toContain((await rematch(A, outletTwoBuyer, id)).status);
    expect((await invoiceRow(A, id))?.status).toBe("matched");

    const anonymous = await agent(app)
      .post("/api/inventory/supplier-invoices")
      .set(originHeader)
      .set("Host", A.hostname)
      .send(invoiceBody(A, po));
    expect(anonymous.status).toBe(401);
    const noOrigin = await buyer.client
      .post("/api/inventory/supplier-invoices")
      .set("Host", A.hostname)
      .send(invoiceBody(A, po));
    expect(noOrigin.status).toBe(403);
  });

  it("PI-21 row level security hides the three new tables from another tenant", async () => {
    const po = await receivedPo();
    const id = await matchedInvoice(po, "10.0000");
    const count = (tenantId: string, table: string, column: string) =>
      asApp(tenantId, async (query) => {
        const rows = (await query(
          `SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`,
          [id],
        )) as { n: number }[];
        return rows[0]!.n;
      });
    // Positive control: the owning tenant sees its rows.
    expect(await count(A.tenantId, "purchase_invoices", "id")).toBe(1);
    expect(
      await count(A.tenantId, "purchase_invoice_lines", "purchase_invoice_id"),
    ).toBeGreaterThanOrEqual(1);
    expect(await count(B.tenantId, "purchase_invoices", "id")).toBe(0);
    expect(
      await count(B.tenantId, "purchase_invoice_lines", "purchase_invoice_id"),
    ).toBe(0);
    const policy = (tenantId: string) =>
      asApp(tenantId, async (query) => {
        const rows = (await query(
          "SELECT count(*)::int AS n FROM purchasing_policies WHERE tenant_id = $1",
          [A.tenantId],
        )) as { n: number }[];
        return rows[0]!.n;
      });
    await setTolerance(A, 100, finance1.userId);
    expect(await policy(A.tenantId)).toBe(1);
    expect(await policy(B.tenantId)).toBe(0);
  });
});
