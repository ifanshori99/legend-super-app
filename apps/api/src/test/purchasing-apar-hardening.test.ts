// Architect review hardening R1-R4 (card ws/purchasing-apar, design
// docs/briefs/ws-purchasing-apar-design.md section 13). Written fail-first from
// the design, not from the implementation. Money rule (founder): nobody is paid
// more and the outlet never loses; a refused write leaves nothing behind.
//
// Ids used in test names:
// - HD-R1a supplier invoice posting needs the accounting module (409, no trace)
// - HD-R1b held invoice may be stored, but its release is refused without it
// - HD-R1c purchase return with an invoiced part is refused without it
// - HD-R2  direct UPDATE as legend_app: status transitions, frozen rows
// - HD-R3  asset guard sees invoices of every outlet of the tenant
// - HD-R4  held / rejected invoice has nothing outstanding
//
// Assumptions (the design does not pin these down):
// - "Accounting module off" = the tenant's `feature_flags.modules` lacks
//   "accounting" (written as the migration owner, then restored).
// - R1c code: per the coordinator, SUPPLIER_INVOICE_POSTING_DISABLED (409), no
//   `purchase_returns` row, no outbox event, no stock movement, and the same
//   idempotency key works again once the module is back. A return with no
//   invoiced part still succeeds (201) with the module off. A held invoice may
//   still be created (201) with the module off (it posts nothing).
// - R2 direct SQL runs as `legend_app` with RLS on (asApp). Only columns the
//   design lists as updatable are touched, so a refusal can only come from the
//   trigger. The error text is not pinned, only that the UPDATE is refused.
//   A held -> rejected update that fills decided_by / decided_at /
//   decision_note is the allowed control.
// - R3: the invoice sits in outlet 2, the asset is registered under a context
//   scoped to outlet 1 only (RLS hides the invoice there); 409 is expected
//   for a matched and for a held invoice. Registering with no source document
//   stays allowed.
// - R4: `outstandingIdr` is read from GET detail and GET list; a matched
//   invoice keeps outstanding = payable (positive control).
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { userIdSchema, type UserId } from "@starter/shared/core";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { createFixedAsset } from "../services/accounting-fixed-assets.service.ts";
import { setPurchaseReturnPostingEnabled } from "../services/purchase-return.service.ts";
import { setSupplierInvoicePostingEnabled } from "../services/purchasing-invoice.service.ts";
import {
  addUser,
  api,
  asApp,
  codeOf,
  contextFor,
  createInvoice,
  createWorld,
  decide,
  footprint,
  goodsLine,
  invoiceBody,
  invoiceIdOf,
  invoiceRow,
  journalOf,
  key,
  openItemOf,
  owner,
  receive,
  returnGoods,
  seedPo,
  taxRecordExists,
  today,
  type Po,
  type Session,
  type World,
} from "./purchasing-apar-helpers.ts";

const actor: UserId = userIdSchema.parse(randomUUID());

// One tenant per rule so toggling the module never touches another test.
let R1: World;
let R2: World;
let R3: World;
let R4: World;

type Users = {
  buyer: Session;
  finance1: Session;
  finance2: Session;
  warehouse: Session;
};

async function users(world: World, label: string): Promise<Users> {
  return {
    buyer: await addUser(world, `${label} buyer`, [
      { role: "purchasing", outletId: world.outletId },
    ]),
    finance1: await addUser(world, `${label} finance 1`, [
      { role: "finance", outletId: null },
    ]),
    finance2: await addUser(world, `${label} finance 2`, [
      { role: "finance", outletId: null },
    ]),
    warehouse: await addUser(world, `${label} warehouse`, [
      { role: "warehouse", outletId: world.outletId },
    ]),
  };
}

let u1: Users;
let u2: Users;
let u3: Users;
let u4: Users;
let outletTwoBuyer: Session;

