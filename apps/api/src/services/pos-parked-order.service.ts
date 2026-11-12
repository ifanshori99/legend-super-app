import { createHash } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  assertOutletInScope,
  CoreError,
  type OutletId,
  type ScopedTenantContext,
  type UserId,
  type z,
} from "@starter/shared/core";
import {
  createPosParkedOrder as createEndpoint,
  posParkedOrderSchema,
  type PosParkedOrder,
} from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { tableSessions } from "../db/schema/floor.ts";
import { posParkedOrders } from "../db/schema/pos-parked-order.ts";
import { withTenant } from "../db/tenant.ts";
import { loadOutlet } from "./pos-order-support.ts";

type ParkedRow = typeof posParkedOrders.$inferSelect;
type CreateInput = z.infer<typeof createEndpoint.body>;

function detail(row: ParkedRow): PosParkedOrder {
  return posParkedOrderSchema.parse({
    ...row.snapshot,
    id: row.id,
    label: row.label,
    parkedAt: row.parkedAt.toISOString(),
  });
}

function ownerScope(
  context: ScopedTenantContext,
  outletId: OutletId,
  creatorUserId: UserId,
) {
  assertOutletInScope(context.outletScope, outletId);
  return and(
    eq(posParkedOrders.tenantId, context.tenant.tenantId),
    eq(posParkedOrders.outletId, outletId),
    eq(posParkedOrders.creatorUserId, creatorUserId),
  );
}

const notFound = () =>
  new CoreError("NOT_FOUND", "Pesanan tersimpan tidak ditemukan.");

function replay(row: ParkedRow, requestHash: string): PosParkedOrder {
  if (row.requestHash !== requestHash)
    throw new CoreError(
      "IDEMPOTENCY_KEY_REUSED",
      "Kunci idempotensi sudah digunakan untuk pesanan tersimpan lain.",
    );
  return detail(row);
}

export async function createPosParkedOrder(
  context: ScopedTenantContext,
  creatorUserId: UserId,
  outletId: OutletId,
  input: CreateInput,
): Promise<PosParkedOrder> {
  const scope = ownerScope(context, outletId, creatorUserId);
  const { idempotencyKey, ...snapshot } = input;
  const requestHash = createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex");
  return withTenant(db, context, async (tx) => {
    const intent = and(
      scope,
      eq(posParkedOrders.idempotencyKey, idempotencyKey),
    );
    const [existing] = await tx.select().from(posParkedOrders).where(intent);
    if (existing) return replay(existing, requestHash);
    await loadOutlet(tx, context, outletId);
    // A table reference must belong to this outlet, but a parked cart need
    // not yet satisfy order/catalog requirements or use an open session.
    if (snapshot.tableSessionId) {
      const [session] = await tx
        .select({ id: tableSessions.id })
        .from(tableSessions)
        .where(
          and(
            eq(tableSessions.tenantId, context.tenant.tenantId),
            eq(tableSessions.outletId, outletId),
            eq(tableSessions.id, snapshot.tableSessionId),
          ),
        );
      if (!session)
        throw new CoreError("NOT_FOUND", "Sesi meja tidak ditemukan.");
    }
    const [created] = await tx
      .insert(posParkedOrders)
      .values({
        tenantId: context.tenant.tenantId,
        outletId,
        creatorUserId,
        idempotencyKey,
        requestHash,
        snapshot,
        label: "Pesanan tersimpan",
      })
      .onConflictDoNothing({
        target: [
          posParkedOrders.tenantId,
          posParkedOrders.outletId,
          posParkedOrders.creatorUserId,
          posParkedOrders.idempotencyKey,
        ],
      })
      .returning();
    if (created) return detail(created);
    // Consumed rows are intentionally included: retrying the original park
    // intent must never revive a resumed cart or produce another snapshot.
    const [original] = await tx.select().from(posParkedOrders).where(intent);
    if (!original) throw notFound();
    return replay(original, requestHash);
  });
}

export async function listPosParkedOrders(
  context: ScopedTenantContext,
  creatorUserId: UserId,
  outletId: OutletId,
): Promise<PosParkedOrder[]> {
  const scope = ownerScope(context, outletId, creatorUserId);
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select()
      .from(posParkedOrders)
      .where(and(scope, isNull(posParkedOrders.consumedAt)))
      .orderBy(desc(posParkedOrders.parkedAt), desc(posParkedOrders.id));
    return rows.map(detail);
  });
}

export async function getPosParkedOrder(
  context: ScopedTenantContext,
  creatorUserId: UserId,
  outletId: OutletId,
  parkedOrderId: string,
): Promise<PosParkedOrder> {
  const scope = ownerScope(context, outletId, creatorUserId);
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(posParkedOrders)
      .where(
        and(
          scope,
          eq(posParkedOrders.id, parkedOrderId),
          isNull(posParkedOrders.consumedAt),
        ),
      );
    if (!row) throw notFound();
    return detail(row);
  });
}

export async function resumePosParkedOrder(
  context: ScopedTenantContext,
  creatorUserId: UserId,
  outletId: OutletId,
  parkedOrderId: string,
): Promise<PosParkedOrder> {
  const scope = ownerScope(context, outletId, creatorUserId);
  return withTenant(db, context, async (tx) => {
    // The condition and consumption share one UPDATE. Concurrent requests
    // cannot both return the same active snapshot, even with different keys.
    const [row] = await tx
      .update(posParkedOrders)
      .set({ consumedAt: new Date() })
      .where(
        and(
          scope,
          eq(posParkedOrders.id, parkedOrderId),
          isNull(posParkedOrders.consumedAt),
        ),
      )
      .returning();
    if (!row) throw notFound();
    return detail(row);
  });
}
