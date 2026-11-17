// Remake / comp / complaint log (bead legend-4b5; PRD v1.7 §6 C `order_issues`,
// F41 "Remake & Comp", KDS-07, R25; contract @starter/shared/kitchen
// `reportOrderIssue` + `listOrderIssues`).
//
// - Permission `kds.remake_comp.record`: held on the named station, or (no
//   station) on the outlet. A station-only account sees and files only its own
//   station (TEN-03, legend-fsb7).
// - The ingredient cost is computed here from the recipe at the sale location
//   moving-average cost; the client never sends it (KDS-07).
// - Stock: a remake always appends `order_issue.recorded` (the kitchen cooks
//   the line again; the sale deduction stays). A comp is accepted only on a
//   voided line and then appends it: a comp of a still-billed line is already
//   drawn by `order.paid`, and a second draw would count it twice
//   (recipe-deduction.service.ts, consumer comment), so it is refused (422).
//   complaint and unfulfillable draw nothing.
// - R25: a supervisor id in the body is not proof of approval, so a manual
//   refund is refused (422) until a real approval flow exists.
// - Idempotency: `idempotencyKey` is unique per tenant; a resend returns the
//   stored row without a second row or event. At most one live comp per line
//   (partial unique index), so two concurrent comps end in one 409.

import { and, desc, eq, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { AccessError } from "@starter/shared/access";
import {
  assertOutletInScope,
  CoreError,
  createUlid,
  encodeCursor,
  idr,
  outletIdSchema,
  toIsoDateTime,
  userIdSchema,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  orderIssueRecordedEvent,
  orderIssueRecordedPayloadSchema,
} from "@starter/shared/inventory";
import {
  orderIssueSchema,
  orderIssueViewSchema,
  type CreateOrderIssueInput,
  type OrderIssue,
  type OrderIssueView,
  type OrderIssueType,
} from "@starter/shared/kitchen";
import { db } from "../db/index.ts";
import { stations } from "../db/schema/index.ts";
import { promotions, vouchers } from "../db/schema/crm-promo.ts";
import { apologyVouchers } from "../db/schema/apology-vouchers.ts";
import { menuItems } from "../db/schema/menu.ts";
import { orderIssues } from "../db/schema/kds-issues.ts";
import { posOrderItems } from "../db/schema/pos-order.ts";
import { orderItems, orders } from "../db/schema/qr-order.ts";
import { roleAssignments } from "../db/schema/platform-access.ts";
import { user } from "../db/schema/user.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import { appendOutbox } from "./core-outbox.ts";
import { promotionAvailability, voucherUsability } from "@starter/shared/crm";
import { toVoucher } from "./crm-promo-engine.ts";
import { promotionDisabledAtOutlet } from "./crm-promo-outlets.ts";
import {
  cursorInstant,
  cursorKeys,
  cursorUuid,
  type CursorPage,
} from "./inventory-ops.shared.ts";
import type { Tx } from "./menu-internals.ts";
import { accessSnapshotInTransaction } from "./permission-resolver.ts";
import { estimateDeductionCostIdr } from "./recipe-deduction.service.ts";
import {
  assertStationPermission,
  permittedStationIds,
} from "./station-access.ts";

const RECORD = "kds.remake_comp.record";
const EVENT_DESTINATION = "cloud-sync";
const DEFAULT_LIMIT = 50;
const COMP_ONCE_INDEX = "order_issues_comp_once_idx";
const IDEMPOTENCY_KEY = "order_issues_tenant_idempotency_key";
const VOUCHER_ONCE_INDEX = "order_issues_voucher_once_idx";
const AUDIT_SAFE_FIELDS = ["id", "type", "reason", "stationId", "costIdr"];

const deniedOutlet = () =>
  new AccessError(
    "PERMISSION_DENIED",
    "Anda tidak dapat mencatat remake atau comp di outlet ini.",
  );
const orderNotFound = () =>
  new CoreError("NOT_FOUND", "Pesanan tidak ditemukan di outlet ini.");
const itemNotFound = () =>
  new CoreError("NOT_FOUND", "Item pesanan tidak ditemukan pada pesanan ini.");
const unprocessable = (message: string) =>
  new HttpError(422, "VALIDATION_ERROR", message);

const VOUCHER_REJECTION_MESSAGE: Partial<
  Record<NonNullable<ReturnType<typeof voucherUsability>>, string>
> = {
  cancelled: "Voucher yang dipilih sudah dicabut.",
  expired: "Voucher yang dipilih sudah kedaluwarsa.",
  not_started: "Voucher yang dipilih belum berlaku.",
  already_redeemed: "Voucher yang dipilih sudah habis dipakai.",
};

type IssueRow = typeof orderIssues.$inferSelect;

function toIssue(row: IssueRow): OrderIssue {
  return orderIssueSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    orderId: row.orderId,
    orderItemId: row.orderItemId,
    type: row.type,
    reason: row.reason,
    reasonNote: row.reasonNote,
    stationId: row.stationId,
    employeeId: row.employeeId,
    reportedBy: row.reportedBy,
    resolution: row.resolution,
    replacementItemId: row.replacementItemId,
    voucherId: row.voucherId,
    priceDifferenceIdr: row.priceDifferenceIdr,
    approvedBy: row.approvedBy,
    costIdr: row.costIdr,
    status: row.status,
    createdAt: toIsoDateTime(row.createdAt),
    resolvedAt: row.resolvedAt ? toIsoDateTime(row.resolvedAt) : null,
  });
}

