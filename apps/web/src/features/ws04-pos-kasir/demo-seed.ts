// Demo constants and the `?demo=<seed>` switch for the POS kasir mock. Only the
// mock engine reads the seed (VITE_API_MOCK=true); components never do. The ids
// are shared by the mock, the e2e spec and the screenshots (brief legend-mjmm).
//
// Plain TypeScript: Node tests load it directly.

/** Meja A12, POS-0048: Rp248.000 with a Rp100.000 reservation deposit. */
export const DEMO_ORDER_ID = "0b0b0048-0000-4000-8000-000000000048";
/** Code "Bayar di kasir" LG-0044, Meja A01, one iced espresso, Rp26.600. */
export const DEMO_CODE_ORDER_ID = "0b0b0044-0000-4000-8000-000000000044";
/** Kasir 01: float Rp500.000, counted Rp2.230.000 vs system Rp2.250.000. */
export const DEMO_SHIFT_ID = "0c0c0001-0000-4000-8000-000000000001";

/**
 * The shared POS contract keys orders by ULID, so the demo orders also answer
 * to a ULID (the typed endpoints validate their path with the real schema).
 */
export const DEMO_ORDER_ULID = "01JBQ9C0000000000000000048";
export const DEMO_CODE_ORDER_ULID = "01JBQ9C0000000000000000044";

/**
 * Facility ticket sold at the POS (brief 1046): a Rp87.500 pool ticket on its
 * own bill, POS-T001. `?demo=tiket-menunggu` leaves the bill unpaid (ticket
 * pending); `?demo=tiket-lunas` has it paid (ticket issued, credential not yet
 * shown). A ticket sold in the mock gets its own order id; these are the fixed
 * ones for the e2e spec and screenshots.
 */
export const DEMO_TICKET_ORDER_ULID = "01JBQ9T0000000000000000001";
export const DEMO_TICKET_ID = "01JBQ9K0000000000000000001";
export const TICKET_DEMO_SEEDS = ["tiket-menunggu", "tiket-lunas"] as const;
export type TicketDemoSeed = (typeof TICKET_DEMO_SEEDS)[number];

export const PAY_DEMO_SEEDS = [
  "baru",
  "split",
  "qris-aktif",
  "qris-kedaluwarsa",
  "gagal",
  "va",
  "edc-menunggu",
  "edc-tidak-pasti",
  "edc-ditolak",
  "edc-berhasil",
  "lunas",
  "dp-lunas",
] as const;
export type PayDemoSeed = (typeof PAY_DEMO_SEEDS)[number];

/**
 * "laci-buta": the caller is blind to the drawer figures (cashier, or a
 * supervisor on their own shift; legend-4wrfd), so the shift answers carry
 * null for the seven figures. The shift is the awaiting-approval demo shift.
 */
export const BLIND_DRAWER_SEED = "laci-buta";
export const SHIFT_DEMO_SEEDS = ["shift-aktif", BLIND_DRAWER_SEED] as const;
export type ShiftDemoSeed = (typeof SHIFT_DEMO_SEEDS)[number];

export const DAY_DEMO_SEEDS = ["hari-ditutup"] as const;
export type DayDemoSeed = (typeof DAY_DEMO_SEEDS)[number];

/** The raw `?demo=` value of the current page; null on the server or without one. */
export function readDemoSeed(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return new URLSearchParams(window.location.search).get("demo");
  } catch {
    return null;
  }
}

function pick<T extends string>(
  raw: string | null,
  allowed: readonly T[],
): T | null {
  return raw !== null && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : null;
}

export const payDemoSeed = (raw: string | null) => pick(raw, PAY_DEMO_SEEDS);
export const shiftDemoSeed = (raw: string | null) =>
  pick(raw, SHIFT_DEMO_SEEDS);
export const ticketDemoSeed = (raw: string | null) =>
  pick(raw, TICKET_DEMO_SEEDS);
export const dayDemoSeed = (raw: string | null) => pick(raw, DAY_DEMO_SEEDS);

/** Orders the demo knows, by canonical id (a ULID alias maps to its uuid). */
export function canonicalOrderId(id: string): string {
  if (id === DEMO_ORDER_ULID) return DEMO_ORDER_ID;
  if (id === DEMO_CODE_ORDER_ULID) return DEMO_CODE_ORDER_ID;
  return id;
}
