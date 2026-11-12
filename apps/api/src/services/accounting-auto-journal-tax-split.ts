// legend-xa9bc (538-G3 slice A): the tax of a sale is booked per tax type
// (PBJT / PPN / other) into its own payable account, and a refund mirrors the
// split of the sale journal it refunds.
//
// The payload carries one tax amount (`pbjtIdr` = the order's total tax). The
// split is derived here:
// - sale: from the order's tax_snapshots, per `tax_type`. The parts must add up
//   to the payload tax, else the sale stays all-PBJT (the behaviour before the
//   split; also the case of an order without snapshots, pre-cutover).
// - refund: from what the sale journal of the order credited to each payable
//   account (so a sale booked all-PBJT before the cutover is refunded all-PBJT),
//   prorated by refund tax / collected tax with the largest remainder, so the
//   parts add up exactly and Dr = Cr.
// - cap (legend-knfl6): the refunds of an order, linked by journal_entries.order_id,
//   never return more tax than the sale collected, in total and per type. A
//   refund that would is rejected (the caller throws AutoJournalPayloadInvalid:
//   parked, never retried); no cap account absorbs the rest.

import { and, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { ulidToUuid, type ScopedTenantContext } from "@starter/shared/core";
import {
  accountMappings,
  journalEntries,
  journalLines,
  taxSnapshots,
} from "../db/schema/index.ts";
import { logger } from "../lib/logger.ts";
import type { Tx } from "./inventory-ops.shared.ts";

type TenantId = ScopedTenantContext["tenant"]["tenantId"];

export type TaxSplit = {
  pbjtIdr: number;
  ppnIdr: number;
  otherTaxIdr: number;
};

export const TAX_SPLIT_VARIANT = "tax_split";

const TYPES = ["pbjt", "ppn", "other"] as const;
type TaxType = (typeof TYPES)[number];

const pbjtOnly = (taxIdr: number): TaxSplit => ({
  pbjtIdr: taxIdr,
  ppnIdr: 0,
  otherTaxIdr: 0,
});

const splitOf = (parts: Record<TaxType, number>): TaxSplit => ({
  pbjtIdr: parts.pbjt,
  ppnIdr: parts.ppn,
  otherTaxIdr: parts.other,
});

/** True when PPN or other tax is booked: the `tax_split` rule variant applies. */
export const isSplit = (split: TaxSplit): boolean =>
  split.ppnIdr !== 0 || split.otherTaxIdr !== 0;

// First character 0-7: a ULID is 128 bits, so a larger one cannot decode.
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The uuid an order id (ULID text or uuid) has in tax_snapshots. */
export function orderUuidOf(orderId: string): string | null {
  if (UUID_RE.test(orderId)) return orderId.toLowerCase();
  if (ULID_RE.test(orderId)) return ulidToUuid(orderId.toUpperCase());
  return null;
}

/** Sale tax per type from the order's snapshots; all-PBJT when they disagree. */
export async function saleTaxSplitOf(
  tx: Tx,
  tenantId: TenantId,
  orderId: string,
  taxIdr: number,
): Promise<TaxSplit> {
  if (taxIdr <= 0) return pbjtOnly(taxIdr);
  const sourceId = orderUuidOf(orderId);
  if (sourceId === null) return pbjtOnly(taxIdr);
  const rows = await tx
    .select({
      taxType: taxSnapshots.taxType,
      taxIdr: sql<string>`sum(${taxSnapshots.taxIdr})::text`,
    })
    .from(taxSnapshots)
    .where(
      and(
        eq(taxSnapshots.tenantId, tenantId),
        eq(taxSnapshots.sourceType, "order"),
        eq(taxSnapshots.sourceId, sourceId),
      ),
    )
    .groupBy(taxSnapshots.taxType);
  const parts: Record<TaxType, number> = { pbjt: 0, ppn: 0, other: 0 };
  for (const row of rows) {
    const amount = Number(row.taxIdr);
    if (!Number.isSafeInteger(amount) || amount < 0) return pbjtOnly(taxIdr);
    if (row.taxType === "ppn") parts.ppn += amount;
    else if (row.taxType === "pbjt") parts.pbjt += amount;
    else parts.other += amount;
  }
  if (parts.pbjt + parts.ppn + parts.other === taxIdr) return splitOf(parts);
  // No snapshots (pre-cutover) is normal; snapshots that disagree with the
  // order tax were re-quoted after the sale: keep the pre-split booking, but
  // say so, the tax report then shows the gap.
  if (rows.length > 0)
    logger.warn(
      { orderId, taxIdr, snapshotTaxIdr: parts.pbjt + parts.ppn + parts.other },
      "order tax snapshots do not match the order tax; booked all to PBJT",
    );
  return pbjtOnly(taxIdr);
}

const TAX_ROLES = [
  "tax_payable_pbjt",
  "tax_payable_ppn",
  "tax_payable_other",
] as const;
type TaxRole = (typeof TAX_ROLES)[number];

const ROLE_TYPE: Record<TaxRole, TaxType> = {
  tax_payable_pbjt: "pbjt",
  tax_payable_ppn: "ppn",
  tax_payable_other: "other",
};

const emptyParts = (): Record<TaxType, number> => ({
  pbjt: 0,
  ppn: 0,
  other: 0,
});

type TaxAccounts = {
  legalEntityId: string;
  /** Payable account per tax type; a type without mapping has none. */
  byType: Partial<Record<TaxType, string>>;
};

/**
 * The payable accounts of the entity the order's sale journal was posted in.
 * Null when the sale journal does not exist.
 */
async function taxAccountsOf(
  tx: Tx,
  tenantId: TenantId,
  saleKey: string,
): Promise<TaxAccounts | null> {
  const [entry] = await tx
    .select({ legalEntityId: journalEntries.legalEntityId })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.tenantId, tenantId),
        eq(journalEntries.idempotencyKey, saleKey),
      ),
    )
    .limit(1);
  if (!entry) return null;
  const rows = await tx
    .select({
      role: accountMappings.role,
      accountId: accountMappings.accountId,
    })
    .from(accountMappings)
    .where(
      and(
        eq(accountMappings.tenantId, tenantId),
        eq(accountMappings.legalEntityId, entry.legalEntityId),
        inArray(accountMappings.role, [...TAX_ROLES]),
      ),
    );
  const byType: Partial<Record<TaxType, string>> = {};
  for (const row of rows) {
    const type = ROLE_TYPE[row.role as TaxRole];
    if (type) byType[type] = row.accountId;
  }
  return { legalEntityId: entry.legalEntityId, byType };
}

