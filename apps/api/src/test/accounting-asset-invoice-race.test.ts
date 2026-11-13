// legend-ct27s: the asset-versus-supplier-invoice guard must hold when requests
// run at the same time, and another tenant must be refused.
// Written fail-first from the card text (bd show legend-ct27s) and the design
// docs/briefs/ws-purchasing-apar-design.md section 5 ("Anti dobel buku"), not
// from the implementation.
//
// Money rules under test (founder: nobody is paid more, the outlet never loses):
// - A fixed asset whose source document is a supplier invoice (matched or held)
//   is refused with 409, even when it races with the invoice being released,
//   with another invoice being recorded, or with other asset requests. No
//   asset row and no `asset_acquisition` journal is left behind.
// - The payable of the purchase is booked once: the accounts_payable ledger
//   equals what the invoices put there, never more.
// - Another tenant cannot register an asset in this tenant's legal entity.
//
// Assumptions (the card does not pin these down):
// - An invoice id is created by the server, so a test cannot know it before the
//   invoice exists. The race is therefore driven as a burst: the guard is hit
//   by several simultaneous asset requests (tenant-wide and outlet-limited
//   contexts) while the invoice is released or a second invoice is recorded.
//   The outcome must be the same whatever the interleaving: every asset request
//   is a 409, the ledger holds the invoice payable once. The test never
//   depends on who wins the race.
// - A second invoice on a fully received PO is held (more than net received),
//   so it books nothing; the ledger stays at the first invoice payable.
// - Another tenant is refused with 404 or 403 (the design says RLS hides the
//   other tenant, "404/403, tidak bocor"); only the refusal, not the code, is
//   asserted.
// - AR-05 and AR-06 are deterministic (no burst): a separate transaction holds
//   the advisory lock `pg_advisory_xact_lock(hashtextextended(
//   'payable-src:<tenant>:<id>', 0))` that the design (section 5) says both
//   sides take before the check or the posting. The request under test must
//   wait for it (seen in pg_locks as a not-granted advisory lock on that key;
//   the wait is polled until it shows or the request finishes), and only after
//   the holder commits may it finish. In AR-05 the holder also inserts the
//   payable open item of an invoice "being created" with that id, so a check
//   that ran before the lock would pass and register the asset twice.
// - Ids AR-nn name the cases below.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  tenantIdSchema,
  userIdSchema,
  type UserId,
} from "@starter/shared/core";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { createFixedAsset } from "../services/accounting-fixed-assets.service.ts";
import { setPurchaseReturnPostingEnabled } from "../services/purchase-return.service.ts";
import {
  releaseSupplierInvoice,
  setSupplierInvoicePostingEnabled,
} from "../services/purchasing-invoice.service.ts";
import {
  apLedger,
  closeOwner,
  invoicePo,
  journalCount,
  key,
  outletScope,
  owner,
  seedReceivedPo,
  setupApWorld,
  tenantId,
  tenantScope,
  type ApWorld,
} from "./purchasing-ap-world.ts";

const actor: UserId = userIdSchema.parse(randomUUID());

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
  // Ledgers and history are append-only and every world is random: left as is.
  await closeOwner();
});

const assetInput = (
  world: ApWorld,
  receivedOn: string,
  sourceId: string | null,
) => ({
  legalEntityId: world.entityId,
  outletId: world.outletId,
  name: "Mesin espresso",
  acquiredOn: receivedOn,
  costIdr: 5_000_000,
  residualValueIdr: 0,
  usefulLifeMonths: 12,
  depreciationStartPeriod: receivedOn.slice(0, 7),
  sourceDocumentId: sourceId,
  payable:
    sourceId === null
      ? null
      : {
          supplierId: world.supplierId,
          documentNumber: `AST-${key()}`.slice(0, 60),
          documentDate: receivedOn,
          dueOn: receivedOn,
        },
  idempotencyKey: key(),
});

async function assetCount(world: ApWorld): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM fixed_assets WHERE tenant_id = $1 AND legal_entity_id = $2",
    [tenantId, world.entityId],
  );
  return Number(rows[0]!.n);
}

