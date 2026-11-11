// Owner override of the 24 h stale-catalog sales block (bead legend-10nex,
// founder Q57; contract: edge/sales-gate.ts). Only an owner may grant (the
// route enforces it); the grant works offline because it is a local write on
// the edge database. At most one override is active per edge node: granting
// again marks the old row superseded (kept as evidence), and a successful sync
// of all critical catalog streams closes the active one (`SYNC_OK`).
//
// Expiry is decided by the caller with the edge's trusted clock (`now`), never
// by the database clock, so a wall clock set backwards cannot extend an
// override. The sales-gate provider keeps a cached copy and is told about each
// change through `setCatalogOverrideListener`.
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  createUlid,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import {
  edgeCatalogSaleOverrides,
  type EdgeCatalogOverrideClosedReason,
} from "../db/schema/edge-catalog-sale-overrides.ts";
import { withTenant } from "../db/tenant.ts";
import { recordAudit } from "../services/core-audit.ts";

type Database = typeof db;

export const CATALOG_OVERRIDE_MIN_MINUTES = 1;
/** Hard cap: 24 h. */
export const CATALOG_OVERRIDE_MAX_MINUTES = 24 * 60;

export const catalogOverrideInputSchema = z.strictObject({
  minutes: z
    .number()
    .int()
    .min(CATALOG_OVERRIDE_MIN_MINUTES)
    .max(CATALOG_OVERRIDE_MAX_MINUTES),
  reason: z.string().trim().min(3).max(500),
});
export type CatalogOverrideInput = z.infer<typeof catalogOverrideInputSchema>;

export type CatalogOverride = {
  id: string;
  edgeNodeId: string;
  grantedBy: string;
  grantedAt: Date;
  untilAt: Date;
  reason: string;
};

export type CatalogOverrideDeps = {
  /** Defaults to the shared pool. */
  database?: Database;
  /** The edge node's own tenant context (identity.context). */
  context: ScopedTenantContext;
  outletId: string;
};

/** What changed, for the sales-gate cache; listeners may just reload. */
export type CatalogOverrideChange =
  | { kind: "granted"; override: CatalogOverride }
  | { kind: "closed"; reason: EdgeCatalogOverrideClosedReason };

/**
 * Audit fields kept in the clear. The free-text reason is not listed: it goes
 * in the audit row's own `reason` column, not in the masked snapshots.
 */
export const CATALOG_OVERRIDE_AUDIT_SAFE_FIELDS = [
  "overrideId",
  "supersededOverrideId",
  "grantedAt",
  "untilAt",
  "minutes",
] as const;

let clock: () => Date = () => new Date();

/** edge/runtime.ts installs the trusted clock; null restores the wall clock. */
export function setCatalogOverrideClock(next: (() => Date) | null): void {
  clock = next ?? (() => new Date());
}

/** Now by the edge's trusted clock (wall clock until the runtime installs it). */
export function catalogOverrideNow(): Date {
  return clock();
}

let listener: ((change: CatalogOverrideChange) => void) | null = null;

/** Installed by edge/runtime.ts; called after a grant or close has committed. */
export function setCatalogOverrideListener(
  next: ((change: CatalogOverrideChange) => void) | null,
): void {
  listener = next;
}

function notify(change: CatalogOverrideChange): void {
  try {
    listener?.(change);
  } catch {
    // The change is committed; a broken cache listener must not fail the caller.
  }
}

const columns = {
  id: edgeCatalogSaleOverrides.id,
  edgeNodeId: edgeCatalogSaleOverrides.edgeNodeId,
  grantedBy: edgeCatalogSaleOverrides.grantedBy,
  grantedAt: edgeCatalogSaleOverrides.grantedAt,
  untilAt: edgeCatalogSaleOverrides.untilAt,
  reason: edgeCatalogSaleOverrides.reason,
};

