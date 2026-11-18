// Facility tickets sold at the POS (936, legend-hpgyw part D; contract
// @starter/shared/pos/ticket). A ticket is an ordinary line on a POS bill:
//
// - SALE (facility-pos-ticket-sale.ts): holds the slot and opens the bill; the
//   ticket stays `pending_payment` and nothing is usable yet.
// - PAID (`assertPosTicketsIssuable` + `issuePosTicketsForPaidOrder`, called by
//   completePosOrder, the only path that finishes a bill: cash, QRIS, EDC,
//   points and split all end there): the ticket becomes `issued` exactly once.
// - VOID before payment (`releasePosTicketsOfVoidedLines`, called by the
//   void-lines helper): the hold is cancelled and the slot is free again.
// - VOID / REFUND after payment (`refundPosTicketsOfRefundedLines`, called by
//   the correction void and the refund): the ticket becomes `refunded`, the
//   slot is released and the credential revoked. A ticket already in use,
//   completed or no-show is refused (409 TICKET_ALREADY_USED) BEFORE money moves
//   (the guest got the service). A refund with money but no item on a bill with
//   an issued ticket is refused too (the guest would be paid and keep the
//   ticket).
// - CREDENTIAL (`issuePosTicketCredential`): QR token and PIN are minted when
//   the cashier shows or prints the ticket, only for a paid ticket; only
//   digests are stored (a mint rotates the pair, a replay of the same key is
//   refused because the plaintext cannot be shown twice).
//
// Every read and write filters tenant (and RLS filters outlet). Entitlement:
// POS tickets are source `purchase`, so no ledger row backs them; a ledger id
// (never set by this flow) is left to the entitlement cancel path.
import { createHash, randomBytes, randomInt } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import type {
  OutletId,
  ScopedTenantContext,
  TenantId,
  UserId,
} from "@starter/shared/core";
import {
  FacilityError,
  ticketCredentialWindow,
  transitionTicket,
} from "@starter/shared/facility";
import type {
  PosOrderTicket,
  PosOrderTicketDisplay,
  PosTicketPrint,
} from "@starter/shared/pos/ticket";
import { db } from "../db/index.ts";
import { customerProfiles } from "../db/schema/crm-member.ts";
import {
  accessTickets,
  facilities,
  facilityAreas,
  facilityProducts,
  facilityUnits,
} from "../db/schema/facility.ts";
import {
  accessTicketCredentials,
  facilityTicketPosLines,
} from "../db/schema/facility-pos-ticket.ts";
import { orders } from "../db/schema/qr-order.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { enqueueTicketOnEdge } from "./facility-pos-ticket-print.ts";
import { notifyNextInQueue } from "./facility-slots.service.ts";
import { auditFacility, toTicket, type Tx } from "./facility-shared.ts";
import type { PosCaller } from "./pos-order-support.ts";

const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

type LineRow = typeof facilityTicketPosLines.$inferSelect;
type TicketRow = typeof accessTickets.$inferSelect;

// ---- Reads --------------------------------------------------------------------

async function ticketsOfOrder(
  tx: Tx,
  tenantId: TenantId,
  orderId: string,
): Promise<{ line: LineRow; ticket: TicketRow }[]> {
  const rows = await tx
    .select({ line: facilityTicketPosLines, ticket: accessTickets })
    .from(facilityTicketPosLines)
    .innerJoin(
      accessTickets,
      and(
        eq(accessTickets.tenantId, facilityTicketPosLines.tenantId),
        eq(accessTickets.id, facilityTicketPosLines.accessTicketId),
      ),
    )
    .where(
      and(
        eq(facilityTicketPosLines.tenantId, tenantId),
        eq(facilityTicketPosLines.orderId, orderId),
      ),
    )
    .orderBy(asc(facilityTicketPosLines.id));
  return rows;
}

const emptyDisplay: PosOrderTicketDisplay = {
  productName: "",
  facilityName: "",
  areaName: "",
  unitCode: null,
  customerName: "",
};

