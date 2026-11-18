// One function per ticket-sale call; components use the hooks in ./hooks.ts.
// Catalog, customer search and availability go through the shared contract
// (mock mode serves them from the facility and CRM mocks). The sale, the tickets
// of a bill and the credential run on the POS kasir mock engine in mock mode
// (./mock.ts), which plays the server; elsewhere they call the real endpoints.
import { listCustomers } from "@starter/shared/crm";
import {
  getFacilityConfig,
  listFacilities,
  sellAccessTicketAtPos,
} from "@starter/shared/facility";
import { submitPosOrder } from "@starter/shared/pos";
import {
  issuePosTicketCredential,
  listPosOrderTickets,
} from "@starter/shared/pos/ticket";
import { callEndpoint } from "@/lib/api/endpoint";
import { API_MOCK } from "@/lib/api/mock-flag";
import { fetchAvailability } from "../../facility/api";
import { availableSlots, businessDateInOutletZone } from "../../facility/flow";
import { runPosKasirMock } from "../mock-engine";
import { mockSellTicketAtPos } from "./mock";
import type {
  OrderTicketLine,
  SellTicketInput,
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
  if (API_MOCK)
    return runPosKasirMock((engine) =>
      mockSellTicketAtPos(engine, input, idempotencyKey),
    );
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
  if (API_MOCK)
    return runPosKasirMock((engine) =>
      engine.issueTicketCredential(orderId, ticketId, idempotencyKey),
    );
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
 * The tickets on one bill, as the server lists them. The contract carries ids,
 * the slot and the line total only: names and unit code stay empty, and the
 * price is `lineTotalIdr` (the screen never computes one).
 */
export async function fetchOrderTickets(
  orderId: string,
  signal?: AbortSignal,
): Promise<OrderTicketLine[]> {
  if (API_MOCK)
    return runPosKasirMock((engine) => engine.orderTickets(orderId));
  const { data } = await callEndpoint(
    listPosOrderTickets,
    { params: { orderId } },
    { signal },
  );
  return data.tickets.map((line) => ({
    ticketId: line.ticket.id,
    orderId,
    lineStatus: line.lineStatus,
    productName: line.display.productName,
    customerName: line.display.customerName,
    facilityName: line.display.facilityName,
    areaName: line.display.areaName,
    unitCode: line.display.unitCode,
    startsAt: line.ticket.slot.startsAt,
    endsAt: line.ticket.slot.endsAt,
    priceIdr: line.lineTotalIdr,
  }));
}
