// Simple (petty) purchases with mandatory photo evidence (PRD v1.7 §3.18
// Pembelian Sederhana; bead legend-65mgw, brief 301b section 4).
//
// - A petty purchase records the spend only: no stock moves and no approval
//   path. It is refused when the amount passes the effective limit (outlet row
//   over the tenant default), or when no limit is configured (deny by default).
// - Entries are immutable (the RLS migration revokes UPDATE/DELETE). The limit
//   that applied is stored on the row (`limit_idr_applied`).
// - The business date is the outlet's current one; the client may echo it but
//   never back-date. `paidAt` must fall on that same business date.
// - The photo is a `receipt` storage object uploaded by the actor at this
//   outlet; it links once, to this purchase, in the same transaction.
// - Event `petty_purchase.recorded` (id-only payload) goes through the
//   transactional outbox. No journal is posted here.
// - Limit policies are upserted (audited) per tenant default or per outlet.

import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { AccessError, type PermissionCode } from "@starter/shared/access";
import {
  businessDateOf,
  businessDateSchema,
  CoreError,
  createUlid,
  encodeCursor,
  type Idr,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  assertPettyPurchaseWithinLimit,
  pettyPurchaseLimitFor,
  pettyPurchasePolicySchema,
  pettyPurchaseSchema,
  purchasingEvents,
  type createPettyPurchaseInputSchema,
  type upsertPettyPurchasePolicyInputSchema,
  type pettyPurchasePolicyQuerySchema,
  type pettyPurchaseQuerySchema,
  type PettyPurchase,
  type PettyPurchasePolicy,
} from "@starter/shared/inventory";
import type { z } from "zod";
import { db } from "../db/index.ts";
import {
  pettyPurchasePolicies,
  pettyPurchases,
} from "../db/schema/petty-purchases.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { drawPettyCashForPurchase } from "./accounting-petty-cash.service.ts";
import { appendOutbox } from "./core-outbox.ts";
import { linkStorageObjectSource } from "./core-storage.ts";
import {
  assertOutlet,
  cursorKeys,
  cursorUuid,
  EVENT_DESTINATION,
  loadOutletClock,
  outletTarget,
  recordOpsAudit,
  requestFingerprint,
  requireOpsPermission,
  translateInventoryError,
  type CursorPage,
  type Tx,
} from "./inventory-ops.shared.ts";
import { accessSnapshotInTransaction } from "./permission-resolver.ts";
import {
  claimPurchasingIdempotency,
  completePurchasingIdempotency,
  translatePurchasingError,
} from "./purchasing-flow.shared.ts";

export type CreatePettyPurchaseInput = z.infer<
  typeof createPettyPurchaseInputSchema
>;
export type PettyPurchaseQuery = z.infer<typeof pettyPurchaseQuerySchema>;
export type PettyPurchasePolicyQuery = z.infer<
  typeof pettyPurchasePolicyQuerySchema
>;
export type PutPettyPurchasePolicyInput = z.infer<
  typeof upsertPettyPurchasePolicyInputSchema
>;

const CREATE_OPERATION = "petty_purchase.create";
const POLICY_OPERATION = "petty_purchase_policy.put";
const RECORD_PERMISSION: PermissionCode = "purchasing.petty.record";
const POLICY_PERMISSION: PermissionCode = "purchasing.petty_policy.manage";

/** Reads of the spend list: the recorder or a finance reconciler. */
export const PETTY_PURCHASE_READ_PERMISSIONS: readonly PermissionCode[] = [
  RECORD_PERMISSION,
  "accounting.reconcile",
];
/** Reads of the effective limit: the recorder or the policy manager. */
export const PETTY_POLICY_READ_PERMISSIONS: readonly PermissionCode[] = [
  RECORD_PERMISSION,
  POLICY_PERMISSION,
];

const PURCHASE_AUDIT_FIELDS = [
  "vendorName",
  "amountIdr",
  "limitIdrApplied",
  "businessDate",
  "paidBy",
] as const;
const POLICY_AUDIT_FIELDS = ["outletId", "limitIdr"] as const;

type PurchaseRow = typeof pettyPurchases.$inferSelect;

function invalid(message: string): HttpError {
  return new HttpError(422, "VALIDATION_ERROR", message);
}

function toPettyPurchase(row: PurchaseRow): PettyPurchase {
  return pettyPurchaseSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    vendorName: row.vendorName,
    description: row.description,
    amountIdr: row.amountIdr,
    photoMediaId: row.photoObjectId,
    paidBy: row.paidBy,
    paidAt: row.paidAt.toISOString(),
    businessDate: row.businessDate,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  });
}