/** Read-only name lookup for the tickets of one bill (no price, no status). */
async function displayOfTickets(
  tx: Tx,
  tenantId: TenantId,
  ticketIds: string[],
): Promise<Map<string, PosOrderTicketDisplay>> {
  const out = new Map<string, PosOrderTicketDisplay>();
  if (ticketIds.length === 0) return out;
  const rows = await tx
    .select({
      ticketId: accessTickets.id,
      productName: facilityProducts.name,
      facilityName: facilities.name,
      areaName: facilityAreas.name,
      unitCode: facilityUnits.code,
      customerName: customerProfiles.name,
    })
    .from(accessTickets)
    .leftJoin(
      facilityProducts,
      and(
        eq(facilityProducts.tenantId, accessTickets.tenantId),
        eq(facilityProducts.id, accessTickets.productId),
      ),
    )
    .leftJoin(
      facilities,
      and(
        eq(facilities.tenantId, accessTickets.tenantId),
        eq(facilities.id, accessTickets.facilityId),
      ),
    )
    .leftJoin(
      facilityAreas,
      and(
        eq(facilityAreas.tenantId, accessTickets.tenantId),
        eq(facilityAreas.id, accessTickets.areaId),
      ),
    )
    .leftJoin(
      facilityUnits,
      and(
        eq(facilityUnits.tenantId, accessTickets.tenantId),
        eq(facilityUnits.id, accessTickets.unitId),
      ),
    )
    .leftJoin(
      customerProfiles,
      and(
        eq(customerProfiles.tenantId, accessTickets.tenantId),
        eq(customerProfiles.id, accessTickets.customerProfileId),
      ),
    )
    .where(
      and(
        eq(accessTickets.tenantId, tenantId),
        inArray(accessTickets.id, ticketIds),
      ),
    );
  for (const row of rows)
    out.set(row.ticketId, {
      productName: row.productName ?? "",
      facilityName: row.facilityName ?? "",
      areaName: row.areaName ?? "",
      unitCode: row.unitCode ?? null,
      customerName: row.customerName ?? "",
    });
  return out;
}

/** GET /api/pos/orders/:orderId/tickets. */
export async function listPosOrderTickets(
  context: ScopedTenantContext,
  outletId: OutletId,
  orderId: string,
): Promise<{ tickets: PosOrderTicket[] }> {
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    await assertOrderOfOutlet(tx, tenantId, outletId, orderId);
    const rows = await ticketsOfOrder(tx, tenantId, orderId);
    const names = await displayOfTickets(
      tx,
      tenantId,
      rows.map(({ ticket }) => ticket.id),
    );
    return {
      tickets: rows.map(({ line, ticket }) => ({
        ticket: toTicket(ticket),
        display: names.get(ticket.id) ?? emptyDisplay,
        orderItemId: line.orderItemId as PosOrderTicket["orderItemId"],
        lineStatus: line.status,
        lineTotalIdr: Number(line.lineTotalIdr),
      })),
    };
  });
}

async function assertOrderOfOutlet(
  tx: Tx,
  tenantId: TenantId,
  outletId: OutletId,
  orderId: string,
): Promise<void> {
  const [order] = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.outletId, outletId),
        eq(orders.id, orderId),
      ),
    )
    .limit(1);
  if (!order) throw new HttpError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
}

// ---- Hooks called inside the POS order transactions -----------------------------

/** Locks the order's lines (optionally some items) and their tickets, in id order. */
async function lockLinked(
  tx: Tx,
  tenantId: TenantId,
  orderId: string,
  itemIds: readonly string[] | null,
): Promise<{ line: LineRow; ticket: TicketRow }[]> {
  if (itemIds !== null && itemIds.length === 0) return [];
  const lines = await tx
    .select()
    .from(facilityTicketPosLines)
    .where(
      and(
        eq(facilityTicketPosLines.tenantId, tenantId),
        eq(facilityTicketPosLines.orderId, orderId),
        ...(itemIds === null
          ? []
          : [inArray(facilityTicketPosLines.orderItemId, [...itemIds])]),
      ),
    )
    .orderBy(asc(facilityTicketPosLines.accessTicketId))
    .for("update");
  const linked: { line: LineRow; ticket: TicketRow }[] = [];
  for (const line of lines) {
    const [ticket] = await tx
      .select()
      .from(accessTickets)
      .where(
        and(
          eq(accessTickets.tenantId, tenantId),
          eq(accessTickets.id, line.accessTicketId),
        ),
      )
      .limit(1)
      .for("update");
    if (!ticket) throw new Error("A POS ticket line lost its ticket");
    linked.push({ line, ticket });
  }
  return linked;
}