/** Two tax roles on one account: its balance cannot be told apart per type. */
const sharesAccount = (byType: TaxAccounts["byType"]): boolean => {
  const ids = Object.values(byType);
  return new Set(ids).size !== ids.length;
};

/** Per payable account: net of lines, one row per account (never per role). */
function partsOf(
  accounts: TaxAccounts["byType"],
  net: Map<string, number>,
): Record<TaxType, number> {
  const out = emptyParts();
  for (const type of TYPES) {
    const accountId = accounts[type];
    if (accountId) out[type] = net.get(accountId) ?? 0;
  }
  return out;
}

/** Credit minus debit the sale journal of the order booked per payable account. */
async function collectedNetOf(
  tx: Tx,
  tenantId: TenantId,
  saleKey: string,
  accounts: readonly string[],
): Promise<Map<string, number>> {
  const rows = await tx
    .select({
      accountId: journalLines.accountId,
      net: sql<string>`sum(${journalLines.creditIdr} - ${journalLines.debitIdr})::text`,
    })
    .from(journalEntries)
    .innerJoin(
      journalLines,
      and(
        eq(journalLines.tenantId, journalEntries.tenantId),
        eq(journalLines.entryId, journalEntries.id),
      ),
    )
    .where(
      and(
        eq(journalEntries.tenantId, tenantId),
        eq(journalEntries.idempotencyKey, saleKey),
        inArray(journalLines.accountId, [...accounts]),
      ),
    )
    .groupBy(journalLines.accountId);
  return new Map(rows.map((r) => [r.accountId, Number(r.net)]));
}