function anyAllows(
  snapshot: Awaited<ReturnType<typeof accessSnapshotInTransaction>>,
  permissions: readonly PermissionCode[],
  outletId: string,
): boolean {
  return permissions.some((permission) =>
    snapshot.allows(permission, outletTarget(outletId)),
  );
}

/** Policy rows that can apply to an outlet: its own and the tenant default. */
async function loadPolicies(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
): Promise<{
  all: PettyPurchasePolicy[];
  outletRow: PettyPurchasePolicy | null;
}> {
  const rows = await tx
    .select()
    .from(pettyPurchasePolicies)
    .where(
      and(
        eq(pettyPurchasePolicies.tenantId, context.tenant.tenantId),
        or(
          isNull(pettyPurchasePolicies.outletId),
          eq(pettyPurchasePolicies.outletId, outletId),
        ),
      ),
    );
  // DB rows carry plain string ids; the contract takes branded ids.
  const all = rows.map((row) => ({
    tenantId: row.tenantId,
    outletId: row.outletId,
    limitIdr: row.limitIdr,
  })) as unknown as PettyPurchasePolicy[];
  return { all, outletRow: all.find((policy) => policy.outletId) ?? null };
}

function canonicalInput(input: CreatePettyPurchaseInput) {
  return {
    outletId: input.outletId,
    vendorName: input.vendorName,
    description: input.description,
    amountIdr: input.amountIdr,
    photoMediaId: input.photoMediaId.toLowerCase(),
    paidAt: input.paidAt ?? null,
    businessDate: input.businessDate ?? null,
    note: input.note ?? null,
  };
}