/**
 * Before the bill takes money (a tender starts, a card sale is sent to the
 * terminal) and before completePosOrder takes the sale: every pending ticket of
 * the bill must still hold its slot. The ticket rows are locked, so the hold
 * sweeper cannot cancel one while a tender is being started. A lapsed hold
 * (cancelled by the sweeper) is 409 TICKET_HOLD_LAPSED and no money is taken.
 */
export async function assertPosTicketsIssuable(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
): Promise<void> {
  const linked = await lockLinked(tx, context.tenant.tenantId, orderId, null);
  for (const { line, ticket } of linked)
    if (line.status === "pending" && ticket.status !== "pending_payment")
      throw new HttpError(
        409,
        "TICKET_HOLD_LAPSED",
        "Penahanan slot tiket sudah berakhir; buat penjualan tiket baru.",
      );
}

/**
 * Same check for a card sale about to be sent to the terminal: the bill is
 * found by its order number (the sale's reference) in the outlet. No bill, or a
 * bill without tickets, passes. Called first in the write-ahead transaction,
 * before its advisory lock, so ticket rows are always locked before it (the
 * order addPosTender uses: order, tickets, advisory).
 */
export async function assertPosTicketsIssuableForReference(
  tx: Tx,
  context: ScopedTenantContext,
  input: { outletId: OutletId; reference: string },
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const [order] = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.outletId, input.outletId),
        eq(orders.number, input.reference),
      ),
    )
    .limit(1);
  if (order) await assertPosTicketsIssuable(tx, context, order.id);
}

/** After the bill is completed: pending tickets become `issued`, once. */
export async function issuePosTicketsForPaidOrder(
  tx: Tx,
  context: ScopedTenantContext,
  input: { orderId: string; now: Date; actorUserId: UserId },
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const linked = await lockLinked(tx, tenantId, input.orderId, null);
  for (const { line, ticket } of linked) {
    if (line.status !== "pending") continue;
    const status = transitionTicket(ticket.status, "mark_paid");
    await tx
      .update(accessTickets)
      .set({ status, holdExpiresAt: null, updatedAt: input.now })
      .where(
        and(
          eq(accessTickets.tenantId, tenantId),
          eq(accessTickets.id, ticket.id),
        ),
      );
    await tx
      .update(facilityTicketPosLines)
      .set({ status: "issued", issuedAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(facilityTicketPosLines.tenantId, tenantId),
          eq(facilityTicketPosLines.id, line.id),
          eq(facilityTicketPosLines.status, "pending"),
        ),
      );
    await auditFacility(tx, context, input.actorUserId, input.now, {
      action: "access_ticket.pos_issued",
      objectType: "access_ticket",
      objectId: ticket.id,
      outletId: ticket.outletId,
      before: { ticketId: ticket.id, status: ticket.status },
      after: { ticketId: ticket.id, status },
    });
  }
}

/**
 * Void before payment: the pending tickets of the voided lines (`itemIds`) are
 * cancelled and their slots freed. A line with an issued ticket is not touched
 * here (a paid bill is corrected by the correction void / refund).
 */
export async function releasePosTicketsOfVoidedLines(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    orderId: string;
    itemIds: readonly string[] | null;
    now: Date;
    actorUserId: UserId;
  },
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const linked = await lockLinked(tx, tenantId, input.orderId, input.itemIds);
  for (const { line, ticket } of linked) {
    if (line.status !== "pending") continue;
    // A lapsed hold is already cancelled by the sweeper; only the link moves.
    if (ticket.status === "pending_payment") {
      const status = transitionTicket(ticket.status, "cancel");
      await tx
        .update(accessTickets)
        .set({ status, holdExpiresAt: null, updatedAt: input.now })
        .where(
          and(
            eq(accessTickets.tenantId, tenantId),
            eq(accessTickets.id, ticket.id),
          ),
        );
      await auditFacility(tx, context, input.actorUserId, input.now, {
        action: "access_ticket.pos_hold_released",
        objectType: "access_ticket",
        objectId: ticket.id,
        outletId: ticket.outletId,
        before: { ticketId: ticket.id, status: ticket.status },
        after: { ticketId: ticket.id, status },
      });
      await notifyNextInQueue(
        tx,
        context.tenant.tenantId,
        ticket.facilityId,
        ticket.areaId,
        input.now,
      );
    }
    await tx
      .update(facilityTicketPosLines)
      .set({
        status: "cancelled",
        cancelledAt: input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(facilityTicketPosLines.tenantId, tenantId),
          eq(facilityTicketPosLines.id, line.id),
          eq(facilityTicketPosLines.status, "pending"),
        ),
      );
  }
}