async function collectedOf(
  tx: Tx,
  tenantId: TenantId,
  saleKey: string,
  accounts: TaxAccounts["byType"],
): Promise<Record<TaxType, number>> {
  return partsOf(
    accounts,
    await collectedNetOf(tx, tenantId, saleKey, Object.values(accounts)),
  );
}

const reversedEntries = alias(journalEntries, "reversed_entries");

/**
 * Tax already refunded for the order, per payable account (debit minus
 * credit). A reversal counts as the refund it reverses (a rejected refund
 * gives its tax back). A refund journal is the order's by its order id or, for
 * one posted before journal_entries.order_id existed and not backfilled, by
 * its source id being a refund row of that order (pos_order_refunds, or the
 * order issue of a recovery refund), so an old refund still reduces the room.
 */
async function refundedNetOf(
  tx: Tx,
  tenantId: TenantId,
  orderUuid: string,
  legalEntityId: string,
  accounts: readonly string[],
): Promise<Map<string, number>> {
  const effectiveOrder = sql`coalesce(${reversedEntries.orderId}, ${journalEntries.orderId})`;
  const effectiveSourceId = sql`coalesce(${reversedEntries.sourceId}, ${journalEntries.sourceId})`;
  const rows = await tx
    .select({
      accountId: journalLines.accountId,
      net: sql<string>`sum(${journalLines.debitIdr} - ${journalLines.creditIdr})::text`,
    })
    .from(journalEntries)
    .leftJoin(
      reversedEntries,
      and(
        eq(reversedEntries.tenantId, journalEntries.tenantId),
        eq(reversedEntries.id, journalEntries.reversalOf),
      ),
    )
    .innerJoin(
      journalLines,
      and(
        eq(journalLines.tenantId, journalEntries.tenantId),
        eq(journalLines.entryId, journalEntries.id),
      ),
    )
    .where(
      and(
        eq(journalEntries.tenantId, tenantId),
        eq(journalEntries.legalEntityId, legalEntityId),
        inArray(journalLines.accountId, [...accounts]),
        sql`coalesce(${reversedEntries.sourceType}, ${journalEntries.sourceType}) = 'refund'`,
        sql`(${effectiveOrder} = ${orderUuid}::uuid OR (${effectiveOrder} IS NULL AND ${effectiveSourceId} IN (
          SELECT id::text FROM pos_order_refunds WHERE tenant_id = ${tenantId}::uuid AND order_id = ${orderUuid}::uuid
          UNION
          SELECT id::text FROM order_issues WHERE tenant_id = ${tenantId}::uuid AND order_id = ${orderUuid}::uuid)))`,
      ),
    )
    .groupBy(journalLines.accountId);
  return new Map(rows.map((r) => [r.accountId, Number(r.net)]));
}

async function refundedOf(
  tx: Tx,
  tenantId: TenantId,
  orderUuid: string,
  legalEntityId: string,
  accounts: TaxAccounts["byType"],
): Promise<Record<TaxType, number>> {
  return partsOf(
    accounts,
    await refundedNetOf(
      tx,
      tenantId,
      orderUuid,
      legalEntityId,
      Object.values(accounts),
    ),
  );
}

type RefundComponents = {
  grossSalesIdr: number;
  discountIdr: number;
  serviceChargeIdr: number;
  /** Total refund tax, before splitting it into payable types. */
  pbjtIdr: number;
};

/**
 * Independently rounded refunds can exhaust one component before the cash
 * total. Allocate an overflowing component from the remaining sale balances,
 * keeping the exact money returned and never overrunning the sale as a whole.
 * The same lock as the tax cap covers this read through the eventual posting.
 */
