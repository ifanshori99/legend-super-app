// Shared advisory locks for tenant configuration that provisioning seeds and the
// owner edits (beads legend-dq0n, legend-hd1m). Provisioning reads "is this
// still empty?" and then inserts defaults; every owner writer of the same table
// takes the same lock first, so the backfill can never see a table as empty
// while an owner's row is about to commit (and vice versa).
//
// One pattern for every lock here: transaction-scoped
// `pg_advisory_xact_lock(hashtextextended(<key>, 0))`, taken before any read of
// the guarded table and held until the caller's transaction ends.
//
// Lock order. A transaction that needs more than one of these locks takes them
// in this order, never the reverse, so two transactions cannot deadlock:
//   1. chart of accounts, per legal entity   (`lockChartOfAccounts`)
//   2. stock locations, per outlet           (`lockOutletStockLocations`)
//   3. tax rules and tax settings, per tenant (`lockTaxConfig`)
//   4. service-charge rules, per tenant      (`lockServiceChargeConfig`)
// The edge master import (edge/master-sync.ts) first takes its own per-outlet
// `edge-master-sync` lock, no other path does, then lock 1 for its one legal
// entity, then lock 2 for its outlet (it writes CoA, mappings and the outlet's
// stock locations; tenant-wide uoms have no lock in this list).
// The config import (tenant-config.service.ts) takes lock 1 for every legal
// entity of the target, by createdAt/id, BEFORE its `tenants FOR UPDATE`: an
// owner mapping writer holds lock 1 and then needs a KEY SHARE on the tenant
// row for its INSERT, which that FOR UPDATE would block, so waiting for lock 1
// after the row lock would be a cycle. An entity created in between is only
// try-locked (`tryLockChartOfAccounts`); failure aborts the import, never waits.
// Holders today: tenant creation takes 3 then 4; legal-entity creation takes 1;
// outlet creation takes 2 then 4; each owner writer takes exactly one. The
// backfill runs each domain in its own transaction and, within one domain,
// takes several locks of the same kind in a fixed order (charts by legal
// entity createdAt/id, locations by outlet), so it cannot cycle with a writer
// that holds one.
//
// Item unit conversions (`lockItemUomReachability`, legend-o1n1) sit apart from
// the four above: it is taken only by the conversion delete and by the recipe
// saves, and a recipe save takes it AFTER the recipe graph lock
// (`recipe:graph:<tenant>`, recipe.service.ts) and, for several items, in
// ascending item id order. The conversion delete takes nothing else, so no
// cycle exists.
//
// Keys are unchanged from the per-module locks they replace, so a running
// process on the previous build still serialises against this one.

import { sql } from "drizzle-orm";
import type { TenantTransaction } from "./accounting-shared.ts";

async function advisoryXactLock(
  tx: TenantTransaction,
  key: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
}

/** 1. Chart of accounts and account mappings of one legal entity. */
export function lockChartOfAccounts(
  tx: TenantTransaction,
  tenantId: string,
  legalEntityId: string,
): Promise<void> {
  return advisoryXactLock(tx, `chart_of_accounts:${tenantId}:${legalEntityId}`);
}

/**
 * Non-blocking form of lock 1, for a caller that already holds a row lock
 * the chart writers wait on (the config import's `tenants FOR UPDATE`) and so
 * must never wait for the chart lock itself. Advisory xact locks are
 * re-entrant in one session, so this returns true when the caller already
 * holds the lock.
 */
export async function tryLockChartOfAccounts(
  tx: TenantTransaction,
  tenantId: string,
  legalEntityId: string,
): Promise<boolean> {
  const result = await tx.execute(
    sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`chart_of_accounts:${tenantId}:${legalEntityId}`}, 0)) AS locked`,
  );
  return (result.rows as { locked: boolean }[])[0]?.locked === true;
}

/**
 * 2. Stock locations of one outlet. Same key as `lockOutletLocations` in
 * inventory-setup.service.ts (the location create/rename routes).
 */
export function lockOutletStockLocations(
  tx: TenantTransaction,
  tenantId: string,
  outletId: string,
): Promise<void> {
  return advisoryXactLock(
    tx,
    `inventory:setup:locations:${tenantId}:${outletId}`,
  );
}

/** 3. Tax rules and tax settings of one tenant (every scope and outlet). */
export function lockTaxConfig(
  tx: TenantTransaction,
  tenantId: string,
): Promise<void> {
  return advisoryXactLock(tx, `tax:provisioning:${tenantId}`);
}

/** 4. Service-charge rules of one tenant (every scope and outlet). */
export function lockServiceChargeConfig(
  tx: TenantTransaction,
  tenantId: string,
): Promise<void> {
  return advisoryXactLock(tx, `tax:service-provisioning:${tenantId}`);
}

/**
 * Unit reachability of one inventory item (legend-o1n1). A recipe save that
 * puts the item in a non-base unit and the delete of a conversion that makes
 * that unit reachable both take this lock before they read conversions or
 * references, so one of them always sees the other's committed result.
 */
export function lockItemUomReachability(
  tx: TenantTransaction,
  tenantId: string,
  inventoryItemId: string,
): Promise<void> {
  return advisoryXactLock(
    tx,
    `inventory:uom-reach:${tenantId}:${inventoryItemId}`,
  );
}

/** Locks several items in ascending id order (the fixed order for no deadlock). */
export async function lockItemsUomReachability(
  tx: TenantTransaction,
  tenantId: string,
  inventoryItemIds: readonly string[],
): Promise<void> {
  for (const id of [...new Set(inventoryItemIds)].sort())
    await lockItemUomReachability(tx, tenantId, id);
}
