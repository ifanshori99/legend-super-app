// One function per ticket-sale call; components use the hooks in ./hooks.ts.
// Catalog, customer search and availability go through the shared contract
// (mock mode serves them from the facility and CRM mocks). The sale and the
// print have no mock handler: they run on ./mock.ts in mock mode, and the print
// fails with CONTRACT_PENDING elsewhere (see ../CONTRACT-GAPS.md).
import { listCustomers } from "@starter/shared/crm";
import {
  getFacilityConfig,
  listFacilities,
  sellAccessTicketAtPos,
} from "@starter/shared/facility";
import { submitPosOrder } from "@starter/shared/pos";
import { issuePosTicketCredential } from "@starter/shared/pos/ticket";
import { callEndpoint } from "@/lib/api/endpoint";
import { API_MOCK } from "@/lib/api/mock-flag";
import { fetchAvailability } from "../../facility/api";
import { availableSlots, businessDateInOutletZone } from "../../facility/flow";
import { contractPending } from "../api";
import { runPosKasirMock } from "../mock-engine";
import { mockPrintTicket, mockSellTicket } from "./mock";
import type {
  PrintTicketResult,
  SellTicketInput,
  SoldTicket,
  TicketBillSale,
  TicketCredential,
  TicketCustomer,
  TicketProduct,
  TicketSlot,
} from "./types";

/** Facilities of the outlet; one page is plenty for an outlet's facilities. */
const FACILITY_PAGE = 100;
const CUSTOMER_PAGE = 10;

/**
 * Active single-ticket products of every facility. A plan (subscription) is
 * sold elsewhere. Outside mock mode a ticket is an ordinary bill line (936 D1),
 * so only a product with a POS menu item can be sold; the mock catalog has none
 * and keeps its products without one.
 */
export async function fetchTicketProducts(
  signal?: AbortSignal,
): Promise<TicketProduct[]> {
  const facilities = await callEndpoint(
    listFacilities,
    { query: { limit: FACILITY_PAGE } },
    { signal },
  );
  const configs = await Promise.all(
    facilities.data.map((facility) =>
      callEndpoint(
        getFacilityConfig,
        { query: { facilityId: facility.id } },
        { signal },
      ),
    ),
  );
  return configs.flatMap(({ data }) =>
    data.products
      .filter(
        (product) =>
          product.isActive &&
          product.type === "single" &&
          (API_MOCK
            ? product.menuItemId === null
            : product.menuItemId !== null),
      )
      .map((product) => ({
        id: product.id,
        facilityId: data.facility.id,
        facilityName: data.facility.name,
        name: product.name,
        priceIdr: product.priceIdr,
        sessions: product.sessions,
        areas: data.areas.map((area) => ({ id: area.id, name: area.name })),
        units: data.units.map((unit) => ({
          id: unit.id,
          areaId: unit.areaId,
          code: unit.code,
        })),
      })),
  );
}

export async function searchTicketCustomers(
  query: string,
  signal?: AbortSignal,
): Promise<TicketCustomer[]> {
  const page = await callEndpoint(
    listCustomers,
    { query: { q: query, limit: CUSTOMER_PAGE } },
    { signal },
  );
  return page.data.map((profile) => ({ id: profile.id, name: profile.name }));
}

/** Start times the server marks free today in one area. */
export async function fetchTicketSlots(
  input: { facilityId: string; areaId: string },
  signal?: AbortSignal,
): Promise<TicketSlot[]> {
  const availability = await fetchAvailability(
    {
      facilityId: input.facilityId,
      date: businessDateInOutletZone(new Date()),
      areaId: input.areaId,
    },
    signal,
  );
  return availableSlots(availability, input.areaId).map((slot) => ({
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
  }));
}

/**
 * Why the sale screen stays locked outside mock mode: the real sale opens a
 * bill and the ticket exists only after it is paid, but the screen still shows
 * an issued ticket right after the sale (see ../CONTRACT-GAPS.md).
 */
const SALE_PENDING_FEATURE =
  "Jual tiket fasilitas dari POS: layar belum menunggu pembayaran tagihan";

export async function sellTicket(
  input: SellTicketInput,
  idempotencyKey: string,
): Promise<SoldTicket> {
  if (API_MOCK)
    return runPosKasirMock(() => mockSellTicket(input, idempotencyKey));
  throw contractPending(SALE_PENDING_FEATURE);
}

/**
 * The real sale (936 D): holds the slot and opens a POS bill with one ticket
 * line at the POS price list's price (the client sends no price). The ticket is
 * `pending_payment`. The bill is submitted so it can be paid; the cashier pays
 * it on the payment screen and the ticket is issued when it is paid.
 */
export async function sellTicketAtPos(
  outletId: string,
  input: SellTicketInput,
  idempotencyKey: string,
): Promise<TicketBillSale> {
  const { data } = await callEndpoint(sellAccessTicketAtPos, {
    body: {
      facilityId: input.product.facilityId,
      areaId: input.areaId,
      productId: input.product.id,
      customerProfileId: input.customer.id,
      timing: input.timing,
      idempotencyKey,
    },
  });
  const order =
    data.order.status === "draft"
      ? (
          await callEndpoint(submitPosOrder, {
            params: { outletId, orderId: data.order.id },
            body: {
              expectedStatus: data.order.status,
              idempotencyKey: `${idempotencyKey}:submit`,
            },
          })
        ).data
      : data.order;
  return {
    ticketId: data.ticket.id,
    orderId: order.id,
    orderNo: order.number,
    totalIdr: Number(order.totalIdr),
  };
}

/**
 * Mints the door credential of a PAID ticket and prints it through the Print
 * Agent on the edge node (same route as the receipt). The key must be new for
 * each reprint: the server never shows the same credential twice.
 */
export async function issueTicketCredential(
  orderId: string,
  ticketId: string,
  idempotencyKey: string,
): Promise<TicketCredential> {
  const { data } = await callEndpoint(issuePosTicketCredential, {
    params: { orderId, ticketId },
    body: { idempotencyKey },
  });
  return {
    ticketId: data.credential.ticketId,
    qrToken: data.credential.qrToken,
    pin: data.credential.pin,
    validFrom: data.credential.validFrom,
    validUntil: data.credential.validUntil,
    print: data.print,
  };
}

/**
 * Mock mode only: the real print is part of `issueTicketCredential`, which
 * needs the order and a new key per reprint. Not wired to the screen yet.
 */
export async function printTicket(
  ticketId: string,
): Promise<PrintTicketResult> {
  if (!API_MOCK) throw contractPending("cetak tiket fasilitas");
  return runPosKasirMock(() => mockPrintTicket(ticketId));
}
