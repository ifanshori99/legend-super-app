// Ticket part of the POS kasir mock engine (brief 1046). The engine plays the
// server: a sale opens an ordinary mock bill with one ticket line, the ticket is
// `issued` when that bill is paid, and every credential call mints a new QR+PIN
// and refuses a replayed key. Plain TypeScript with relative imports only: the
// engine is loaded directly by Node tests.
import type { EngineOrder } from "../types.ts";

/** One ticket on a mock bill, as the engine stores it (JSON, survives reload). */
export type EngineTicketLine = {
  ticketId: string;
  orderId: string;
  productName: string;
  customerName: string;
  facilityName: string;
  areaName: string;
  unitCode: string | null;
  startsAt: string;
  endsAt: string;
  validFrom: string;
  validUntil: string;
  /** The server's price: the bill total is this figure, nothing is computed. */
  priceIdr: number;
  /** Slot occupancy, so a unit is never sold twice for overlapping time. */
  unitId: string;
  startMs: number;
  cleaningEndMs: number;
  cancelled: boolean;
  /** How many credentials were minted: the print is a reprint after the first. */
  credentials: number;
  /** Keys already answered; a replay is refused, never shown again. */
  usedKeys: string[];
};

/** What a sale needs from the catalog; the engine adds ids and the bill. */
export type TicketLineSeed = Omit<
  EngineTicketLine,
  "ticketId" | "orderId" | "cancelled" | "credentials" | "usedKeys"
>;

export type EngineTicketState = {
  lines: Record<string, EngineTicketLine>;
  /** Idempotency key of a sale -> ticket id it created. */
  sales: Record<string, string>;
  seq: number;
};

export const emptyTicketState = (): EngineTicketState => ({
  lines: {},
  sales: {},
  seq: 0,
});

/**
 * Crockford ULIDs (the typed endpoints validate their path with the schema).
 * The counter starts at 1000: the fixed demo ids (demo-seed.ts) end in 1.
 */
export const ticketOrderUlid = (seq: number) =>
  `01JBQ9T${String(1000 + seq).padStart(19, "0")}`;
export const ticketUlid = (seq: number) =>
  `01JBQ9K${String(1000 + seq).padStart(19, "0")}`;

export const TICKET_PRINTER_NAME = "Printer kasir";

/** The bill a ticket sale opens: one line, the product's server price. */
export function ticketOrderOf(
  orderId: string,
  orderNo: string,
  line: Pick<
    EngineTicketLine,
    "productName" | "facilityName" | "areaName" | "priceIdr"
  >,
): EngineOrder {
  return {
    id: orderId,
    orderNo,
    tableLabel: `${line.facilityName} · ${line.areaName}`,
    guestCount: 1,
    items: [{ name: line.productName, qty: 1, amountIdr: line.priceIdr }],
    subtotalIdr: line.priceIdr,
    serviceIdr: 0,
    taxIdr: 0,
    totalIdr: line.priceIdr,
    deposit: null,
    tenders: [],
    attempts: [],
    checkOutcome: "confirm",
    receiptNo: null,
    receiptPrints: 0,
    version: 0,
    code: null,
  };
}

/** The demo ticket (`?demo=tiket-menunggu|tiket-lunas`): Kolam Renang, Rp87.500. */
export function demoTicketSeed(nowMs: number): TicketLineSeed {
  const startMs = nowMs + 60_000;
  const endMs = startMs + 120 * 60_000;
  const cleaningEndMs = endMs + 15 * 60_000;
  return {
    productName: "Tiket Kolam Dewasa",
    customerName: "Sari Wulandari",
    facilityName: "Kolam Renang",
    areaName: "Kolam Utama",
    unitCode: "KU-03",
    startsAt: new Date(startMs).toISOString(),
    endsAt: new Date(endMs).toISOString(),
    validFrom: new Date(startMs - 10 * 60_000).toISOString(),
    validUntil: new Date(endMs).toISOString(),
    priceIdr: 87_500,
    unitId: "demo-unit-ku-03",
    startMs,
    cleaningEndMs,
  };
}

/** Opaque door token, like the real credential (the lock never parses it). */
export function mintQrToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Uniform 6-digit PIN (rejection sampling, no modulo bias). */
export function mintDoorPin(): string {
  const limit = 4_294_000_000; // largest multiple of 10^6 below 2^32
  for (;;) {
    const [value] = crypto.getRandomValues(new Uint32Array(1));
    if (value < limit) return String(value % 1_000_000).padStart(6, "0");
  }
}
