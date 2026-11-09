// Expo board, runner roster, runner assignment and "Diantar" (bead legend-him8j;
// PRD v1.7 §3 F12 "Expo"; contract @starter/shared/kitchen `expoBoardSchema`,
// `expoTicketSchema`, `expoDeliveryBlock`, `expoRunnerSchema`; tables
// legend-aiksz, migration 0168).
//
// - Every query runs on a `withTenant` transaction (tenant + outlet RLS); the
//   path outlet is asserted against the caller's scope as well.
// - One expo ticket = one order of the outlet with at least one non-cancelled
//   kitchen ticket. Order voided = not on the board. `isComplete` = every
//   non-cancelled ticket is `done` (a `recalled` ticket reopens it); `readyAt`
//   = the latest `done_at`.
// - Assign and deliver of one order serialise on a transaction advisory lock,
//   so parallel calls end in one `expo_assignments` row and one `delivered_at`.
// - Runner roster (legend-aiksz: `runner_id` has no FK): a user with a live
//   (not expired) role assignment on the tenant or on this outlet, not banned.
//   Brand- and station-scoped assignments are not counted (no org index here).
// - Channel on the ticket: delivery platforms and `reservation` pass through;
//   anything else follows `service_type` (`delivery` without a platform is
//   shown as `takeaway`: the contract has no plain delivery channel).

import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { maskAuditChanges } from "@starter/shared/audit";
import {
  createUlid,
  outletIdSchema,
  toIsoDateTime,
  userIdSchema,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  expoBoardSchema,
  expoDeliveryBlock,
  expoRunnerSchema,
  expoTicketSchema,
  type ExpoBoard,
  type ExpoRunner,
  type ExpoTicket,
} from "@starter/shared/kitchen";
import { db } from "../db/index.ts";
import {
  expoAssignments,
  kitchenTickets,
  orders,
  pickupCalls,
  roleAssignments,
  stations,
  tableSessions,
  tables,
  user,
} from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import type { KdsActor } from "./kds-support.ts";
import type { Tx } from "./permission-resolver.ts";
import { businessDateFor, loadOutlet } from "./pos-order-support.ts";

const AUDIT_SAFE_FIELDS = ["orderId", "runnerId", "deliveredAt"];

type ExpoChannel = ExpoTicket["channel"];

function expoChannel(channel: string, serviceType: string): ExpoChannel {
  if (
    channel === "gofood" ||
    channel === "grabfood" ||
    channel === "shopeefood" ||
    channel === "reservation"
  )
    return channel;
  return serviceType === "dine_in" ? "dine_in" : "takeaway";
}

function notOnExpo(): HttpError {
  return new HttpError(404, "NOT_FOUND", "Pesanan tidak ada di expo.");
}