async function setAccountingModule(
  world: World,
  enabled: boolean,
): Promise<void> {
  await owner.query(
    `UPDATE tenants
        SET feature_flags = jsonb_set(
              feature_flags, '{modules}',
              (SELECT coalesce(jsonb_agg(m), '[]'::jsonb)
                 FROM jsonb_array_elements(feature_flags->'modules') AS m
                WHERE m <> '"accounting"'::jsonb)
              || CASE WHEN $2::boolean THEN '["accounting"]'::jsonb ELSE '[]'::jsonb END)
      WHERE id = $1`,
    [world.tenantId, enabled],
  );
}

async function received(
  world: World,
  warehouse: Session,
  options: { quantity?: string; unitPrice?: string; outletId?: string } = {},
): Promise<Po> {
  return receive(world, warehouse, await seedPo(world, options));
}

const invoiceData = (res: { body: unknown }) =>
  (res.body as { data: { invoice: Record<string, unknown> & { id: string } } })
    .data.invoice;

/** A held invoice: PO price +50 percent is above any allowed tolerance. */
async function heldInvoice(
  world: World,
  who: Session,
  po: Po,
  outletId = world.outletId,
): Promise<string> {
  const res = await createInvoice(
    world,
    who,
    invoiceBody(world, po, {
      outletId,
      lines: [goodsLine(po, po.quantity, "15000.0000")],
    }),
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(invoiceData(res).status).toBe("held");
  return invoiceIdOf(res);
}

async function matchedInvoice(
  world: World,
  who: Session,
  po: Po,
  outletId = world.outletId,
): Promise<string> {
  const res = await createInvoice(
    world,
    who,
    invoiceBody(world, po, { outletId }),
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(invoiceData(res).status).toBe("matched");
  return invoiceIdOf(res);
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  setPurchaseReturnPostingEnabled(true);
  setSupplierInvoicePostingEnabled(true);
  [R1, R2, R3, R4] = await Promise.all([
    createWorld("r1"),
    createWorld("r2"),
    createWorld("r3"),
    createWorld("r4"),
  ]);
  u1 = await users(R1, "R1");
  u2 = await users(R2, "R2");
  u3 = await users(R3, "R3");
  u4 = await users(R4, "R4");
  // The R3 invoices belong to outlet 2, so receiving them needs the warehouse
  // role there too.
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
    [R3.tenantId, u3.warehouse.userId, R3.roles.warehouse, R3.outletTwoId],
  );
  outletTwoBuyer = await addUser(R3, "R3 buyer outlet 2", [
    { role: "purchasing", outletId: R3.outletTwoId },
  ]);
});

afterEach(async () => {
  setPurchaseReturnPostingEnabled(true);
  setSupplierInvoicePostingEnabled(true);
  await setAccountingModule(R1, true);
});

afterAll(async () => {
  setAuditWriter(null);
  setPurchaseReturnPostingEnabled(null);
  setSupplierInvoicePostingEnabled(null);
  // Tenant rows stay (journals are append-only, names are random).
});

// ---- R1 ----------------------------------------------------------------------

