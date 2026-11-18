// The only data door for the ticket-sale screens: components import hooks from
// here and never call ./api.ts, useQuery or mock data.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { ApiError } from "@/lib/api/errors";
import { API_MOCK } from "@/lib/api/mock-flag";
import { newIdempotencyKey } from "@/lib/idempotency";
import { useTenantContext } from "@/lib/tenant-context";
import { issueTicketCredential, sellTicketAtPos } from "./api";
import { TICKET_SALE_CONNECTED } from "./connected";
import {
  orderTicketsQuery,
  ticketCustomersQuery,
  ticketKeys,
  ticketProductsQuery,
  ticketSlotsQuery,
} from "./queries";
import type {
  SellTicketInput,
  TicketBillSale,
  TicketCredential,
} from "./types";

/** Smallest search text sent to the server (one letter matches half the base). */
export const CUSTOMER_SEARCH_MIN_CHARS = 2;

/** The outlet this screen works in; "" when none (queries stay idle). */
function useOutletId(): string {
  return useTenantContext().outlet?.id ?? "";
}

/** Mock mode needs no outlet; real calls do. */
export function useTicketReady(): boolean {
  return useReady();
}

function useReady(): boolean {
  const outletId = useOutletId();
  return API_MOCK || outletId !== "";
}

/**
 * One idempotency key per intent: the same input keeps the same key until the
 * call succeeds (`clear`), so a retry after a timeout is recognised by the
 * server; a changed input is a new intent and a new key.
 */
function useIntentKey(prefix: string) {
  const current = useRef<{ fingerprint: string; key: string } | null>(null);
  return {
    keyFor(input: unknown): string {
      const fingerprint = JSON.stringify(input);
      if (current.current?.fingerprint !== fingerprint)
        current.current = {
          fingerprint,
          key: `${prefix}:${newIdempotencyKey()}`,
        };
      return current.current.key;
    },
    clear() {
      current.current = null;
    },
  };
}

/** False only if the sale is ever locked again (it is wired to the real API). */
export function useTicketSaleConnected(): boolean {
  return TICKET_SALE_CONNECTED;
}

export function useTicketProducts() {
  const outletId = useOutletId();
  const ready = useReady();
  return useQuery({ ...ticketProductsQuery(outletId), enabled: ready });
}

/** Search by name; idle until the text is long enough. */
export function useTicketCustomerSearch(text: string) {
  const outletId = useOutletId();
  const ready = useReady();
  const query = text.trim();
  return useQuery({
    ...ticketCustomersQuery(outletId, query),
    enabled: ready && query.length >= CUSTOMER_SEARCH_MIN_CHARS,
  });
}

/** Free start times of one area today; idle until a product and area are chosen. */
export function useTicketSlots(facilityId: string, areaId: string) {
  const outletId = useOutletId();
  const ready = useReady();
  return useQuery({
    ...ticketSlotsQuery(outletId, facilityId, areaId),
    enabled: ready && facilityId !== "" && areaId !== "",
  });
}

/**
 * Sells the ticket and opens its bill; the cashier pays it on the payment
 * screen. The client sends no price: the bill total is the server's.
 */
export function useSellTicketAtPos() {
  const outletId = useOutletId();
  const intent = useIntentKey("ticket-sale");
  return useMutation<TicketBillSale, ApiError, SellTicketInput>({
    mutationFn: async (input) => {
      const sale = await sellTicketAtPos(
        outletId,
        input,
        intent.keyFor({
          productId: input.product.id,
          areaId: input.areaId,
          customerId: input.customer.id,
          timing: input.timing,
        }),
      );
      intent.clear();
      return sale;
    },
  });
}

/** The tickets on one bill; idle until there is an order id. */
export function useOrderTickets(orderId: string) {
  const outletId = useOutletId();
  const ready = useReady();
  return useQuery({
    ...orderTicketsQuery(outletId, orderId),
    enabled: ready && orderId !== "",
  });
}

/**
 * Mints the door credential of a paid ticket and prints it. Every `mutate` is
 * a new intent with a NEW key: the server never shows the same credential
 * twice, and a second call rotates it (the old QR and PIN stop working). The
 * result is for the component's own state: `gcTime: 0` drops it from the
 * mutation cache once unobserved, and it never goes to a query or storage.
 */
export function useIssueTicketCredential() {
  const client = useQueryClient();
  const outletId = useOutletId();
  return useMutation<
    TicketCredential,
    ApiError,
    { orderId: string; ticketId: string }
  >({
    gcTime: 0,
    mutationFn: ({ orderId, ticketId }) =>
      issueTicketCredential(
        orderId,
        ticketId,
        `ticket-credential:${newIdempotencyKey()}`,
      ),
    onSuccess: (_credential, { orderId }) =>
      client.invalidateQueries({
        queryKey: ticketKeys.orderTickets(outletId, orderId),
      }),
  });
}