function activeWhere(edgeNodeId: string) {
  return and(
    eq(edgeCatalogSaleOverrides.edgeNodeId, edgeNodeId),
    isNull(edgeCatalogSaleOverrides.closedAt),
    isNull(edgeCatalogSaleOverrides.supersededAt),
  );
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Grants an override and supersedes the active one, all in one transaction. */
export async function grantCatalogOverride(
  deps: CatalogOverrideDeps,
  input: CatalogOverrideInput & {
    edgeNodeId: string;
    userId: string;
    now: Date;
  },
): Promise<CatalogOverride> {
  const { minutes, reason } = catalogOverrideInputSchema.parse({
    minutes: input.minutes,
    reason: input.reason,
  });
  const { edgeNodeId, userId, now } = input;
  const untilAt = new Date(now.getTime() + minutes * 60_000);
  const tenantId = deps.context.tenant.tenantId;

  const database = deps.database ?? db;
  const grantOnce = () =>
    withTenant(database, deps.context, async (tx) => {
      const previous = await tx
        .select({
          id: edgeCatalogSaleOverrides.id,
          untilAt: edgeCatalogSaleOverrides.untilAt,
        })
        .from(edgeCatalogSaleOverrides)
        .where(activeWhere(edgeNodeId));
      if (previous.length > 0)
        await tx
          .update(edgeCatalogSaleOverrides)
          .set({ supersededAt: now })
          .where(activeWhere(edgeNodeId));

      const id = createUlid(now.getTime());
      const [row] = await tx
        .insert(edgeCatalogSaleOverrides)
        .values({
          id,
          tenantId,
          outletId: deps.outletId as OutletId,
          edgeNodeId,
          grantedBy: userId,
          grantedAt: now,
          untilAt,
          reason,
        })
        .returning(columns);
      if (!row) throw new Error("Catalog override insert returned no row");

      const superseded = previous[0];
      await recordAudit(
        tx,
        deps.context,
        {
          id: createUlid(now.getTime()),
          tenantId,
          outletId: deps.outletId,
          actorType: "user",
          actorId: userId,
          deviceId: null,
          action: "edge.catalog_override.grant",
          objectType: "edge_catalog_override",
          objectId: id,
          reason,
          maskedChanges: {
            before: superseded
              ? {
                  overrideId: superseded.id,
                  untilAt: superseded.untilAt.toISOString(),
                }
              : null,
            after: {
              overrideId: id,
              supersededOverrideId: superseded?.id ?? null,
              grantedAt: now.toISOString(),
              untilAt: untilAt.toISOString(),
              minutes,
            },
          },
          ipHash: null,
          sensitiveAccess: false,
          retentionClass: "audit_2y",
          createdAt: now.toISOString(),
        },
        CATALOG_OVERRIDE_AUDIT_SAFE_FIELDS,
      );
      return row;
    });
  // The partial unique index allows one active row per edge: a concurrent
  // grant that won the race makes our insert fail, so supersede it and retry once.
  let granted: CatalogOverride;
  try {
    granted = await grantOnce();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    granted = await grantOnce();
  }

  notify({ kind: "granted", override: granted });
  return granted;
}

/**
 * The override in force at `now` (trusted clock), or null. One that ran past
 * `untilAt` is not returned; its row stays as evidence.
 */
export async function loadActiveCatalogOverride(
  deps: CatalogOverrideDeps,
  input: { edgeNodeId: string; now: Date },
): Promise<CatalogOverride | null> {
  const [row] = await withTenant(deps.database ?? db, deps.context, (tx) =>
    tx
      .select(columns)
      .from(edgeCatalogSaleOverrides)
      .where(
        and(
          activeWhere(input.edgeNodeId),
          gt(edgeCatalogSaleOverrides.untilAt, input.now),
        ),
      )
      .orderBy(desc(edgeCatalogSaleOverrides.grantedAt))
      .limit(1),
  );
  return row ?? null;
}

/**
 * Ends the active override (episode over, e.g. `SYNC_OK`). Returns how many
 * rows were closed; the listener is told only when something changed.
 */
export async function closeCatalogOverrides(
  deps: CatalogOverrideDeps,
  input: {
    edgeNodeId: string;
    now: Date;
    reason: EdgeCatalogOverrideClosedReason;
    /** Close only this override (a newer grant must stay active). */
    onlyId?: string;
  },
): Promise<number> {
  const closed = await withTenant(deps.database ?? db, deps.context, (tx) =>
    tx
      .update(edgeCatalogSaleOverrides)
      .set({ closedAt: input.now, closedReason: input.reason })
      .where(
        and(
          activeWhere(input.edgeNodeId),
          input.onlyId
            ? eq(edgeCatalogSaleOverrides.id, input.onlyId)
            : undefined,
        ),
      )
      .returning({ id: edgeCatalogSaleOverrides.id }),
  );
  if (closed.length > 0) notify({ kind: "closed", reason: input.reason });
  return closed.length;
}
