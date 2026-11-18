// Mock mode for the POS ticket sale. It plays the server's part: the price is
// the product's price, a retried key returns the sale it already made (never a
// second one), and a unit is never sold twice for overlapping time. The bill
// and the ticket live in the POS kasir mock engine (so a reload keeps them and
// the bill is paid on /pos/bayar/$orderId); this file only checks the product
// against the shared facility mock and hands the engine a line to sell.
// Products and customers come from the shared facility and CRM mocks (./api.ts).
import {
  accessTicketSchema,
  cafeLegendFacilityFixtures as fx,
  slotFromStart,
  ticketCredentialWindow,
} from "@starter/shared/facility";
import { ApiError } from "@/lib/api/errors";
import type { PosKasirEngine } from "../mock-engine";
import type { SellTicketInput, TicketBillSale } from "./types";

const MINUTE_MS = 60_000;

export function mockSellTicketAtPos(
  engine: PosKasirEngine,
  input: SellTicketInput,
  idempotencyKey: string,
): TicketBillSale {
  const replay = engine.ticketSaleOf(idempotencyKey);
  if (replay) return replay;

  const product = fx.products.find((item) => item.id === input.product.id);
  if (!product)
    throw new ApiError(404, "NOT_FOUND", "Produk fasilitas tidak ditemukan.");
  if (!product.isActive)
    throw new ApiError(
      409,
      "CONFLICT",
      "Produk ini sedang tidak dijual. Pilih produk lain.",
    );
  const facility = fx.facilities.find((item) => item.id === product.facilityId);
  const area = fx.areas.find(
    (item) =>
      item.id === input.areaId && item.facilityId === product.facilityId,
  );
  if (!facility || !area)
    throw new ApiError(404, "NOT_FOUND", "Area fasilitas tidak ditemukan.");

  const startsAt =
    input.timing.kind === "slot"
      ? input.timing.startsAt
      : new Date(Date.now() + MINUTE_MS).toISOString();
  const slot = slotFromStart(startsAt, {
    sessionMinutes: facility.sessionMinutes,
    cleaningMinutes: facility.cleaningMinutes,
  });
  const startMs = Date.parse(slot.startsAt);
  const cleaningEndMs = Date.parse(slot.cleaningEndsAt);

  const taken = engine.ticketsBusy();
  const unit = fx.units.find(
    (candidate) =>
      candidate.areaId === area.id &&
      candidate.status !== "maintenance" &&
      !taken.some(
        (sale) =>
          sale.unitId === candidate.id &&
          sale.startMs < cleaningEndMs &&
          startMs < sale.cleaningEndMs,
      ),
  );
  if (!unit)
    throw new ApiError(
      409,
      "SLOT_UNAVAILABLE",
      "Belum ada bilik kosong untuk waktu ini. Pilih waktu lain.",
    );

  // Only to read the credential window the real ticket would carry.
  const window = ticketCredentialWindow(
    accessTicketSchema.parse({
      id: "01JBQ9K0000000000000000000",
      tenantId: fx.tenant.id,
      outletId: fx.outlet.id,
      facilityId: facility.id,
      areaId: area.id,
      unitId: unit.id,
      customerProfileId: input.customer.id,
      productId: product.id,
      source: "purchase",
      entitlementLedgerId: null,
      slot,
      graceMinutes: facility.arrivalGraceMinutes,
      addons: [],
      status: "pending_payment",
      issuedOffline: false,
      firstOpenedAt: null,
      endedAt: null,
      overtimeMinutes: 0,
      overtimeFeeIdr: 0,
      createdAt: new Date().toISOString(),
    }),
  );
  return engine.sellTicket(
    {
      productName: product.name,
      customerName: input.customer.name,
      facilityName: facility.name,
      areaName: area.name,
      unitCode: unit.code,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      validFrom: window.validFrom,
      validUntil: window.validUntil,
      priceIdr: product.priceIdr,
      unitId: unit.id,
      startMs,
      cleaningEndMs,
    },
    idempotencyKey,
  );
}
