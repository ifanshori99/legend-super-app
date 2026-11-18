// One function per ticket-sale call; components use the hooks in ./hooks.ts.
// Catalog, customer search and availability go through the shared contract
// (mock mode serves them from the facility and CRM mocks). The sale and the
// print have no mock handler: they run on ./mock.ts in mock mode, and the print
// fails with CONTRACT_PENDING elsewhere (see ../CONTRACT-GAPS.md).
import { listCustomers } from "@starter/shared/crm";
import { getFacilityConfig, listFacilities } from "@starter/shared/facility";
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
  TicketCustomer,
  TicketProduct,
  TicketSlot,
} from "./types";

/** Facilities of the outlet; one page is plenty for an outlet's facilities. */
const FACILITY_PAGE = 100;
const CUSTOMER_PAGE = 10;

/**
 * Active single-ticket products of every facility. A plan (subscription) is
 * sold elsewhere, and a product that carries a menu package ("Paket Sarapan +
 * Shower") would be sold without its food, so neither is offered here.
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
          product.menuItemId === null,
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

/** Why the sale is locked outside mock mode (shown in the error message). */
const SALE_PENDING_FEATURE =
  "Jual tiket fasilitas dari POS: pembayaran belum ada kontrak";

export async function sellTicket(
  input: SellTicketInput,
  idempotencyKey: string,
): Promise<SoldTicket> {
  if (API_MOCK)
    return runPosKasirMock(() => mockSellTicket(input, idempotencyKey));
  // Money rule: the sale endpoint takes no payment, so a real ticket would be
  // issued without money received. Locked until the contract has a tender.
  throw contractPending(SALE_PENDING_FEATURE);
}

/**
 * Prints the ticket through the Print Agent on the edge node (same route as
 * the receipt). No endpoint exists yet: DEMO-CONTRACT, see CONTRACT-GAPS.md.
 */
export async function printTicket(
  ticketId: string,
): Promise<PrintTicketResult> {
  if (!API_MOCK) throw contractPending("cetak tiket fasilitas");
  return runPosKasirMock(() => mockPrintTicket(ticketId));
}