/** Name of the violated unique constraint, directly or in drizzle's cause chain. */
function uniqueViolationOf(error: unknown, depth = 0): string | null {
  if (depth > 4 || typeof error !== "object" || error === null) return null;
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    cause?: unknown;
  };
  if (candidate.code === "23505")
    return typeof candidate.constraint === "string" ? candidate.constraint : "";
  return uniqueViolationOf(candidate.cause, depth + 1);
}

/**
 * The voucher and swap item named in a report must belong to this tenant, and
 * a voucher's promotion must run at this outlet (legend-o8quo). The voucher
 * must also still be usable (not cancelled, expired or already redeemed) and
 * its promotion live (active, inside its period): a dead voucher or promotion
 * is never a compensation (legend-c1gnr). The voucher row is locked so a
 * concurrent cancel or redeem is seen, and a voucher settles one issue only
 * (`order_issues_voucher_once_idx`). The FK is tenant-scoped only and RLS
 * hides other tenants' rows, so a stray id would otherwise be stored
 * unchecked.
 */
async function assertResolutionTargets(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  input: CreateOrderIssueInput,
  now: Date,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  if (input.voucherId !== null) {
    const [voucher] = await tx
      .select()
      .from(vouchers)
      .where(
        and(eq(vouchers.tenantId, tenantId), eq(vouchers.id, input.voucherId)),
      )
      .limit(1)
      .for("update");
    if (!voucher)
      throw unprocessable("Voucher yang dipilih bukan milik tenant ini.");
    // The voucher's own customer is not compared with the order's here.
    const voucherRejection = voucherUsability(toVoucher(voucher), {
      customerProfileId: voucher.customerProfileId,
      at: now.toISOString(),
    });
    if (voucherRejection !== null)
      throw unprocessable(
        VOUCHER_REJECTION_MESSAGE[voucherRejection] ??
          "Voucher yang dipilih tidak dapat dipakai.",
      );
    if (voucher.promotionId !== null) {
      const [promotion] = await tx
        .select({
          status: promotions.status,
          startsAt: promotions.startsAt,
          endsAt: promotions.endsAt,
        })
        .from(promotions)
        .where(
          and(
            eq(promotions.tenantId, tenantId),
            eq(promotions.id, voucher.promotionId),
          ),
        )
        .limit(1);
      // The FK makes a missing row unreachable; refuse it anyway (as the engine does).
      if (promotion === undefined)
        throw unprocessable("Promo voucher yang dipilih sudah tidak berlaku.");
      if (
        promotionAvailability(
          {
            status: promotion.status,
            startsAt: promotion.startsAt.toISOString(),
            endsAt: promotion.endsAt?.toISOString() ?? null,
          },
          now.toISOString(),
        ) !== null
      )
        throw unprocessable("Promo voucher yang dipilih sudah tidak berlaku.");
    }
    if (
      voucher.promotionId !== null &&
      (await promotionDisabledAtOutlet(
        tx,
        context,
        voucher.promotionId,
        outletId,
      ))
    )
      throw unprocessable("Voucher yang dipilih tidak berlaku di outlet ini.");
    const [used] = await tx
      .select({ id: orderIssues.id })
      .from(orderIssues)
      .where(
        and(
          eq(orderIssues.tenantId, tenantId),
          eq(orderIssues.voucherId, input.voucherId),
        ),
      )
      .limit(1);
    if (used)
      throw new CoreError(
        "CONFLICT",
        "Voucher ini sudah dipakai untuk laporan lain.",
      );
    // An apology voucher is linked to a report through its own id
    // (order-recovery), so the check above cannot see that link.
    const [apologyUsed] = await tx
      .select({ id: apologyVouchers.id })
      .from(apologyVouchers)
      .where(
        and(
          eq(apologyVouchers.tenantId, tenantId),
          eq(apologyVouchers.voucherId, input.voucherId),
          or(
            sql`${apologyVouchers.orderIssueId} IS NOT NULL`,
            sql`EXISTS (SELECT 1 FROM ${orderIssues} WHERE ${orderIssues.tenantId} = ${apologyVouchers.tenantId} AND ${orderIssues.voucherId} = ${apologyVouchers.id})`,
          ),
        ),
      )
      .limit(1);
    if (apologyUsed)
      throw new CoreError(
        "CONFLICT",
        "Voucher ini sudah dipakai untuk laporan lain.",
      );
  }
  if (input.replacementItemId !== null) {
    const [item] = await tx
      .select({ id: menuItems.id })
      .from(menuItems)
      .where(
        and(
          eq(menuItems.tenantId, tenantId),
          eq(menuItems.id, input.replacementItemId),
        ),
      )
      .limit(1);
    if (!item)
      throw unprocessable(
        "Menu pengganti yang dipilih bukan milik tenant ini.",
      );
  }
}

