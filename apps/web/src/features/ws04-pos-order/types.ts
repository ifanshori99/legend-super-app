// View-model types for the POS kasir ordering screens and the captain screens
// (beads legend-59v, legend-76t). Screens read these through ./hooks.ts only.
// Rupiah are whole numbers; dates are ISO strings. Nothing here has a shared
// endpoint yet (see ./CONTRACT-GAPS.md): the types are local until it lands.
//
// Plain TypeScript with no runtime imports: Node tests load it directly.

/** Error code a hook returns outside mock mode when the contract is missing. */
export const CONTRACT_PENDING = "CONTRACT_PENDING";

export type SaleChannel = "dine_in" | "takeaway" | "ojol_manual";
export type OjolPlatform = "gofood" | "grabfood" | "shopeefood";

/** "Course 1", "Course 2", "Minuman". */
export interface Course {
  id: string;
  label: string;
  order: number;
}

export interface MenuCategory {
  id: string;
  name: string;
}

export interface ModifierOption {
  id: string;
  name: string;
  priceDeltaIdr: number;
}

export interface ModifierGroup {
  id: string;
  name: string;
  required: boolean;
  min: number;
  max: number;
  options: ModifierOption[];
}

/** A size or kind with its own price; an item with variants needs one chosen. */
export interface MenuVariant {
  id: string;
  name: string;
  priceIdr: number;
}

export interface MenuItem {
  id: string;
  name: string;
  categoryId: string;
  categoryName: string;
  priceIdr: number;
  imageUrl: string | null;
  soldOut: boolean;
  code: string | null;
  course: Course;
  /** Empty for an item without variants. */
  variants: MenuVariant[];
  modifierGroups: ModifierGroup[];
}

export interface Catalog {
  categories: MenuCategory[];
  items: MenuItem[];
  /** ISO. */
  updatedAt: string;
  source: "live" | "cached";
}

export interface SelectedModifier {
  groupId: string;
  optionId: string;
  name: string;
  priceDeltaIdr: number;
}

export type LineStatus = "draft" | "held" | "sent";

export interface CartLine {
  lineId: string;
  menuItemId: string;
  /** The chosen variant, or null for an item without variants. */
  variantId: string | null;
  variantName: string | null;
  name: string;
  /**
   * Display estimate: the item's (or chosen variant's) price; modifier deltas
   * are added on top. The server prices the order; this is never sent.
   */
  unitPriceIdr: number;
  quantity: number;
  modifiers: SelectedModifier[];
  note: string;
  course: Course;
  hold: boolean;
}

export interface OrderLine extends Omit<
  CartLine,
  "hold" | "variantId" | "variantName"
> {
  status: Exclude<LineStatus, "draft">;
}

export interface PosOrderView {
  orderId: string;
  /** The server's status (real contract only); fire states it back. */
  status?: "draft" | "awaiting_payment" | "sent" | "completed" | "voided";
  number: string;
  channel: SaleChannel;
  tableLabel: string | null;
  callNumber: string | null;
  lines: OrderLine[];
  subtotalIdr: number;
}

export interface ParkedDraft {
  id: string;
  label: string;
  channel: SaleChannel;
  tableSessionId: string | null;
  ojol: OjolInput | null;
  lines: CartLine[];
  parkedAt: string;
  subtotalIdr: number;
}

export interface CaptainTable {
  id: string;
  label: string;
  zone: string;
  status: "occupied" | "empty";
  guestCount: number;
  seats: number;
  qrSessionActive: boolean;
  sessionId: string | null;
  hasOpenCall: boolean;
  /**
   * A reservation still holds this unseated table (time and party size only).
   * `null` = none; undefined = the server did not say (soft warning).
   */
  hold?: TableHold | null;
  /** The open session's payment mode; pay first is the cashier's table. */
  paymentMode?: "pay_first" | "open_bill" | null;
}

export interface TableHold {
  startsAt: string;
  endsAt: string;
  pax: number;
}

export interface TableOrderView {
  table: CaptainTable;
  order: PosOrderView | null;
}

/**
 * A table's orders on the real contract: one order per send, oldest first,
 * never merged. Empty while the table has no session.
 */
export interface TableOrdersView {
  table: CaptainTable;
  orders: PosOrderView[];
}

export type ServiceCallType = "call_waiter" | "request_bill" | "complaint";

export interface ServiceCall {
  id: string;
  tableId: string;
  tableLabel: string;
  type: ServiceCallType;
  reason: string;
  createdAt: string;
  status: "new" | "acknowledged" | "resolved";
}

export interface OrderingConnectivity {
  mode: "online" | "edge_only";
  catalogUpdatedAt: string | null;
}

// ---- Call inputs (used by ./api.ts and ./mock-engine.ts) ---------------------

export interface OjolInput {
  platform: OjolPlatform;
  externalRef: string;
}

/** What the cashier chose for the order itself, next to the lines. */
export interface OrderMeta {
  channel: SaleChannel;
  tableLabel: string | null;
  /** The open session of the chosen table; this, not the label, is sent. */
  tableSessionId: string | null;
  ojolPlatform: OjolPlatform | null;
  ojolRef: string;
}

/** The cart and meta of a send that is not answered yet, kept for a re-send. */
export interface OrderSnapshot {
  lines: CartLine[];
  meta: OrderMeta;
}

export interface SubmitOrderInput {
  channel: SaleChannel;
  /** A dine-in order taken by the captain: sent on the `captain` channel. */
  captain?: boolean;
  /** The open table session of the chosen table (dine-in); never the label. */
  tableSessionId: string | null;
  ojol: OjolInput | null;
  lines: CartLine[];
}

/** What the hook sends: the input plus the key made once per intent. */
export interface SubmitOrderRequest extends SubmitOrderInput {
  idempotencyKey: string;
}

export interface FireLinesInput {
  orderId: string;
  lineIds: string[];
}

export interface ParkDraftInput {
  channel: SaleChannel;
  tableSessionId: string | null;
  ojol: OjolInput | null;
  lines: CartLine[];
}

export interface AddToTableInput {
  tableId: string;
  lines: CartLine[];
}

/** What the captain sends for a table: its session, never its label alone. */
export interface CaptainSendInput {
  tableId: string;
  /** The open session of the table; no session, no order. */
  tableSessionId: string | null;
  tableLabel: string;
  lines: CartLine[];
  /** Pay-first table: held back here before anything is sent. */
  payFirst?: boolean;
}

export interface AddToTableRequest extends AddToTableInput {
  idempotencyKey: string;
}

export interface FireTableLinesInput {
  tableId: string;
  lineIds: string[];
}