describe("R1 AP posting needs the accounting module", () => {
  it("HD-R1a a clean invoice is refused with 409 and writes nothing when the tenant has no accounting module", async () => {
    const po = await received(R1, u1.warehouse);
    await setAccountingModule(R1, false);
    const before = await footprint(R1);
    const body = invoiceBody(R1, po);

    const refused = await createInvoice(R1, u1.buyer, body);

    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(codeOf(refused)).toBe("SUPPLIER_INVOICE_POSTING_DISABLED");
    expect(await footprint(R1)).toEqual(before);

    // Module back: the very same request succeeds, so no claim was left behind.
    await setAccountingModule(R1, true);
    const retry = await createInvoice(R1, u1.buyer, body);
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    expect(invoiceData(retry).status).toBe("matched");
    expect(await openItemOf(R1, invoiceIdOf(retry))).not.toBeNull();
  });

  it("HD-R1b a held invoice can still be stored, but its release is refused with 409 and stays held", async () => {
    const heldPo = await received(R1, u1.warehouse);
    const heldId = await heldInvoice(R1, u1.buyer, heldPo);
    const otherPo = await received(R1, u1.warehouse);
    await setAccountingModule(R1, false);

    // Held outcome posts nothing, so storing it is still allowed.
    const stored = await createInvoice(
      R1,
      u1.buyer,
      invoiceBody(R1, otherPo, {
        lines: [goodsLine(otherPo, otherPo.quantity, "15000.0000")],
      }),
    );
    expect(stored.status, JSON.stringify(stored.body)).toBe(201);
    expect(invoiceData(stored).status).toBe("held");

    const before = await footprint(R1);
    const release = await decide(R1, u1.finance2, heldId, "release");
    expect(release.status, JSON.stringify(release.body)).toBe(409);
    expect(codeOf(release)).toBe("SUPPLIER_INVOICE_POSTING_DISABLED");
    expect(await footprint(R1)).toEqual(before);
    const row = await invoiceRow(R1, heldId);
    expect(row?.status).toBe("held");
    expect(row?.journal_entry_id).toBeNull();
    expect(await openItemOf(R1, heldId)).toBeNull();
    expect(await taxRecordExists(R1, heldId)).toBe(false);
    expect(await journalOf(R1, heldId)).toBeNull();
  });

  it("HD-R1c a return with an invoiced part is refused with 409 and records nothing when accounting is off", async () => {
    const po = await received(R1, u1.warehouse);
    await matchedInvoice(R1, u1.buyer, po);
    await setAccountingModule(R1, false);
    const count = async (sql: string) =>
      Number((await owner.query<{ n: string }>(sql, [R1.tenantId])).rows[0]!.n);
    const returns = () =>
      count(
        "SELECT count(*)::text AS n FROM purchase_returns WHERE tenant_id = $1",
      );
    const events = () =>
      count(
        "SELECT count(*)::text AS n FROM domain_event_outbox WHERE tenant_id = $1 AND event->>'name' = 'purchase_return.recorded'",
      );
    const stock = async () =>
      (
        await owner.query<{ q: string }>(
          "SELECT coalesce(sum(quantity), 0)::text AS q FROM stock_balances WHERE tenant_id = $1 AND location_id = $2",
          [R1.tenantId, po.locationId],
        )
      ).rows[0]!.q;
    const returnsBefore = await returns();
    const eventsBefore = await events();
    const stockBefore = await stock();

    const refused = await returnGoods(R1, u1.warehouse, po, "3.0000");

    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(codeOf(refused)).toBe("SUPPLIER_INVOICE_POSTING_DISABLED");
    expect(await returns()).toBe(returnsBefore);
    expect(await events()).toBe(eventsBefore);
    expect(await stock()).toBe(stockBefore);
  });

  it("HD-R1c control: a return with nothing invoiced still goes through when accounting is off", async () => {
    const po = await received(R1, u1.warehouse);
    await setAccountingModule(R1, false);

    const res = await returnGoods(R1, u1.warehouse, po, "3.0000");

    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});

// ---- R2 ----------------------------------------------------------------------

describe("R2 the database refuses illegal invoice status changes", () => {
  let heldId: string;
  let matchedId: string;
  let matchedOtherId: string;
  let releasedId: string;
  let rejectedId: string;

  beforeAll(async () => {
    heldId = await heldInvoice(R2, u2.buyer, await received(R2, u2.warehouse));
    matchedId = await matchedInvoice(
      R2,
      u2.buyer,
      await received(R2, u2.warehouse),
    );
    matchedOtherId = await matchedInvoice(
      R2,
      u2.buyer,
      await received(R2, u2.warehouse),
    );
    releasedId = await heldInvoice(
      R2,
      u2.buyer,
      await received(R2, u2.warehouse),
    );
    const release = await decide(R2, u2.finance1, releasedId, "release");
    expect(release.status, JSON.stringify(release.body)).toBeLessThan(300);
    rejectedId = await heldInvoice(
      R2,
      u2.buyer,
      await received(R2, u2.warehouse),
    );
    const reject = await decide(R2, u2.finance1, rejectedId, "reject");
    expect(reject.status, JSON.stringify(reject.body)).toBeLessThan(300);
    expect((await invoiceRow(R2, releasedId))?.status).toBe("released");
    expect((await invoiceRow(R2, rejectedId))?.status).toBe("rejected");
  });

  /** Runs one UPDATE of the invoice as legend_app (RLS on, rolled back). */
  const update = (id: string, set: string, params: unknown[] = []) =>
    asApp(R2.tenantId, (query) =>
      query(
        `UPDATE purchase_invoices SET ${set} WHERE id = $1 AND tenant_id = '${R2.tenantId}' RETURNING id`,
        [id, ...params],
      ),
    );

  it("HD-R2a controls: a held row may keep its status while a note changes, and may be rejected with a decision", async () => {
    const same = (await update(
      heldId,
      "status = 'held', match_note = 'catatan baru'",
    )) as unknown[];
    expect(same).toHaveLength(1);

    const decided = (await update(
      heldId,
      "status = 'rejected', decided_by = $2, decided_at = now(), decision_note = 'Ditolak, pemasok kirim faktur koreksi'",
      [u2.finance1.userId],
    )) as unknown[];
    expect(decided).toHaveLength(1);
  });

  it("HD-R2b a matched invoice cannot go back to held or be rejected", async () => {
    await expect(update(matchedId, "status = 'held'")).rejects.toThrow();
    await expect(
      update(
        matchedId,
        "status = 'rejected', decided_by = $2, decided_at = now(), decision_note = 'Dibatalkan lewat SQL langsung'",
        [u2.finance1.userId],
      ),
    ).rejects.toThrow();
  });

  it("HD-R2c a released invoice cannot go back to held or matched", async () => {
    await expect(update(releasedId, "status = 'held'")).rejects.toThrow();
    await expect(update(releasedId, "status = 'matched'")).rejects.toThrow();
  });

  it("HD-R2d a rejected invoice is final", async () => {
    await expect(update(rejectedId, "status = 'held'")).rejects.toThrow();
    await expect(update(rejectedId, "status = 'matched'")).rejects.toThrow();
    await expect(update(rejectedId, "status = 'released'")).rejects.toThrow();
  });

  it("HD-R2e the journal link cannot be cleared or swapped once set", async () => {
    const journal = await journalOf(R2, matchedOtherId);
    expect(journal).not.toBeNull();
    expect((await invoiceRow(R2, matchedId))?.journal_entry_id).not.toBeNull();
    await expect(
      update(matchedId, "journal_entry_id = NULL"),
    ).rejects.toThrow();
    await expect(
      update(matchedId, "journal_entry_id = $2", [journal]),
    ).rejects.toThrow();
    // The released invoice (held first, journal added at release) too.
    await expect(
      update(releasedId, "journal_entry_id = NULL"),
    ).rejects.toThrow();
  });

  it("HD-R2f a matched, released or rejected row is frozen except updated_at", async () => {
    for (const id of [matchedId, releasedId, rejectedId]) {
      await expect(
        update(id, "match_note = 'diubah lewat SQL'"),
      ).rejects.toThrow();
      await expect(update(id, "tolerance_bp = 1000")).rejects.toThrow();
    }
    // Control: touching only updated_at is allowed.
    for (const id of [matchedId, releasedId, rejectedId])
      expect(
        (await update(id, "updated_at = now()")) as unknown[],
      ).toHaveLength(1);
  });

  it("HD-R2g nothing above was written: statuses are unchanged", async () => {
    expect((await invoiceRow(R2, matchedId))?.status).toBe("matched");
    expect((await invoiceRow(R2, releasedId))?.status).toBe("released");
    expect((await invoiceRow(R2, rejectedId))?.status).toBe("rejected");
    expect((await invoiceRow(R2, heldId))?.status).toBe("held");
  });
});

// ---- R3 ----------------------------------------------------------------------

describe("R3 the asset guard sees invoices of every outlet", () => {
  const assetInput = (sourceId: string | null) => ({
    legalEntityId: R3.entityId,
    outletId: R3.outletId,
    name: "Mesin espresso",
    acquiredOn: today(),
    costIdr: 5_000_000,
    residualValueIdr: 0,
    usefulLifeMonths: 12,
    depreciationStartPeriod: today().slice(0, 7),
    sourceDocumentId: sourceId,
    // The guard refuses before the supplier is read, so any id does.
    payable:
      sourceId === null
        ? null
        : {
            supplierId: randomUUID(),
            documentNumber: "AST-R3",
            documentDate: today(),
            dueOn: today(),
          },
    idempotencyKey: key(),
  });

  const assetCount = async () =>
    Number(
      (
        await owner.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM fixed_assets WHERE tenant_id = $1",
          [R3.tenantId],
        )
      ).rows[0]!.n,
    );
  const journalCount = async () =>
    Number(
      (
        await owner.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1",
          [R3.tenantId],
        )
      ).rows[0]!.n,
    );

  it("HD-R3a a finance user limited to outlet 1 cannot register an asset from a matched invoice of outlet 2", async () => {
    const po = await received(R3, u3.warehouse, { outletId: R3.outletTwoId });
    const invoiceId = await matchedInvoice(
      R3,
      outletTwoBuyer,
      po,
      R3.outletTwoId,
    );
    const journalsBefore = await journalCount();
    const assetsBefore = await assetCount();

    await expect(
      createFixedAsset(
        contextFor(R3, R3.outletId),
        assetInput(invoiceId) as never,
        actor,
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(await journalCount()).toBe(journalsBefore);
    expect(await assetCount()).toBe(assetsBefore);
  });

  it("HD-R3b the same for a held invoice of outlet 2", async () => {
    const po = await received(R3, u3.warehouse, { outletId: R3.outletTwoId });
    const invoiceId = await heldInvoice(R3, outletTwoBuyer, po, R3.outletTwoId);
    const journalsBefore = await journalCount();

    await expect(
      createFixedAsset(
        contextFor(R3, R3.outletId),
        assetInput(invoiceId) as never,
        actor,
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(await journalCount()).toBe(journalsBefore);
  });

  it("HD-R3c control: the same user can register an asset with no source document", async () => {
    const created = await createFixedAsset(
      contextFor(R3, R3.outletId),
      assetInput(null) as never,
      actor,
    );
    expect(created.costIdr).toBe(5_000_000);
  });
});

// ---- R4 ----------------------------------------------------------------------

describe("R4 a held or rejected invoice has nothing outstanding", () => {
  const outstanding = async (id: string) => {
    const detail = await api.get(R4, u4.finance1, `/supplier-invoices/${id}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    const fromDetail = invoiceData(detail).outstandingIdr;
    const list = await api.get(
      R4,
      u4.finance1,
      `/supplier-invoices?outletId=${R4.outletId}&limit=100`,
    );
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const row = (
      list.body as { data: { id: string; outstandingIdr: number }[] }
    ).data.find((item) => item.id === id);
    expect(row).toBeDefined();
    expect(row!.outstandingIdr).toBe(fromDetail);
    return fromDetail;
  };

  it("HD-R4 held and rejected show 0, a matched invoice shows its payable", async () => {
    const heldId = await heldInvoice(
      R4,
      u4.buyer,
      await received(R4, u4.warehouse),
    );
    expect(await outstanding(heldId)).toBe(0);

    const rejectedId = await heldInvoice(
      R4,
      u4.buyer,
      await received(R4, u4.warehouse),
    );
    const reject = await decide(R4, u4.finance1, rejectedId, "reject");
    expect(reject.status, JSON.stringify(reject.body)).toBeLessThan(300);
    expect(await outstanding(rejectedId)).toBe(0);

    // Positive control: 10 kg x Rp 10.000 matched, nothing paid yet.
    const matchedId = await matchedInvoice(
      R4,
      u4.buyer,
      await received(R4, u4.warehouse),
    );
    expect(await outstanding(matchedId)).toBe(100_000);
  });
});