/** A user with an active role assignment in this tenant (a staff member). */
async function isTenantStaff(
  tx: Tx,
  context: ScopedTenantContext,
  userId: string,
  now: Date,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.tenantId, context.tenant.tenantId),
        eq(roleAssignments.userId, userId),
        sql`${roleAssignments.validFrom} <= ${now}`,
        or(
          isNull(roleAssignments.validUntil),
          sql`${roleAssignments.validUntil} > ${now}`,
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
}

async function assertStationInOutlet(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  stationId: string,
): Promise<void> {
  const [station] = await tx
    .select({ id: stations.id })
    .from(stations)
    .where(
      and(
        eq(stations.tenantId, context.tenant.tenantId),
        eq(stations.outletId, outletId),
        eq(stations.id, stationId),
        isNull(stations.deletedAt),
      ),
    );
  if (!station)
    throw new CoreError(
      "NOT_FOUND",
      "Stasiun dapur tidak ditemukan di outlet ini.",
    );
}

export async function reportOrderIssue(
  context: ScopedTenantContext,
  actorUserId: string,
  outletIdRaw: string,
  orderId: string,
  input: CreateOrderIssueInput,
  now: Date,
): Promise<OrderIssue> {
  const outletId = outletIdSchema.parse(outletIdRaw);
  assertOutletInScope(context.outletScope, outletId);
  const store = () =>
    storeOrderIssue(context, actorUserId, outletId, orderId, input, now);
  try {
    return await store();
  } catch (error) {
    // The losing writer of a race: the failed transaction left nothing behind.
    const violated = uniqueViolationOf(error);
    if (violated === COMP_ONCE_INDEX)
      throw new CoreError("CONFLICT", "Item ini sudah pernah di-comp.");
    if (violated === VOUCHER_ONCE_INDEX)
      throw new CoreError(
        "CONFLICT",
        "Voucher ini sudah dipakai untuk laporan lain.",
      );
    if (violated === IDEMPOTENCY_KEY) return store();
    throw error;
  }
}

