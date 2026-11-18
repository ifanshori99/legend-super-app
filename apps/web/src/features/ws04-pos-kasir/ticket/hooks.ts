// The only data door for the ticket-sale screens: components import hooks from
// here and never call ./api.ts, useQuery or mock data. Outside mock mode the
// print fails with CONTRACT_PENDING (`isContractPending` from ../hooks).
import { POS_TICKET_CUSTOMER_QUERY_MIN } from "@starter/shared/pos/ticket-cashier";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { ApiError } from "@/lib/api/errors";
import { API_MOCK } from "@/lib/api/mock-flag";
import { newIdempotencyKey } from "@/lib/idempotency";
import { useTenantContext } from "@/lib/tenant-context";
import { printTicket, sellTicket } from "./api";
import { TICKET_SALE_CONNECTED } from "./connected";
import {
  ticketCustomersQuery,
  ticketProductsQuery,
  ticketSlotsQuery,
} from "./queries";
import type { PrintTicketResult, SellTicketInput, SoldTicket } from "./types";

/**
 * Smallest search text sent to the server (one letter matches half the base).
 * The cashier search refuses fewer characters than its contract minimum.
 */
export const CUSTOMER_SEARCH_MIN_CHARS = API_MOCK
  ? 2
  : POS_TICKET_CUSTOMER_QUERY_MIN;

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

/** False while the sale has no payment contract (the screen locks and says so). */
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

export function useSellTicket() {
  const intent = useIntentKey("ticket-sale");
  return useMutation<SoldTicket, ApiError, SellTicketInput>({
    mutationFn: async (input) => {
      const sold = await sellTicket(
        input,
        intent.keyFor({
          productId: input.product.id,
          areaId: input.areaId,
          customerId: input.customer.id,
          timing: input.timing,
        }),
      );
      intent.clear();
      return sold;
    },
  });
}

export function usePrintTicket() {
  return useMutation<PrintTicketResult, ApiError, { ticketId: string }>({
    mutationFn: (input) => printTicket(input.ticketId),
  });
}
