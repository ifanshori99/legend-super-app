// View-model of the facility ticket sale at the POS (brief 936, bead legend-5w6).
// The screens read these shapes only; ./api.ts maps the facility contract into
// them. Prices are the server's product prices: nothing here is computed.

export type TicketArea = { id: string; name: string };

export type TicketUnit = { id: string; areaId: string; code: string };

/** One sellable facility product, as the server lists it. */
export type TicketProduct = {
  id: string;
  facilityId: string;
  facilityName: string;
  name: string;
  /** Whole rupiah, straight from the product configuration. */
  priceIdr: number;
  sessions: number;
  areas: TicketArea[];
  units: TicketUnit[];
};

export type TicketCustomer = { id: string; name: string };

/** A bookable start time offered by the server (never built by the screen). */
export type TicketSlot = { startsAt: string; endsAt: string };

export type TicketTiming =
  { kind: "now" } | { kind: "slot"; startsAt: string; endsAt: string };

export type SellTicketInput = {
  product: TicketProduct;
  areaId: string;
  customer: TicketCustomer;
  timing: TicketTiming;
};

/**
 * The bill a real ticket sale opens (936 D). The ticket is `pending_payment`:
 * it is issued only when the bill is paid, so there is no door credential yet.
 * Every figure on the bill comes from the server.
 */
export type TicketBillSale = {
  ticketId: string;
  orderId: string;
  orderNo: string;
  totalIdr: number;
};

/** What `issueTicketCredential` returns for a paid ticket: shown once. */
export type TicketCredential = {
  ticketId: string;
  qrToken: string;
  pin: string;
  validFrom: string;
  validUntil: string;
  /** Null when the API runs in the cloud: show the credential on screen. */
  print: {
    printedAt: string | null;
    printerName: string | null;
    reprint: boolean;
  };
};

/** Where a ticket stands against its bill line (the server's word). */
export type TicketLineStatus = "pending" | "issued" | "cancelled" | "refunded";

/**
 * One ticket on a bill, for the cashier screens. `priceIdr` is the line total
 * the server priced; nothing here is computed. What the contract does not carry
 * (names, unit code) is an empty string or null.
 */
export type OrderTicketLine = {
  ticketId: string;
  orderId: string;
  lineStatus: TicketLineStatus;
  productName: string;
  customerName: string;
  facilityName: string;
  areaName: string;
  unitCode: string | null;
  startsAt: string;
  endsAt: string;
  priceIdr: number;
};