async function storeOrderIssue(
  context: ScopedTenantContext,
  actorUserId: string,
  outletId: OutletId,
  orderId: string,
  input: CreateOrderIssueInput,
  now: Date,
): Promise<OrderIssue> {
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const snapshot = await accessSnapshotInTransaction(
      tx,
      context,
      actorUserId,
      now,
    );
    if (input.stationId !== null) {
      await assertStationPermission(
        tx,
        context,
        actorUserId,
        RECORD,
        input.stationId,
        now,
      );
      await assertStationInOutlet(tx, context, outletId, input.stationId);
    } else if (!snapshot.allows(RECORD, { type: "outlet", id: outletId })) {
      throw deniedOutlet();
    }

    // R25: the approver id alone is no proof, and no approval flow exists here.
    if (input.resolution === "manual_refund")
      throw unprocessable(
        "Refund manual butuh alur persetujuan yang belum tersedia di sini.",
      );

    const [replay] = await tx
      .select()
      .from(orderIssues)
      .where(
        and(
          eq(orderIssues.tenantId, tenantId),
          eq(orderIssues.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (replay) {
      if (
        replay.outletId !== outletId ||
        replay.orderId !== orderId ||
        replay.orderItemId !== input.orderItemId
      )
        throw new CoreError(
          "CONFLICT",
          "Kunci idempotensi ini sudah dipakai untuk laporan lain.",
        );
      return toIssue(replay);
    }

    const [order] = await tx
      .select({ id: orders.id, businessDate: orders.businessDate })
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.outletId, outletId),
          eq(orders.id, orderId),
        ),
      );
    if (!order) throw orderNotFound();
    const [line] = await tx
      .select({
        id: orderItems.id,
        menuItemId: orderItems.menuItemId,
        variantId: orderItems.variantId,
        quantity: orderItems.quantity,
        modifiers: orderItems.modifiers,
        status: orderItems.status,
        posVoidedAt: posOrderItems.voidedAt,
      })
      .from(orderItems)
      .leftJoin(
        posOrderItems,
        and(
          eq(posOrderItems.tenantId, orderItems.tenantId),
          eq(posOrderItems.itemId, orderItems.id),
        ),
      )
      .where(
        and(
          eq(orderItems.tenantId, tenantId),
          eq(orderItems.outletId, outletId),
          eq(orderItems.orderId, orderId),
          eq(orderItems.id, input.orderItemId),
        ),
      );
    if (!line) throw itemNotFound();

    if (
      input.employeeId !== null &&
      !(await isTenantStaff(tx, context, input.employeeId, now))
    )
      throw unprocessable("Staf yang dicatat bukan staf tenant ini.");
    await assertResolutionTargets(tx, context, outletId, input, now);

    const lineVoided = line.status === "voided" || line.posVoidedAt !== null;
    // A comp of a billed line is already drawn by `order.paid`; only a voided
    // line leaves the stock for the comp to draw.
    if (input.type === "comp" && !lineVoided)
      throw unprocessable(
        "Comp hanya untuk item yang sudah di-void; item yang masih tertagih tidak bisa di-comp.",
      );
    if (input.type === "comp") {
      const [existing] = await tx
        .select({ id: orderIssues.id })
        .from(orderIssues)
        .where(
          and(
            eq(orderIssues.tenantId, tenantId),
            eq(orderIssues.orderItemId, input.orderItemId),
            eq(orderIssues.type, "comp"),
            ne(orderIssues.status, "cancelled"),
          ),
        )
        .limit(1);
      if (existing)
        throw new CoreError("CONFLICT", "Item ini sudah pernah di-comp.");
    }

    const modifierIds = (line.modifiers ?? []).map(
      (modifier) => modifier.modifierId,
    );
    const costIdr = await estimateDeductionCostIdr(tx, context, outletId, [
      {
        menuItemId: line.menuItemId,
        variantId: line.variantId ?? null,
        modifierIds,
        quantity: line.quantity,
      },
    ]);

    const [row] = await tx
      .insert(orderIssues)
      .values({
        tenantId,
        outletId,
        orderId,
        orderItemId: input.orderItemId,
        type: input.type,
        reason: input.reason,
        reasonNote: input.reasonNote,
        stationId: input.stationId,
        employeeId: input.employeeId,
        reportedBy: actorUserId,
        resolution: input.resolution,
        replacementItemId: input.replacementItemId,
        voucherId: input.voucherId,
        approvedBy: input.approvedBy,
        idempotencyKey: input.idempotencyKey,
        costIdr: idr(costIdr),
        // A resolution given with the report settles the issue at once.
        status: input.resolution === null ? "open" : "resolved",
        createdAt: now,
        resolvedAt: input.resolution === null ? null : now,
      })
      .returning();
    if (!row) throw new Error("order issue not stored");

    const drawsStock = input.type === "remake" || input.type === "comp";
    if (drawsStock) {
      const payload = orderIssueRecordedPayloadSchema.parse({
        issueId: row.id,
        orderId,
        orderItemId: input.orderItemId,
        outletId,
        businessDate: order.businessDate,
        type: input.type,
        reason: input.reason,
        stationId: input.stationId,
        recordedBy: userIdSchema.parse(actorUserId),
        menuItemId: line.menuItemId,
        variantId: line.variantId ?? null,
        modifierIds,
        quantity: line.quantity,
        occurredAt: toIsoDateTime(now),
      });
      const event = orderIssueRecordedEvent.envelopeSchema.parse({
        id: createUlid(now.getTime()),
        tenantId,
        outletId,
        name: orderIssueRecordedEvent.name,
        version: orderIssueRecordedEvent.version,
        aggregateType: orderIssueRecordedEvent.entry.aggregateType,
        aggregateId: row.id,
        // One aggregate per issue: a single, immutable event.
        sequence: 1,
        occurredAt: toIsoDateTime(now),
        actor: { type: "user", id: actorUserId },
        deviceId: null,
        idempotencyKey: `order_issue.recorded:${row.id}`,
        payloadSchemaRef: orderIssueRecordedEvent.payloadSchemaRef,
        payload,
      });
      await appendOutbox(tx, context, {
        id: createUlid(now.getTime()),
        event,
        destination: EVENT_DESTINATION,
        direction: null,
        peerId: null,
      });
    }

    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId,
        outletId,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: `order_issue.${input.type}`,
        objectType: "order",
        objectId: orderId,
        reason: input.reasonNote,
        maskedChanges: {
          before: null,
          after: {
            id: row.id,
            type: input.type,
            reason: input.reason,
            stationId: input.stationId,
            costIdr,
          },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: toIsoDateTime(now),
      },
      AUDIT_SAFE_FIELDS,
    );
    return toIssue(row);
  });
}

