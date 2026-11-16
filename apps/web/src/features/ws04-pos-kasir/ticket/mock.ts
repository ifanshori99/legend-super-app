// Mock mode for the two calls that have no mock handler yet: the POS ticket
// sale and the ticket print. It plays the server's part: the price is the
// product's price, a retried key returns the ticket it already issued (never a
// second one), and a unit is never sold twice for overlapping time. Products
// and customers come from the shared facility and CRM mocks (./api.ts).
import {
  accessTicketSchema,
  cafeLegendFacilityFixtures as fx,
  slotFromStart,
  ticketCredentialWindow,
} from "@starter/shared/facility";
import { createUlidFactory } from "@starter/shared/core";
import { ApiError } from "@/lib/api/errors";
import { createMockStore } from "@/lib/mock/store";
import type { PrintTicketResult, SellTicketInput, SoldTicket } from "./types";

const MINUTE_MS = 60_000;
const nextUlid = createUlidFactory();

type SaleRecord = {
  ticket: SoldTicket;
  unitId: string;
  startMs: number;
  cleaningEndMs: number;
};

const sales = createMockStore(() => new Map<string, SaleRecord>());
const replies = createMockStore(() => new Map<string, string>());
const prints = createMockStore(() => new Map<string, number>());

/** Opaque door token, like the real credential (the lock never parses it). */
function qrToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Uniform 6-digit PIN (rejection sampling, no modulo bias). */
function doorPin(): string {
  const limit = 4_294_000_000; // largest multiple of 10^6 below 2^32
  for (;;) {
    const [value] = crypto.getRandomValues(new Uint32Array(1));
    if (value < limit) return String(value % 1_000_000).padStart(6, "0");
  }
}

export function mockSellTicket(
  input: SellTicketInput,
  idempotencyKey: string,
): SoldTicket {
  const replay = replies.get().get(idempotencyKey);
  const replayed = replay ? sales.get().get(replay) : undefined;
  if (replayed) return replayed.ticket;

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

  const taken = [...sales.get().values()];
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

  const ticket = accessTicketSchema.parse({
    id: nextUlid(),
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
    status: "issued",
    issuedOffline: false,
    firstOpenedAt: null,
    endedAt: null,
    overtimeMinutes: 0,
    overtimeFeeIdr: 0,
    createdAt: new Date().toISOString(),
  });
  const window = ticketCredentialWindow(ticket);
  const sold: SoldTicket = {
    ticketId: ticket.id,
    productName: product.name,
    priceIdr: product.priceIdr,
    customerName: input.customer.name,
    facilityName: facility.name,
    areaName: area.name,
    unitCode: unit.code,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    validFrom: window.validFrom,
    validUntil: window.validUntil,
    qrToken: qrToken(),
    pin: doorPin(),
  };
  sales
    .get()
    .set(ticket.id, { ticket: sold, unitId: unit.id, startMs, cleaningEndMs });
  replies.get().set(idempotencyKey, ticket.id);
  return sold;
}

export function mockPrintTicket(ticketId: string): PrintTicketResult {
  if (!sales.get().has(ticketId))
    throw new ApiError(404, "NOT_FOUND", "Tiket tidak ditemukan.");
  const count = (prints.get().get(ticketId) ?? 0) + 1;
  prints.get().set(ticketId, count);
  return {
    printedAt: new Date().toISOString(),
    printerName: "Printer kasir",
    reprint: count > 1,
  };
}