async function acquisitionJournals(world: ApWorld): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM journal_entries
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND source_type = 'asset_acquisition'`,
    [tenantId, world.entityId],
  );
  return Number(rows[0]!.n);
}

/** One asset request per call, alternating tenant-wide and outlet-limited. */
function assetBurst(
  world: ApWorld,
  receivedOn: string,
  invoiceId: string,
  count: number,
) {
  return Array.from({ length: count }, (_, index) =>
    createFixedAsset(
      index % 2 === 0 ? tenantScope() : outletScope(world.outletId),
      assetInput(world, receivedOn, invoiceId),
      actor,
    ),
  );
}

describe("legend-ct27s simultaneous asset requests never pass the invoice guard", () => {
  it("AR-01 a burst of asset requests racing the release of a held invoice: all 409, the payable is booked once", async () => {
    const world = await setupApWorld();
    const fx = await seedReceivedPo(world);
    // Price +20%: held. Released by finance the payable is 40.000 + 8.000 +
    // 4.400 PPN = 52.400 (see accounting-asset-no-double-ap AD-06).
    const { invoice } = await invoicePo(world, fx, {
      quantity: 4,
      ppnIdr: 4_400,
      unitPriceIdr: 12_000,
    });
    expect(invoice.status).toBe("held");

    const results = await Promise.allSettled([
      ...assetBurst(world, fx.receivedOn, invoice.id, 6),
      releaseSupplierInvoice(
        outletScope(world.outletId),
        world.finance.userId,
        invoice.id,
        {
          note: "Harga naik disetujui finance",
          idempotencyKey: key(),
        } as Parameters<typeof releaseSupplierInvoice>[3],
      ),
    ]);

    const assets = results.slice(0, 6);
    for (const result of assets) {
      expect(result).toMatchObject({
        status: "rejected",
        reason: { status: 409 },
      });
    }
    expect(results[6]).toMatchObject({ status: "fulfilled" });
    expect(await assetCount(world)).toBe(0);
    expect(await acquisitionJournals(world)).toBe(0);
    expect(await apLedger(world)).toBe(52_400);
  });

  it("AR-02 a burst of asset requests racing a second invoice on a matched one: all 409, nothing is booked twice", async () => {
    const world = await setupApWorld();
    const fx = await seedReceivedPo(world);
    const { invoice } = await invoicePo(world, fx, {
      quantity: 10,
      ppnIdr: 11_000,
    });
    expect(invoice.status).toBe("matched");
    expect(await apLedger(world)).toBe(111_000);

    const results = await Promise.allSettled([
      ...assetBurst(world, fx.receivedOn, invoice.id, 6),
      // More than net received: held, so it books no payable.
      invoicePo(world, fx, { quantity: 10, ppnIdr: 11_000 }),
    ]);

    for (const result of results.slice(0, 6)) {
      expect(result).toMatchObject({
        status: "rejected",
        reason: { status: 409 },
      });
    }
    expect(results[6]).toMatchObject({ status: "fulfilled" });
    expect(await assetCount(world)).toBe(0);
    expect(await acquisitionJournals(world)).toBe(0);
    expect(await apLedger(world)).toBe(111_000);
  });

  it("AR-03 control: a burst of asset requests with no source document all register", async () => {
    const world = await setupApWorld();
    const fx = await seedReceivedPo(world);
    await invoicePo(world, fx, { quantity: 10, ppnIdr: 11_000 });

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        createFixedAsset(
          tenantScope(),
          assetInput(world, fx.receivedOn, null),
          actor,
        ),
      ),
    );

    for (const result of results) {
      expect(result.status).toBe("fulfilled");
    }
    expect(await assetCount(world)).toBe(4);
    // The invoice payable is untouched by plain assets.
    expect(await apLedger(world)).toBe(111_000);
  });
});

describe("legend-ct27s another tenant is refused", () => {
  it("AR-04 tenant B cannot register an asset in tenant A's legal entity, with or without A's invoice as source", async () => {
    const world = await setupApWorld();
    const fx = await seedReceivedPo(world);
    const { invoice } = await invoicePo(world, fx, {
      quantity: 10,
      ppnIdr: 11_000,
    });
    const foreign = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(randomUUID()),
        brandId: null,
        source: "domain",
      }),
      { kind: "tenant" },
    );
    const journalsBefore = await journalCount(world);
    const ledgerBefore = await apLedger(world);

    for (const sourceId of [invoice.id, null]) {
      const outcome = await Promise.allSettled([
        createFixedAsset(
          foreign,
          assetInput(world, fx.receivedOn, sourceId),
          actor,
        ),
      ]);
      expect(outcome[0]!.status).toBe("rejected");
      const reason = (outcome[0] as PromiseRejectedResult).reason as {
        status?: number;
      };
      expect([403, 404]).toContain(reason.status);
    }

    expect(await assetCount(world)).toBe(0);
    expect(await journalCount(world)).toBe(journalsBefore);
    expect(await apLedger(world)).toBe(ledgerBefore);
  });
});

/** A separate transaction holding the payable-source advisory lock of `id`. */
async function holdSourceLock(sourceId: string) {
  const client = await owner.connect();
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `payable-src:${tenantId}:${sourceId}`,
  ]);
  let open = true;
  const end = async (statement: "COMMIT" | "ROLLBACK") => {
    if (!open) return;
    open = false;
    try {
      await client.query(statement);
    } finally {
      client.release();
    }
  };
  return {
    client,
    commit: () => end("COMMIT"),
    rollback: () => end("ROLLBACK"),
  };
}

/** Sessions waiting (not granted) for the advisory lock of `sourceId`. */
async function waitersOn(sourceId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM pg_locks l, (SELECT hashtextextended($1, 0) AS h) k
      WHERE l.locktype = 'advisory' AND NOT l.granted
        AND l.classid::bigint = ((k.h >> 32) & 4294967295)
        AND l.objid::bigint = (k.h & 4294967295)`,
    [`payable-src:${tenantId}:${sourceId}`],
  );
  return Number(rows[0]!.n);
}

