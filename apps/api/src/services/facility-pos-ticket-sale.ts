// Facility ticket sale at the POS (936, legend-hpgyw part D). One transaction
// holds the slot (pending_payment, 30 minutes), opens a NEW POS order with one
// line of the product's menu item and links the two (facility-pos-tickets.ts
// owns what happens when the bill is paid, voided or refunded). The price is
// the POS price list's and must equal the product's price, else 422
// TICKET_PRICE_MISMATCH: the guest pays exactly the product's price and the
// outlet is not short. Nothing is usable before the bill is paid.
import { and, eq } from "drizzle-orm";
import {
  assertOutletInScope,
  idr,
  outletIdSchema,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import type { StaffSellTicketInput } from "@starter/shared/facility";
import { createPosOrder as createPosOrderEndpoint } from "@starter/shared/pos";
import type { PosTicketSale } from "@starter/shared/pos/ticket";
import { db } from "../db/index.ts";
import { memberTenantContext } from "../db/member-scope.ts";
import { customerProfiles } from "../db/schema/crm-member.ts";
import { devices } from "../db/schema/device.ts";
import { facilities, facilityProducts } from "../db/schema/facility.ts";
import { facilityTicketPosLines } from "../db/schema/facility-pos-ticket.ts";
import { withTenant } from "../db/tenant.ts";
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import { HttpError } from "../lib/http-error.ts";
import { isTrainingOrder } from "./device-training.ts";
import { auditFacility, loadFacility } from "./facility-shared.ts";
import { holdFacilitySlot } from "./facility-slots.service.ts";
import { createPosOrderInTx } from "./pos-order.service.ts";
import { posIdempotent, type PosCaller } from "./pos-order-support.ts";

/** How long a POS sale keeps its slot while the bill is paid. */
export const POS_TICKET_HOLD_MINUTES = 30;

/** The outlet of a facility, for the route's permission check (null: unknown). */
export async function findFacilityOutletId(
  tenantId: TenantId,
  facilityId: string,
): Promise<string | null> {
  // Trusted tenant-wide read (the tenant comes from the server-minted request
  // context), like findPosOrderOutletId: another tenant's facility is never found.
  return withTenant(db, memberTenantContext(tenantId), async (tx) => {
    const [row] = await tx
      .select({ outletId: facilities.outletId })
      .from(facilities)
      .where(
        and(eq(facilities.tenantId, tenantId), eq(facilities.id, facilityId)),
      )
      .limit(1);
    return row?.outletId ?? null;
  });
}

function unsellable(message: string): HttpError {
  return new HttpError(422, "TICKET_PRODUCT_NOT_SELLABLE_AT_POS", message);
}

/**
 * POST /api/facility/tickets/pos. The caller (route) has already checked
 * `pos.sale.create` on the facility's outlet.
 */
export async function sellPosTicket(
  context: ScopedTenantContext,
  caller: PosCaller,
  input: StaffSellTicketInput,
  now = new Date(),
): Promise<PosTicketSale> {
  // The slot hold and the one-slot-one-ticket guarantee live in the cloud: an
  // edge node cannot prove the unit is free (same rule as refunds).
  if (getEdgeRuntimeState().edgeMode || process.env.EDGE_MODE === "true")
    throw new HttpError(
      409,
      "TICKET_NEEDS_CLOUD",
      "Penjualan tiket fasilitas harus dilakukan melalui server pusat.",
    );
  const { idempotencyKey, ...request } = input;
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const facility = await loadFacility(tx, context, input.facilityId);
    assertOutletInScope(context.outletScope, facility.outletId);
    const outletId = outletIdSchema.parse(facility.outletId);
    return posIdempotent(
      tx,
      context,
      {
        outletId,
        actorId: caller.userId,
        key: idempotencyKey,
        operation: "facility.ticket.sell",
        target: facility.id,
        request,
      },
      async (): Promise<PosTicketSale> => {
        if (input.issuedOffline === true)
          throw new HttpError(
            422,
            "VALIDATION_ERROR",
            "Penjualan tiket di kasir harus online.",
          );
        if ((input.addonIds ?? []).length > 0)
          throw new HttpError(
            422,
            "VALIDATION_ERROR",
            "Add-on belum bisa dijual lewat kasir.",
          );
        const [product] = await tx
          .select()
          .from(facilityProducts)
          .where(
            and(
              eq(facilityProducts.tenantId, tenantId),
              eq(facilityProducts.facilityId, facility.id),
              eq(facilityProducts.id, input.productId),
            ),
          )
          .limit(1);
        if (!product)
          throw new HttpError(404, "NOT_FOUND", "Produk tidak ditemukan.");
        if (!product.isActive)
          throw unsellable("Produk ini sedang tidak dijual.");
        if (product.type !== "single")
          throw unsellable("Hanya tiket sekali masuk yang dijual di kasir.");
        if (product.menuItemId === null)
          throw unsellable(
            "Produk ini belum terhubung ke menu kasir; hubungkan dulu.",
          );
        const [customer] = await tx
          .select({
            status: customerProfiles.membershipStatus,
            merged: customerProfiles.mergedIntoProfileId,
          })
          .from(customerProfiles)
          .where(
            and(
              eq(customerProfiles.tenantId, tenantId),
              eq(customerProfiles.id, input.customerProfileId),
            ),
          )
          .limit(1);
        if (
          !customer ||
          customer.merged !== null ||
          customer.status === "closed"
        )
          throw new HttpError(404, "NOT_FOUND", "Pelanggan tidak ditemukan.");

        // Training device: a practice sale must not hold a real slot or open a
        // real bill. Refused before the hold, so nothing is written. The device
        // row is locked FOR SHARE until the sale commits: a mode change
        // (device.service.ts setDeviceTrainingMode takes FOR UPDATE) waits for
        // the sale, so the mode read here is the mode the order is stamped
        // with. The sale never upgrades this lock, so two sales do not deadlock.
        if (caller.deviceId) {
          const [device] = await tx
            .select({ trainingMode: devices.trainingMode })
            .from(devices)
            .where(
              and(
                eq(devices.tenantId, tenantId),
                eq(devices.outletId, outletId),
                eq(devices.id, caller.deviceId),
              ),
            )
            .limit(1)
            .for("share");
          // A device that is missing or belongs to another outlet is refused
          // with the same answer as a practice device: a cashier session must
          // not use a device outside the ticket's outlet, and the answer does
          // not say which case it was.
          if (!device || device.trainingMode === true)
            throw new HttpError(
              409,
              "TICKET_TRAINING_REFUSED",
              "Perangkat latihan tidak bisa menjual tiket fasilitas.",
            );
        }

        const held = await holdFacilitySlot(
          tx,
          context,
          {
            facilityId: input.facilityId,
            areaId: input.areaId,
            unitId: input.unitId,
            timing: input.timing,
            productId: input.productId,
            customerProfileId: input.customerProfileId,
            source: "purchase",
            issuedOffline: false,
            idempotencyKey,
            actorUserId: caller.userId,
            holdMinutes: POS_TICKET_HOLD_MINUTES,
          },
          now,
        );
        const order = await createPosOrderInTx(
          tx,
          context,
          caller,
          outletId,
          createPosOrderEndpoint.body.parse({
            channel: "pos",
            serviceType: "takeaway",
            customerProfileId: input.customerProfileId,
            items: [
              { menuItemId: product.menuItemId, quantity: 1, modifierIds: [] },
            ],
            idempotencyKey,
          }),
          now,
        );
        // Belt and braces: never leave a practice order with a real ticket.
        if (await isTrainingOrder(tx, tenantId, order.id))
          throw new HttpError(
            409,
            "TICKET_TRAINING_REFUSED",
            "Perangkat latihan tidak bisa menjual tiket fasilitas.",
          );
        const [line] = order.items;
        if (!line || order.items.length !== 1)
          throw new Error("A ticket sale opens a bill with exactly one line");
        // Money rule: refuse a POS price that differs from the product's
        // price (nothing is written: the transaction rolls back).
        if (
          line.quantity !== 1 ||
          Number(line.unitPriceIdr) !== Number(product.priceIdr) ||
          Number(line.modifiersTotalIdr) !== 0
        )
          throw new HttpError(
            422,
            "TICKET_PRICE_MISMATCH",
            "Harga di menu kasir berbeda dari harga tiket; hubungi admin.",
          );
        await tx.insert(facilityTicketPosLines).values({
          tenantId,
          outletId,
          facilityId: facility.id,
          accessTicketId: held.ticket.id,
          orderId: order.id,
          orderItemId: line.id,
          status: "pending",
          lineTotalIdr: idr(Number(line.lineTotalIdr)),
          createdAt: now,
          updatedAt: now,
        });
        await auditFacility(tx, context, caller.userId, now, {
          action: "access_ticket.pos_sold",
          objectType: "access_ticket",
          objectId: held.ticket.id,
          outletId,
          before: null,
          after: {
            ticketId: held.ticket.id,
            facilityId: facility.id,
            status: held.ticket.status,
          },
        });
        return { ticket: held.ticket, order };
      },
    );
  });
}