async function appendPettyRecordedEvent(
  tx: Tx,
  context: ScopedTenantContext,
  purchase: PettyPurchase,
): Promise<void> {
  const name = "petty_purchase.recorded";
  const occurredAt = new Date(purchase.paidAt);
  const event = purchasingEvents[name].envelopeSchema.parse({
    id: createUlid(occurredAt.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: purchase.outletId,
    name,
    version: 1,
    aggregateType: "petty_purchase",
    aggregateId: purchase.id,
    sequence: 1,
    occurredAt: purchase.createdAt,
    actor: { type: "user", id: purchase.paidBy },
    deviceId: null,
    idempotencyKey: `${name}:${purchase.id}:1`,
    payloadSchemaRef: `${name}.v1`,
    payload: {
      pettyPurchaseId: purchase.id,
      outletId: purchase.outletId,
      amountIdr: purchase.amountIdr,
      businessDate: purchase.businessDate,
      paidBy: purchase.paidBy,
      paidAt: purchase.paidAt,
    },
  });
  await appendOutbox(tx, context, {
    id: createUlid(),
    event,
    destination: EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
}

/**
 * POST petty purchase. Needs `purchasing.petty.record` at the outlet. Records
 * the spend, links the photo and queues the event in one transaction; a retry
 * with the same key replays the first purchase.
 */
export async function createPettyPurchase(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreatePettyPurchaseInput,
): Promise<PettyPurchase> {
  assertOutlet(context, input.outletId);
  const claim = {
    operation: CREATE_OPERATION,
    key: input.idempotencyKey,
    outletId: input.outletId,
    fingerprint: requestFingerprint(
      CREATE_OPERATION,
      actorUserId,
      canonicalInput(input),
    ),
  };
  try {
    return await withTenant(db, context, async (tx) => {
      await requireOpsPermission(
        tx,
        context,
        actorUserId,
        RECORD_PERMISSION,
        input.outletId,
      );
      const replay = await claimPurchasingIdempotency(tx, context, claim);
      if (replay) return pettyPurchaseSchema.parse(replay.replay);

      const now = new Date();
      const clock = await loadOutletClock(tx, input.outletId);
      const businessDate = businessDateOf(now, clock);
      if (input.businessDate && input.businessDate !== businessDate)
        throw invalid("A petty purchase cannot be back-dated.");
      const paidAt = input.paidAt ? new Date(input.paidAt) : now;
      if (paidAt.getTime() > now.getTime())
        throw invalid("The payment time cannot be in the future.");
      if (businessDateOf(paidAt, clock) !== businessDate)
        throw invalid("The payment must fall on today's business date.");

      const { all: policies } = await loadPolicies(tx, context, input.outletId);
      const limit = pettyPurchaseLimitFor(policies, input.outletId);
      assertPettyPurchaseWithinLimit(input.amountIdr as Idr, limit);

      const purchaseId = randomUUID();
      // Link first: a photo that is missing or not the actor's is a 422 here,
      // before the row's foreign key to the storage object can fail.
      try {
        await linkStorageObjectSource(tx, {
          tenantId: context.tenant.tenantId,
          objectId: input.photoMediaId.toLowerCase(),
          sourceKind: "petty_purchase",
          sourceId: purchaseId,
          actorUserId,
          outletId: input.outletId,
        });
      } catch (error) {
        // The storage helper answers a core 400; this contract answers 422.
        if (error instanceof CoreError && error.code === "VALIDATION_ERROR")
          throw invalid(
            "The photo must be your own unattached receipt photo of this outlet.",
          );
        throw error;
      }

      const [row] = await tx
        .insert(pettyPurchases)
        .values({
          id: purchaseId,
          tenantId: context.tenant.tenantId,
          outletId: input.outletId,
          vendorName: input.vendorName,
          description: input.description,
          amountIdr: input.amountIdr as Idr,
          photoObjectId: input.photoMediaId.toLowerCase(),
          paidBy: actorUserId,
          paidAt,
          businessDate,
          limitIdrApplied: limit as Idr,
          note: input.note ? input.note : null,
        })
        .returning();
      const purchase = toPettyPurchase(row!);
      // An outlet with a petty cash fund spends it here (refused when the
      // balance is short); an outlet without one is unchanged (legend-4961).
      await drawPettyCashForPurchase(tx, context, {
        outletId: input.outletId,
        purchaseId,
        amountIdr: input.amountIdr,
        businessDate,
        description: input.description,
        actorId: actorUserId,
      });
      await recordOpsAudit(tx, context, {
        actorUserId,
        outletId: input.outletId,
        action: "purchasing.petty_purchase_recorded",
        objectType: "petty_purchase",
        objectId: purchaseId,
        before: null,
        after: {
          vendorName: purchase.vendorName,
          amountIdr: purchase.amountIdr,
          limitIdrApplied: limit,
          businessDate: purchase.businessDate,
          paidBy: purchase.paidBy,
        },
        safeFields: PURCHASE_AUDIT_FIELDS,
      });
      await appendPettyRecordedEvent(tx, context, purchase);
      await completePurchasingIdempotency(tx, context, claim, purchase);
      return purchase;
    });
  } catch (error) {
    throw translatePurchasingError(translateInventoryError(error));
  }
}

/** GET petty purchases of one outlet, newest business date first. */
export async function listPettyPurchases(
  context: ScopedTenantContext,
  actorUserId: string,
  query: PettyPurchaseQuery,
): Promise<CursorPage<PettyPurchase>> {
  assertOutlet(context, query.outletId);
  return withTenant(db, context, async (tx) => {
    const snapshot = await accessSnapshotInTransaction(
      tx,
      context,
      actorUserId,
      new Date(),
    );
    if (!anyAllows(snapshot, PETTY_PURCHASE_READ_PERMISSIONS, query.outletId))
      throw new AccessError("PERMISSION_DENIED");
    const filters: SQL[] = [
      eq(pettyPurchases.tenantId, context.tenant.tenantId),
      eq(pettyPurchases.outletId, query.outletId),
    ];
    if (query.fromDate)
      filters.push(gte(pettyPurchases.businessDate, query.fromDate));
    if (query.toDate)
      filters.push(lte(pettyPurchases.businessDate, query.toDate));
    const [cursorDate, cursorId] = cursorKeys(query.cursor, 2);
    if (cursorDate !== undefined && cursorId !== undefined) {
      const date = businessDateSchema.safeParse(cursorDate);
      if (!date.success) throw invalid("Check the cursor.");
      filters.push(
        or(
          lt(pettyPurchases.businessDate, date.data),
          and(
            eq(pettyPurchases.businessDate, date.data),
            sql`${pettyPurchases.id} < ${cursorUuid(cursorId)}::uuid`,
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(pettyPurchases)
      .where(and(...filters))
      .orderBy(desc(pettyPurchases.businessDate), desc(pettyPurchases.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toPettyPurchase),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.businessDate, last.id])
            : null,
      },
    };
  });
}

/** GET one petty purchase; another outlet or tenant is a 404. */
export async function getPettyPurchase(
  context: ScopedTenantContext,
  actorUserId: string,
  pettyPurchaseId: string,
): Promise<PettyPurchase> {
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(pettyPurchases)
      .where(
        and(
          eq(pettyPurchases.tenantId, context.tenant.tenantId),
          eq(pettyPurchases.id, pettyPurchaseId),
        ),
      );
    if (!row)
      throw new HttpError(404, "NOT_FOUND", "Petty purchase not found.");
    const snapshot = await accessSnapshotInTransaction(
      tx,
      context,
      actorUserId,
      new Date(),
    );
    if (!anyAllows(snapshot, PETTY_PURCHASE_READ_PERMISSIONS, row.outletId))
      throw new AccessError("PERMISSION_DENIED");
    return toPettyPurchase(row);
  });
}

/** GET the effective limit of an outlet (its own row, else the tenant default). */
export async function getPettyPurchasePolicy(
  context: ScopedTenantContext,
  actorUserId: string,
  query: PettyPurchasePolicyQuery,
): Promise<PettyPurchasePolicy> {
  assertOutlet(context, query.outletId);
  return withTenant(db, context, async (tx) => {
    const snapshot = await accessSnapshotInTransaction(
      tx,
      context,
      actorUserId,
      new Date(),
    );
    if (!anyAllows(snapshot, PETTY_POLICY_READ_PERMISSIONS, query.outletId))
      throw new AccessError("PERMISSION_DENIED");
    const { all, outletRow } = await loadPolicies(tx, context, query.outletId);
    const effective =
      outletRow ?? all.find((policy) => policy.outletId === null) ?? null;
    if (!effective)
      throw new HttpError(
        404,
        "NOT_FOUND",
        "No petty purchase limit is configured.",
      );
    return pettyPurchasePolicySchema.parse(effective);
  });
}

/**
 * PUT the limit of one outlet, or the tenant default when `outletId` is null
 * (needs the permission tenant-wide). Upserts and audits the change.
 */
export async function putPettyPurchasePolicy(
  context: ScopedTenantContext,
  actorUserId: string,
  input: PutPettyPurchasePolicyInput,
): Promise<PettyPurchasePolicy> {
  if (input.outletId !== null) assertOutlet(context, input.outletId);
  const claim = {
    operation: POLICY_OPERATION,
    key: input.idempotencyKey,
    outletId: input.outletId,
    fingerprint: requestFingerprint(POLICY_OPERATION, actorUserId, {
      outletId: input.outletId,
      limitIdr: input.limitIdr,
    }),
  };
  try {
    return await withTenant(db, context, async (tx) => {
      const snapshot = await accessSnapshotInTransaction(
        tx,
        context,
        actorUserId,
        new Date(),
      );
      const target =
        input.outletId === null
          ? ({ type: "tenant" } as const)
          : outletTarget(input.outletId);
      if (!snapshot.allows(POLICY_PERMISSION, target))
        throw new AccessError("PERMISSION_DENIED");
      const replay = await claimPurchasingIdempotency(tx, context, claim);
      if (replay) return pettyPurchasePolicySchema.parse(replay.replay);

      const scope =
        input.outletId === null
          ? isNull(pettyPurchasePolicies.outletId)
          : eq(pettyPurchasePolicies.outletId, input.outletId);
      const [before] = await tx
        .select({ limitIdr: pettyPurchasePolicies.limitIdr })
        .from(pettyPurchasePolicies)
        .where(
          and(
            eq(pettyPurchasePolicies.tenantId, context.tenant.tenantId),
            scope,
          ),
        )
        .for("update");
      const now = new Date();
      await tx
        .insert(pettyPurchasePolicies)
        .values({
          tenantId: context.tenant.tenantId,
          outletId: input.outletId,
          limitIdr: input.limitIdr as Idr,
          updatedBy: actorUserId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target:
            input.outletId === null
              ? [pettyPurchasePolicies.tenantId]
              : [
                  pettyPurchasePolicies.tenantId,
                  pettyPurchasePolicies.outletId,
                ],
          targetWhere:
            input.outletId === null
              ? sql`${pettyPurchasePolicies.outletId} IS NULL`
              : sql`${pettyPurchasePolicies.outletId} IS NOT NULL`,
          set: {
            limitIdr: input.limitIdr as Idr,
            updatedBy: actorUserId,
            updatedAt: now,
          },
        });
      const policy = pettyPurchasePolicySchema.parse({
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        limitIdr: input.limitIdr,
      });
      await recordOpsAudit(tx, context, {
        actorUserId,
        // The tenant default (null outlet) is audited tenant-wide.
        outletId: input.outletId,
        action: "purchasing.petty_policy_set",
        objectType: "petty_purchase_policy",
        objectId: input.outletId ?? context.tenant.tenantId,
        before: before
          ? { outletId: input.outletId, limitIdr: before.limitIdr }
          : null,
        after: { outletId: input.outletId, limitIdr: input.limitIdr },
        safeFields: POLICY_AUDIT_FIELDS,
      });
      await completePurchasingIdempotency(tx, context, claim, policy);
      return policy;
    });
  } catch (error) {
    throw translatePurchasingError(translateInventoryError(error));
  }
}