/** Starts `run`, and tracks whether it has finished. */
function track<T>(run: () => Promise<T>) {
  const state = { done: false };
  const outcome = Promise.allSettled([run()]).then(([result]) => {
    state.done = true;
    return result!;
  });
  return { state, outcome };
}

/** Polls until the request waits on the lock or has finished (no sleeps to guess). */
async function waitsOrFinishes(
  sourceId: string,
  state: { done: boolean },
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (state.done || (await waitersOn(sourceId)) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("legend-ct27s the check waits for the source lock", () => {
  it("AR-05 an asset request on an id whose invoice is being created waits for that transaction, then is refused 409", async () => {
    const world = await setupApWorld();
    const { receivedOn } = await seedReceivedPo(world);
    // The id of an invoice "being created" in another transaction.
    const sourceId = randomUUID();
    const holder = await holdSourceLock(sourceId);
    let pending: ReturnType<typeof track> | undefined;
    try {
      await holder.client.query(
        `INSERT INTO accounting_open_items
           (tenant_id, kind, id, legal_entity_id, outlet_id, counterparty_type, counterparty_id,
            counterparty_name, document_number, document_date, due_on, original_idr)
         VALUES ($1, 'payable', $2, $3, NULL, 'supplier', $4, 'Pemasok AR', $5, $6, $6, 111000)`,
        [
          tenantId,
          sourceId,
          world.entityId,
          world.supplierId,
          `INV-${sourceId.slice(0, 8)}`,
          receivedOn,
        ],
      );

      pending = track(() =>
        createFixedAsset(
          tenantScope(),
          assetInput(world, receivedOn, sourceId),
          actor,
        ),
      );
      await waitsOrFinishes(sourceId, pending.state);

      // It is blocked on the lock, not finished, and nothing is written yet.
      expect(pending.state.done).toBe(false);
      expect(await waitersOn(sourceId)).toBeGreaterThan(0);
      expect(await assetCount(world)).toBe(0);
    } finally {
      await holder.commit();
    }

    // The invoice is now committed: the guard sees it and refuses.
    expect(await pending!.outcome).toMatchObject({
      status: "rejected",
      reason: { status: 409 },
    });
    expect(await assetCount(world)).toBe(0);
    expect(await acquisitionJournals(world)).toBe(0);
    expect(await apLedger(world)).toBe(0);
  });

  it("AR-06 releasing a held invoice waits for the lock of its id, then books the payable once and still refuses an asset", async () => {
    const world = await setupApWorld();
    const fx = await seedReceivedPo(world);
    const { invoice } = await invoicePo(world, fx, {
      quantity: 4,
      ppnIdr: 4_400,
      unitPriceIdr: 12_000,
    });
    expect(invoice.status).toBe("held");
    const holder = await holdSourceLock(invoice.id);
    let pending: ReturnType<typeof track> | undefined;
    try {
      pending = track(() =>
        releaseSupplierInvoice(
          outletScope(world.outletId),
          world.finance.userId,
          invoice.id,
          {
            note: "Harga naik disetujui finance",
            idempotencyKey: key(),
          } as Parameters<typeof releaseSupplierInvoice>[3],
        ),
      );
      await waitsOrFinishes(invoice.id, pending.state);

      expect(pending.state.done).toBe(false);
      expect(await waitersOn(invoice.id)).toBeGreaterThan(0);
      expect(await apLedger(world)).toBe(0);
    } finally {
      await holder.commit();
    }

    expect(await pending!.outcome).toMatchObject({ status: "fulfilled" });
    expect(await apLedger(world)).toBe(52_400);
    await expect(
      createFixedAsset(
        tenantScope(),
        assetInput(world, fx.receivedOn, invoice.id),
        actor,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await assetCount(world)).toBe(0);
    expect(await apLedger(world)).toBe(52_400);
  });
});