/** Expo tickets for the orders matching `orderFilter` (outlet + tenant fixed). */
async function loadExpoTickets(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  orderFilter: ReturnType<typeof and>,
): Promise<ExpoTicket[]> {
  const tenantId = context.tenant.tenantId;
  const orderRows = await tx
    .select({
      id: orders.id,
      channel: orders.channel,
      serviceType: orders.serviceType,
      tableLabel: tables.code,
      pickupNumber: pickupCalls.number,
      runnerId: expoAssignments.runnerId,
      runnerAssignedAt: expoAssignments.runnerAssignedAt,
      deliveredAt: expoAssignments.deliveredAt,
    })
    .from(orders)
    .leftJoin(
      tableSessions,
      and(
        eq(tableSessions.tenantId, orders.tenantId),
        eq(tableSessions.id, orders.tableSessionId),
      ),
    )
    .leftJoin(
      tables,
      and(
        eq(tables.tenantId, tableSessions.tenantId),
        eq(tables.id, tableSessions.tableId),
      ),
    )
    .leftJoin(
      pickupCalls,
      and(
        eq(pickupCalls.tenantId, orders.tenantId),
        eq(pickupCalls.orderId, orders.id),
      ),
    )
    .leftJoin(
      expoAssignments,
      and(
        eq(expoAssignments.tenantId, orders.tenantId),
        eq(expoAssignments.orderId, orders.id),
      ),
    )
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.outletId, outletId),
        ne(orders.status, "voided"),
        orderFilter,
      ),
    );
  if (orderRows.length === 0) return [];

  const ticketRows = await tx
    .select({
      orderId: kitchenTickets.orderId,
      ticketId: kitchenTickets.id,
      stationId: kitchenTickets.stationId,
      stationName: stations.name,
      status: kitchenTickets.status,
      firedAt: kitchenTickets.firedAt,
      doneAt: kitchenTickets.doneAt,
    })
    .from(kitchenTickets)
    .innerJoin(
      stations,
      and(
        eq(stations.tenantId, kitchenTickets.tenantId),
        eq(stations.id, kitchenTickets.stationId),
      ),
    )
    .where(
      and(
        eq(kitchenTickets.tenantId, tenantId),
        eq(kitchenTickets.outletId, outletId),
        ne(kitchenTickets.status, "cancelled"),
        inArray(
          kitchenTickets.orderId,
          orderRows.map((o) => o.id),
        ),
      ),
    )
    .orderBy(asc(kitchenTickets.firedAt), asc(kitchenTickets.id));

  const byOrder = new Map<string, typeof ticketRows>();
  for (const t of ticketRows)
    byOrder.set(t.orderId, [...(byOrder.get(t.orderId) ?? []), t]);

  const result: { firedAt: Date; ticket: ExpoTicket }[] = [];
  for (const o of orderRows) {
    const tickets = byOrder.get(o.id);
    if (!tickets || tickets.length === 0) continue;
    const isComplete = tickets.every((t) => t.status === "done");
    const readyAt = isComplete
      ? tickets.reduce<Date | null>(
          (max, t) => (t.doneAt && (!max || t.doneAt > max) ? t.doneAt : max),
          null,
        )
      : null;
    result.push({
      firedAt: tickets[0]!.firedAt,
      ticket: expoTicketSchema.parse({
        tenantId,
        outletId,
        orderId: o.id,
        channel: expoChannel(o.channel, o.serviceType),
        tableLabel: o.tableLabel ?? null,
        pickupNumber: o.pickupNumber ?? null,
        stations: tickets.map((t) => ({
          stationId: t.stationId,
          stationName: t.stationName,
          ticketId: t.ticketId,
          status: t.status,
        })),
        isComplete,
        readyAt: readyAt?.toISOString() ?? null,
        runnerId: o.runnerId ?? null,
        runnerAssignedAt: o.runnerAssignedAt?.toISOString() ?? null,
        deliveredAt: o.deliveredAt?.toISOString() ?? null,
      }),
    });
  }
  return result
    .sort(
      (a, b) =>
        a.firedAt.getTime() - b.firedAt.getTime() ||
        a.ticket.orderId.localeCompare(b.ticket.orderId),
    )
    .map((r) => r.ticket);
}

async function loadOneExpoTicket(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  orderId: string,
): Promise<ExpoTicket> {
  const [ticket] = await loadExpoTickets(
    tx,
    context,
    outletId,
    eq(orders.id, orderId),
  );
  if (!ticket) throw notOnExpo();
  return ticket;
}

