// Advisory lock on one payable source id (bead legend-ct27s).
//
// A fixed-asset acquisition with a source document must not reuse the id of a
// supplier invoice (that invoice already books the payable). The asset side
// checks tenant-wide that no supplier invoice or payable open item carries the
// id; the invoice side creates them. Both take this lock first, inside their
// own transaction, so the check always runs after a concurrent invoice with the
// same id has committed (or before it starts), never in between.
//
// A second lock serialises one supplier document number: two asset
// acquisitions (or an asset and an invoice) must not book the same supplier
// document twice. Asset registration refuses a document number that already
// has a supplier invoice or payable open item.
//
// Lock order: the invoice path holds the purchase order row lock (FOR UPDATE)
// and then `payable-src`; the asset path takes `payable-src` and then
// `payable-doc`. Always payable-src before payable-doc; no cycle.

import { sql } from "drizzle-orm";
import type { TenantTransaction } from "./accounting-shared.ts";

export function payableSourceLockKey(
  tenantId: string,
  sourceId: string,
): string {
  return `payable-src:${tenantId}:${sourceId}`;
}

/** Held until the caller's transaction ends. */
export async function lockPayableSource(
  tx: TenantTransaction,
  tenantId: string,
  sourceId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${payableSourceLockKey(tenantId, sourceId)}, 0))`,
  );
}

export function payableDocumentLockKey(
  tenantId: string,
  supplierId: string,
  documentNumber: string,
): string {
  return `payable-doc:${tenantId}:${supplierId}:${documentNumber.trim().toUpperCase()}`;
}

/** Take after `lockPayableSource`. Held until the caller's transaction ends. */
export async function lockPayableDocument(
  tx: TenantTransaction,
  tenantId: string,
  supplierId: string,
  documentNumber: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${payableDocumentLockKey(tenantId, supplierId, documentNumber)}, 0))`,
  );
}