/**
 * Correction void / refund of a paid bill: the issued tickets of the returned
 * lines (`itemIds`, null = the whole bill) become `refunded`, the slot is
 * released and the credential revoked. Throws before any money moves (the
 * caller's transaction rolls back) when a ticket was already used.
 * `moneyRefund` + no item on a bill with an issued ticket is refused.
 */
export async function refundPosTicketsOfRefundedLines(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    orderId: string;
    itemIds: readonly string[] | null;
    moneyRefund: boolean;
    now: Date;
    actorUserId: UserId;
  },
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  if (input.itemIds !== null && input.itemIds.length === 0) {
    if (!input.moneyRefund) return;
    const all = await lockLinked(tx, tenantId, input.orderId, null);
    if (all.some(({ line }) => line.status === "issued"))
      throw new HttpError(
        422,
        "TICKET_REFUND_NEEDS_ITEM",
        "Refund tiket harus memilih item tiketnya.",
      );
    return;
  }
  const linked = await lockLinked(tx, tenantId, input.orderId, input.itemIds);
  for (const { line, ticket } of linked) {
    if (line.status !== "issued") continue;
    if (
      ticket.status === "in_use" ||
      ticket.status === "completed" ||
      ticket.status === "no_show"
    )
      throw new HttpError(
        409,
        "TICKET_ALREADY_USED",
        "Tiket ini sudah dipakai; tidak bisa direfund.",
      );
    const status = transitionTicket(ticket.status, "refund");
    await tx
      .update(accessTickets)
      .set({ status, updatedAt: input.now })
      .where(
        and(
          eq(accessTickets.tenantId, tenantId),
          eq(accessTickets.id, ticket.id),
        ),
      );
    await tx
      .update(accessTicketCredentials)
      .set({ revokedAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(accessTicketCredentials.tenantId, tenantId),
          eq(accessTicketCredentials.accessTicketId, ticket.id),
        ),
      );
    await tx
      .update(facilityTicketPosLines)
      .set({ status: "refunded", refundedAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(facilityTicketPosLines.tenantId, tenantId),
          eq(facilityTicketPosLines.id, line.id),
          eq(facilityTicketPosLines.status, "issued"),
        ),
      );
    await auditFacility(tx, context, input.actorUserId, input.now, {
      action: "access_ticket.pos_refunded",
      objectType: "access_ticket",
      objectId: ticket.id,
      outletId: ticket.outletId,
      before: { ticketId: ticket.id, status: ticket.status },
      after: { ticketId: ticket.id, status },
    });
    await notifyNextInQueue(
      tx,
      tenantId,
      ticket.facilityId,
      ticket.areaId,
      input.now,
    );
  }
}

// ---- Credential and print -------------------------------------------------------

/** A fresh opaque door token (the lock never parses it). */
function mintQrToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Uniform 6-digit PIN. */
function mintPin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * POST /api/pos/orders/:orderId/tickets/:ticketId/credential. Mints (or
 * rotates) the QR token and PIN of a paid ticket, prints it when on the edge,
 * and returns the plaintext once. The caller (route) checked the permission on
 * `outletId`, the order's outlet.
 */