/** Serialises assign/deliver of one order; held until the transaction ends. */
async function lockExpoOrder(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`expo-order:${context.tenant.tenantId}:${orderId}`}, 0))`,
  );
}

async function auditExpo(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    action: string;
    outletId: string;
    orderId: string;
    actor: KdsActor;
    before: Record<string, unknown> | null;
    after: Record<string, unknown>;
  },
  now: Date,
): Promise<void> {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: input.outletId,
      actorType: "user",
      actorId: input.actor.userId,
      deviceId: input.actor.deviceId,
      action: input.action,
      objectType: "order",
      objectId: input.orderId,
      reason: null,
      maskedChanges: {
        before:
          input.before === null
            ? null
            : maskAuditChanges(input.before, AUDIT_SAFE_FIELDS),
        after: maskAuditChanges(input.after, AUDIT_SAFE_FIELDS),
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: toIsoDateTime(now),
    },
    AUDIT_SAFE_FIELDS,
  );
}

// ---- Board -----------------------------------------------------------------

export async function readExpoBoard(
  context: ScopedTenantContext,
  outletId: string,
  now: Date,
): Promise<ExpoBoard> {
  const outlet = outletIdSchema.parse(outletId);
  return withTenant(db, context, async (tx) => {
    const outletRow = await loadOutlet(tx, context, outlet);
    const today = businessDateFor(outletRow, now);
    const tickets = await loadExpoTickets(
      tx,
      context,
      outlet,
      eq(orders.businessDate, today),
    );
    return expoBoardSchema.parse({
      tenantId: context.tenant.tenantId,
      outletId: outlet,
      generatedAt: now.toISOString(),
      tickets,
    });
  });
}

// ---- Runners ---------------------------------------------------------------

/** Active staff reaching this outlet through the tenant or the outlet itself. */
function liveStaffOfOutlet(
  context: ScopedTenantContext,
  outletId: string,
  now: Date,
) {
  return and(
    eq(roleAssignments.tenantId, context.tenant.tenantId),
    lte(roleAssignments.validFrom, now),
    or(isNull(roleAssignments.validUntil), gt(roleAssignments.validUntil, now)),
    or(
      eq(roleAssignments.scopeType, "tenant"),
      and(
        eq(roleAssignments.scopeType, "outlet"),
        eq(roleAssignments.scopeId, outletId),
      ),
    ),
    or(isNull(user.banned), eq(user.banned, false)),
  );
}

export async function listExpoRunners(
  context: ScopedTenantContext,
  outletId: string,
  now: Date,
): Promise<ExpoRunner[]> {
  const outlet = outletIdSchema.parse(outletId);
  return withTenant(db, context, async (tx) => {
    await loadOutlet(tx, context, outlet);
    const rows = await tx
      .selectDistinct({ userId: user.id, name: user.name })
      .from(roleAssignments)
      .innerJoin(user, eq(user.id, roleAssignments.userId))
      .where(liveStaffOfOutlet(context, outlet, now))
      .orderBy(asc(user.name), asc(user.id));
    return rows.map((r) =>
      expoRunnerSchema.parse({
        tenantId: context.tenant.tenantId,
        outletId: outlet,
        userId: r.userId,
        name: r.name.slice(0, 150) || "-",
      }),
    );
  });
}

// ---- Actions ---------------------------------------------------------------

async function lockedAssignment(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
) {
  const [row] = await tx
    .select()
    .from(expoAssignments)
    .where(
      and(
        eq(expoAssignments.tenantId, context.tenant.tenantId),
        eq(expoAssignments.orderId, orderId),
      ),
    );
  return row ?? null;
}

/**
 * "Menugaskan runner": naming the same runner again is a repeat (unchanged);
 * before delivery another runner replaces the first; after delivery it is 409
 * EXPO_ORDER_DELIVERED. A runner outside the outlet's staff is 422
 * EXPO_RUNNER_INVALID.
 */
export async function assignExpoRunner(
  context: ScopedTenantContext,
  actor: KdsActor,
  outletId: string,
  orderId: string,
  runnerId: string,
  now: Date,
): Promise<ExpoTicket> {
  const outlet = outletIdSchema.parse(outletId);
  const runner = userIdSchema.parse(runnerId);
  const actorId = userIdSchema.parse(actor.userId);
  return withTenant(db, context, async (tx) => {
    await loadOutlet(tx, context, outlet);
    await lockExpoOrder(tx, context, orderId);
    // 404 first: an order that is not on the expo board reveals nothing.
    const ticket = await loadOneExpoTicket(tx, context, outlet, orderId);
    const existing = await lockedAssignment(tx, context, orderId);

    if (existing?.deliveredAt) {
      if (existing.runnerId === runner) return ticket;
      throw new HttpError(
        409,
        "EXPO_ORDER_DELIVERED",
        "Pesanan sudah diantar, runner tidak bisa diganti.",
      );
    }
    if (existing?.runnerId === runner) return ticket;

    const [staff] = await tx
      .select({ id: user.id })
      .from(roleAssignments)
      .innerJoin(user, eq(user.id, roleAssignments.userId))
      .where(
        and(
          eq(roleAssignments.userId, runner),
          liveStaffOfOutlet(context, outlet, now),
        ),
      )
      .limit(1);
    if (!staff)
      throw new HttpError(
        422,
        "EXPO_RUNNER_INVALID",
        "Runner bukan staf aktif outlet ini.",
      );

    const tenantId = context.tenant.tenantId;
    if (existing) {
      await tx
        .update(expoAssignments)
        .set({
          runnerId: runner,
          runnerAssignedAt: now,
          assignedBy: actorId,
          updatedAt: now,
        })
        .where(
          and(
            eq(expoAssignments.tenantId, tenantId),
            eq(expoAssignments.id, existing.id),
          ),
        );
    } else {
      await tx.insert(expoAssignments).values({
        tenantId,
        outletId: outlet,
        orderId,
        runnerId: runner,
        runnerAssignedAt: now,
        assignedBy: actorId,
      });
    }
    await auditExpo(
      tx,
      context,
      {
        action: "expo.runner.assign",
        outletId: outlet,
        orderId,
        actor,
        before: existing ? { orderId, runnerId: existing.runnerId } : null,
        after: { orderId, runnerId: runner },
      },
      now,
    );
    return loadOneExpoTicket(tx, context, outlet, orderId);
  });
}

/**
 * "Diantar": needs a complete ticket and a runner (`expoDeliveryBlock`);
 * repeating answers the ticket unchanged with the first `deliveredAt`.
 */
export async function markExpoOrderDelivered(
  context: ScopedTenantContext,
  actor: KdsActor,
  outletId: string,
  orderId: string,
  now: Date,
): Promise<ExpoTicket> {
  const outlet = outletIdSchema.parse(outletId);
  const actorId = userIdSchema.parse(actor.userId);
  return withTenant(db, context, async (tx) => {
    await loadOutlet(tx, context, outlet);
    await lockExpoOrder(tx, context, orderId);
    const ticket = await loadOneExpoTicket(tx, context, outlet, orderId);

    const block = expoDeliveryBlock(ticket);
    if (block === "EXPO_ORDER_NOT_COMPLETE")
      throw new HttpError(
        409,
        block,
        "Pesanan belum selesai di semua stasiun.",
      );
    if (block === "EXPO_RUNNER_NOT_ASSIGNED")
      throw new HttpError(409, block, "Pesanan belum punya runner.");
    if (ticket.deliveredAt !== null) return ticket;

    // `now` was taken before the lock wait (or comes from a skewed clock): a
    // concurrent assign may have stamped a later runner_assigned_at, and the
    // table CHECK needs delivered_at >= runner_assigned_at.
    const assignedAt = ticket.runnerAssignedAt
      ? new Date(ticket.runnerAssignedAt)
      : now;
    const deliveredAt = assignedAt > now ? assignedAt : now;

    await tx
      .update(expoAssignments)
      .set({ deliveredAt, deliveredBy: actorId, updatedAt: now })
      .where(
        and(
          eq(expoAssignments.tenantId, context.tenant.tenantId),
          eq(expoAssignments.orderId, orderId),
        ),
      );
    await auditExpo(
      tx,
      context,
      {
        action: "expo.order.deliver",
        outletId: outlet,
        orderId,
        actor,
        before: { orderId, runnerId: ticket.runnerId },
        after: {
          orderId,
          runnerId: ticket.runnerId,
          deliveredAt: deliveredAt.toISOString(),
        },
      },
      now,
    );
    return loadOneExpoTicket(tx, context, outlet, orderId);
  });
}