export type ListOrderIssuesQuery = {
  type?: OrderIssueType;
  stationId?: string;
  cursor?: string;
  limit?: number;
};

export async function listOrderIssues(
  context: ScopedTenantContext,
  actorUserId: string,
  outletIdRaw: string,
  query: ListOrderIssuesQuery,
  now: Date,
): Promise<CursorPage<OrderIssueView>> {
  const outletId = outletIdSchema.parse(outletIdRaw);
  assertOutletInScope(context.outletScope, outletId);
  const limit = query.limit ?? DEFAULT_LIMIT;
  return withTenant(db, context, async (tx) => {
    const snapshot = await accessSnapshotInTransaction(
      tx,
      context,
      actorUserId,
      now,
    );
    const filters: SQL[] = [
      eq(orderIssues.tenantId, context.tenant.tenantId),
      eq(orderIssues.outletId, outletId),
    ];
    if (!snapshot.allows(RECORD, { type: "outlet", id: outletId })) {
      // Station-only caller: only the stations they reach; outlet-level
      // issues (no station) stay outside their reach.
      const reach = await permittedStationIds(
        tx,
        context,
        actorUserId,
        RECORD,
        now,
      );
      if (reach.length === 0) throw deniedOutlet();
      filters.push(
        sql`${orderIssues.stationId} IN (${sql.join(
          reach.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`,
      );
    }
    if (query.type) filters.push(eq(orderIssues.type, query.type));
    if (query.stationId)
      filters.push(eq(orderIssues.stationId, query.stationId));
    const [createdAt, id] = cursorKeys(query.cursor, 2);
    if (createdAt !== undefined && id !== undefined) {
      const at = cursorInstant(createdAt);
      filters.push(
        or(
          lt(orderIssues.createdAt, at),
          and(
            eq(orderIssues.createdAt, at),
            sql`${orderIssues.id} < ${cursorUuid(id)}::uuid`,
          ),
        )!,
      );
    }
    // Readable labels (legend-0eq7): the order number, the line name snapshot
    // and the staff names, joined inside the caller's tenant transaction.
    const reporter = alias(user, "issue_reporter");
    const employee = alias(user, "issue_employee");
    const approver = alias(user, "issue_approver");
    const rows = await tx
      .select({
        issue: orderIssues,
        orderLabel: orders.number,
        itemName: orderItems.name,
        reportedByName: reporter.name,
        employeeName: employee.name,
        approvedByName: approver.name,
      })
      .from(orderIssues)
      .innerJoin(
        orders,
        and(
          eq(orders.tenantId, orderIssues.tenantId),
          eq(orders.id, orderIssues.orderId),
        ),
      )
      .innerJoin(
        orderItems,
        and(
          eq(orderItems.tenantId, orderIssues.tenantId),
          eq(orderItems.id, orderIssues.orderItemId),
        ),
      )
      .innerJoin(reporter, eq(reporter.id, orderIssues.reportedBy))
      .leftJoin(employee, eq(employee.id, orderIssues.employeeId))
      .leftJoin(approver, eq(approver.id, orderIssues.approvedBy))
      .where(and(...filters))
      .orderBy(desc(orderIssues.createdAt), desc(orderIssues.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1)?.issue;
    return {
      data: page.map((row) =>
        orderIssueViewSchema.parse({
          ...toIssue(row.issue),
          orderLabel: row.orderLabel,
          itemName: row.itemName,
          reportedByName: row.reportedByName,
          employeeName: row.employeeName,
          approvedByName: row.approvedByName,
        }),
      ),
      meta: {
        limit,
        nextCursor:
          rows.length > limit && last
            ? encodeCursor([last.createdAt.toISOString(), last.id])
            : null,
      },
    };
  });
}