export async function issuePosTicketCredential(
  context: ScopedTenantContext,
  caller: PosCaller,
  input: {
    outletId: OutletId;
    orderId: string;
    ticketId: string;
    idempotencyKey: string;
  },
  now = new Date(),
): Promise<{
  credential: {
    ticketId: string;
    facilityId: string;
    areaId: string;
    unitId: string;
    qrToken: string;
    pin: string;
    validFrom: string;
    validUntil: string;
  };
  print: PosTicketPrint;
}> {
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    await assertOrderOfOutlet(tx, tenantId, input.outletId, input.orderId);
    const [link] = await tx
      .select()
      .from(facilityTicketPosLines)
      .where(
        and(
          eq(facilityTicketPosLines.tenantId, tenantId),
          eq(facilityTicketPosLines.orderId, input.orderId),
          eq(facilityTicketPosLines.accessTicketId, input.ticketId),
        ),
      )
      .limit(1)
      .for("update");
    if (!link) throw new HttpError(404, "NOT_FOUND", "Tiket tidak ditemukan.");
    const [row] = await tx
      .select()
      .from(accessTickets)
      .where(
        and(
          eq(accessTickets.tenantId, tenantId),
          eq(accessTickets.id, link.accessTicketId),
        ),
      )
      .limit(1)
      .for("update");
    if (!row) throw new HttpError(404, "NOT_FOUND", "Tiket tidak ditemukan.");
    if (row.status === "pending_payment")
      throw new HttpError(
        409,
        "TICKET_NOT_PAID",
        "Tiket belum dibayar; selesaikan pembayaran dulu.",
      );
    if (row.status !== "issued")
      throw new FacilityError("TICKET_TRANSITION_INVALID");

    const [existing] = await tx
      .select()
      .from(accessTicketCredentials)
      .where(
        and(
          eq(accessTicketCredentials.tenantId, tenantId),
          eq(accessTicketCredentials.accessTicketId, row.id),
        ),
      )
      .limit(1)
      .for("update");
    if (existing && existing.mintedKey === input.idempotencyKey)
      throw new HttpError(
        409,
        "TICKET_CREDENTIAL_SHOWN",
        "Kredensial tiket sudah ditampilkan; cetak ulang dengan kunci baru.",
      );

    const ticket = toTicket(row);
    const window = ticketCredentialWindow(ticket);
    const qrToken = mintQrToken();
    const pin = mintPin();
    const values = {
      qrDigest: sha256(qrToken),
      pinDigest: sha256(`${row.id}:${pin}`),
      validFrom: new Date(window.validFrom),
      validUntil: new Date(window.validUntil),
      mintedKey: input.idempotencyKey,
      revokedAt: null,
      updatedAt: now,
    };
    if (existing)
      await tx
        .update(accessTicketCredentials)
        .set({ ...values, version: existing.version + 1 })
        .where(
          and(
            eq(accessTicketCredentials.tenantId, tenantId),
            eq(accessTicketCredentials.id, existing.id),
          ),
        );
    else
      await tx.insert(accessTicketCredentials).values({
        tenantId,
        outletId: row.outletId,
        accessTicketId: row.id,
        version: 1,
        createdAt: now,
        ...values,
      });

    const [detail] = await tx
      .select({
        facilityName: facilities.name,
        areaName: facilityAreas.name,
        unitCode: facilityUnits.code,
        customerName: customerProfiles.name,
      })
      .from(facilities)
      .innerJoin(
        facilityAreas,
        and(
          eq(facilityAreas.tenantId, facilities.tenantId),
          eq(facilityAreas.id, row.areaId),
        ),
      )
      .innerJoin(
        facilityUnits,
        and(
          eq(facilityUnits.tenantId, facilities.tenantId),
          eq(facilityUnits.id, row.unitId),
        ),
      )
      .innerJoin(
        customerProfiles,
        and(
          eq(customerProfiles.tenantId, facilities.tenantId),
          eq(customerProfiles.id, row.customerProfileId),
        ),
      )
      .where(
        and(
          eq(facilities.tenantId, tenantId),
          eq(facilities.id, row.facilityId),
        ),
      )
      .limit(1);
    const printed = await enqueueTicketOnEdge(
      tx,
      context,
      {
        ticketId: row.id,
        outletId: row.outletId,
        facilityName: detail?.facilityName ?? "",
        areaName: detail?.areaName ?? "",
        unitCode: detail?.unitCode ?? null,
        customerName: detail?.customerName ?? "",
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        validFrom: values.validFrom,
        validUntil: values.validUntil,
        qrToken,
        pin,
      },
      {
        requestedBy: caller.userId,
        idempotencyKey: input.idempotencyKey,
        reprint: existing !== undefined,
        at: now,
      },
    );
    // Never audit the plaintext: only that a credential was minted.
    await auditFacility(tx, context, caller.userId, now, {
      action: "access_ticket.credential_minted",
      objectType: "access_ticket",
      objectId: row.id,
      outletId: row.outletId,
      before: null,
      after: { ticketId: row.id, status: row.status },
    });
    return {
      credential: {
        ticketId: row.id,
        facilityId: row.facilityId,
        areaId: row.areaId,
        unitId: row.unitId,
        qrToken,
        pin,
        validFrom: window.validFrom,
        validUntil: window.validUntil,
      },
      print: {
        printedAt: printed.printedAt?.toISOString() ?? null,
        printerName: printed.printerName,
        reprint: existing !== undefined,
      },
    };
  });
}