export async function refundComponentsOf(
  tx: Tx,
  tenantId: TenantId,
  orderId: string,
  input: RefundComponents,
  amountIdr: number,
): Promise<RefundComponents | string> {
  const orderUuid = orderUuidOf(orderId);
  if (orderUuid === null) return "Refund order id is not an order id";
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`aj:refund-cap:${tenantId}:${orderUuid}`}, 0))`,
  );
  const saleKey = `aj:sale:${orderId}`;
  const taxAccounts = await taxAccountsOf(tx, tenantId, saleKey);
  if (!taxAccounts) return "Sale journal of the order is not found";
  if (sharesAccount(taxAccounts.byType))
    return "Two tax roles are mapped to one account";
  const componentRoles = {
    sales_revenue: "grossSalesIdr",
    sales_discount: "discountIdr",
    service_charge: "serviceChargeIdr",
  } as const;
  const mappings = await tx
    .select({
      role: accountMappings.role,
      accountId: accountMappings.accountId,
    })
    .from(accountMappings)
    .where(
      and(
        eq(accountMappings.tenantId, tenantId),
        eq(accountMappings.legalEntityId, taxAccounts.legalEntityId),
        inArray(accountMappings.role, [
          "sales_revenue",
          "sales_discount",
          "service_charge",
          "rounding",
        ]),
      ),
    );
  const accounts = [
    ...new Set([
      ...Object.values(taxAccounts.byType),
      ...mappings.map((row) => row.accountId),
    ]),
  ];
  if (
    accounts.length !==
    Object.values(taxAccounts.byType).length + mappings.length
  )
    return "Refund component accounts cannot be distinguished";
  const collected = await collectedNetOf(tx, tenantId, saleKey, accounts);
  const refunded = await refundedNetOf(
    tx,
    tenantId,
    orderUuid,
    taxAccounts.legalEntityId,
    accounts,
  );
  const remaining = (accountId: string) =>
    (collected.get(accountId) ?? 0) - (refunded.get(accountId) ?? 0);
  const room: RefundComponents = {
    grossSalesIdr: 0,
    discountIdr: 0,
    serviceChargeIdr: 0,
    pbjtIdr: Object.values(taxAccounts.byType).reduce(
      (sum, id) => sum + remaining(id),
      0,
    ),
  };
  for (const { role, accountId } of mappings) {
    if (role === "rounding") continue;
    const component = componentRoles[role as keyof typeof componentRoles];
    if (component)
      room[component] =
        remaining(accountId) * (component === "discountIdr" ? -1 : 1);
  }
  const rounding = mappings.find((row) => row.role === "rounding");
  if (rounding) room.grossSalesIdr += remaining(rounding.accountId);
  if (
    !Object.values(room).every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    !Object.values(input).every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    !Number.isSafeInteger(amountIdr) ||
    amountIdr <= 0 ||
    input.grossSalesIdr +
      input.serviceChargeIdr +
      input.pbjtIdr -
      input.discountIdr !==
      amountIdr
  )
    return "Refund components cannot be checked";
  const roomTotal =
    room.grossSalesIdr +
    room.serviceChargeIdr +
    room.pbjtIdr -
    room.discountIdr;
  if (amountIdr > roomTotal)
    return "Refund exceeds the amount the sale collected";
  if (amountIdr === roomTotal) return room;
  if (
    (Object.keys(input) as (keyof RefundComponents)[]).every(
      (key) => input[key] <= room[key],
    )
  )
    return input;

  const discountIdr = Math.min(input.discountIdr, room.discountIdr);
  // These are three nonnegative component budgets, so the same exact integer
  // largest-remainder allocation used for tax types applies without drift.
  const allocated = prorateLargestRemainder(amountIdr + discountIdr, {
    pbjt: room.grossSalesIdr,
    ppn: room.serviceChargeIdr,
    other: room.pbjtIdr,
  });
  return {
    grossSalesIdr: allocated.pbjt,
    serviceChargeIdr: allocated.ppn,
    pbjtIdr: allocated.other,
    discountIdr,
  };
}

/**
 * Prorates `amount` over `weights` (floor + largest remainder, ties in PBJT,
 * PPN, other order); the parts add up to `amount` exactly. `amount` must not
 * exceed the sum of the weights, so no part exceeds its own weight.
 */
export function prorateLargestRemainder(
  amount: number,
  weights: Record<TaxType, number>,
): Record<TaxType, number> {
  const total = BigInt(TYPES.reduce((sum, type) => sum + weights[type], 0));
  const parts = emptyParts();
  const remainders: { type: TaxType; rest: bigint }[] = [];
  let given = 0;
  for (const type of TYPES) {
    // BigInt: amount x weight can pass 2^53 for large orders.
    const product = BigInt(amount) * BigInt(weights[type]);
    parts[type] = Number(product / total);
    given += parts[type];
    remainders.push({ type, rest: product % total });
  }
  remainders.sort((a, b) => (a.rest === b.rest ? 0 : a.rest > b.rest ? -1 : 1));
  for (let i = 0; given < amount; i += 1, given += 1)
    parts[remainders[i % remainders.length]!.type] += 1;
  return parts;
}

/**
 * Refund tax per type, mirroring the split of the order's sale journal, and
 * never above what the sale still holds (collected minus refunded so far,
 * total and per type). Over the cap: the reason as a string (the caller parks).
 * Serialized per order, so two refunds cannot both pass the check.
 */
export async function refundTaxSplitOf(
  tx: Tx,
  tenantId: TenantId,
  orderId: string,
  taxIdr: number,
): Promise<TaxSplit | string> {
  if (taxIdr <= 0) return pbjtOnly(taxIdr);
  const orderUuid = orderUuidOf(orderId);
  if (orderUuid === null) return "Refund order id is not an order id";
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`aj:refund-cap:${tenantId}:${orderUuid}`}, 0))`,
  );
  const saleKey = `aj:sale:${orderId}`;
  const accounts = await taxAccountsOf(tx, tenantId, saleKey);
  if (!accounts) return "Sale journal of the order is not found";
  // No PBJT account mapped: the posting itself fails ACCOUNT_MAPPING_MISSING.
  if (!accounts.byType.pbjt) return pbjtOnly(taxIdr);
  if (sharesAccount(accounts.byType))
    return "Two tax roles are mapped to one account";
  const collected = await collectedOf(tx, tenantId, saleKey, accounts.byType);
  const refunded = await refundedOf(
    tx,
    tenantId,
    orderUuid,
    accounts.legalEntityId,
    accounts.byType,
  );
  const room = emptyParts();
  for (const type of TYPES) {
    if (
      !Number.isSafeInteger(collected[type]) ||
      !Number.isSafeInteger(refunded[type])
    )
      return "Refund tax cannot be checked";
    room[type] = Math.max(collected[type] - refunded[type], 0);
  }
  const roomTotal = room.pbjt + room.ppn + room.other;
  if (taxIdr > roomTotal)
    return "Refund tax exceeds the tax the sale collected";
  const weights = {
    pbjt: Math.max(collected.pbjt, 0),
    ppn: Math.max(collected.ppn, 0),
    other: Math.max(collected.other, 0),
  };
  if (weights.ppn === 0 && weights.other === 0) return pbjtOnly(taxIdr);
  const parts = prorateLargestRemainder(taxIdr, weights);
  // Rounding or an earlier uneven refund can leave a type over its room: move
  // the excess to types with room left (total room covers the refund).
  let excess = 0;
  for (const type of TYPES)
    if (parts[type] > room[type]) {
      excess += parts[type] - room[type];
      parts[type] = room[type];
    }
  for (const type of TYPES) {
    if (excess === 0) break;
    const take = Math.min(excess, room[type] - parts[type]);
    parts[type] += take;
    excess -= take;
  }
  return splitOf(parts);
}
