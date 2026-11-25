// QR order contracts: floor zones, tables, signed table QR, table sessions and
// participants, the shared cart, the server pricing quote, split bill,
// service requests, failed-item recovery, apology vouchers and post-meal
// reviews.
//
// PRD v1.7 §2 F6/F7/F41/F43, §3 "QR Order Pelanggan" (Scan & Sesi Meja,
// Keamanan Sesi, Split Bill, Panggil Waiter, Status Pesanan, Pemulihan Item
// Gagal, Voucher Permintaan Maaf, Kontrol Open Bill, Ulasan Pascamakan),
// §6.C (tables, table_sessions, session_participants, service_requests,
// order_issues, floor_zones), §6.D (bill_splits). Acceptance: ORD-02, ORD-03,
// ORD-04, ORD-06, ORD-07, ORD-08, ORD-09, ORD-10.
//
// Money is whole rupiah (Idr, `*Idr` fields); ids are UUIDs except orders and
// order items (ULID, §6.C). The QR token hash and session token hash never
// appear on the wire: `tableSchema` and `tableSessionSchema` are strict objects
// without them, and the raw tokens are returned only once, to the holder.

import {
  z,
  uuidSchema,
  tenantIdSchema,
  outletIdSchema,
  userIdSchema,
  uuidIdSchema,
  ulidIdSchema,
  idrSchema,
  basisPointsSchema,
  isoDateTimeSchema,
  toIsoDateTime,
  timeOfDaySchema,
  roundingModeSchema,
  clientInputSchema,
  idempotencyKeySchema,
  outletRefSchema,
  brandRefSchema,
  CoreError,
} from "../core/index.ts";
import type { Idr } from "../core/index.ts";
import type { PaymentStatus } from "../payment/index.ts";
import { orderNetSubtotalIdr } from "../tax/net-subtotal.ts";
// Reuse the merged kitchen contract (legend-acz) for the order id and the
// `order_issues` vocabularies instead of redefining them (AGENT_PLAYBOOK §2).
import {
  orderIdSchema,
  orderIssueTypeSchema,
  orderIssueReasonSchema,
  orderIssueResolutionSchema,
  orderIssueStatusSchema,
  orderIssueSchema,
  ORDER_ISSUE_STATUSES,
} from "../kitchen/schemas.ts";
import type { OrderIssue } from "../kitchen/schemas.ts";
export {
  orderIdSchema,
  orderIssueTypeSchema,
  orderIssueReasonSchema,
  orderIssueResolutionSchema,
  orderIssueStatusSchema,
  orderIssueSchema,
  ORDER_ISSUE_STATUSES,
};
export type { OrderIssue };

const name = z.string().min(1).max(150);
const note = z.string().max(200);
const nonnegativeIdr = idrSchema.refine(
  (value) => value >= 0,
  "Amount must not be negative",
);
const positiveIdr = idrSchema.refine(
  (value) => value > 0,
  "Amount must be positive",
);
const scope = { tenantId: tenantIdSchema, outletId: outletIdSchema };

// ---- Ids ------------------------------------------------------------------

export const floorZoneIdSchema = uuidIdSchema<"FloorZoneId">();
export const tableIdSchema = uuidIdSchema<"TableId">();
export const tableSessionIdSchema = uuidIdSchema<"TableSessionId">();
export const tableLinkGroupIdSchema = uuidIdSchema<"TableLinkGroupId">();
export const sessionParticipantIdSchema =
  uuidIdSchema<"SessionParticipantId">();
export const cartLineIdSchema = uuidIdSchema<"CartLineId">();
export const billSplitIdSchema = uuidIdSchema<"BillSplitId">();
export const serviceRequestIdSchema = uuidIdSchema<"ServiceRequestId">();
export const orderIssueIdSchema = uuidIdSchema<"OrderIssueId">();
export const apologyVoucherIdSchema = uuidIdSchema<"ApologyVoucherId">();
export const tableReviewIdSchema = uuidIdSchema<"TableReviewId">();
/** §6.C order_items.id is ULID (PK); orders.id comes from the kitchen contract. */
export const orderItemIdSchema = ulidIdSchema<"OrderItemId">();

// ---- Floor zones and tables (§6.C floor_zones, tables) --------------------

export const PAYMENT_MODES = ["pay_first", "open_bill"] as const;
export const paymentModeSchema = z.enum(PAYMENT_MODES);
export type PaymentMode = z.infer<typeof paymentModeSchema>;

/** Opening hours of a zone; days use 0 = Sunday, matching JS Date#getDay. */
export const zoneHoursSchema = z.strictObject({
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1),
  start: timeOfDaySchema,
  end: timeOfDaySchema,
});
export type ZoneHours = z.infer<typeof zoneHoursSchema>;

export const floorZoneSchema = z.strictObject({
  id: floorZoneIdSchema,
  ...scope,
  name,
  /** Snapshot source for every session opened in the zone. */
  paymentMode: paymentModeSchema,
  /** floor_zones.service_charge_pct stored as basis points: 500 bp = 5%. */
  serviceChargeBp: basisPointsSchema,
  minimumSpendIdr: nonnegativeIdr,
  hours: z.array(zoneHoursSchema),
  status: z.enum(["active", "inactive"]),
  sortOrder: z.number().int(),
  /** Explicit WFC zone marker (legend-p4q10); false unless an admin sets it. */
  isWfc: z.boolean(),
});
export type FloorZone = z.infer<typeof floorZoneSchema>;

export const TABLE_TYPES = ["regular", "bar", "sofa", "private_room"] as const;
export const TABLE_STATUSES = [
  "available",
  "occupied",
  "reserved",
  "dirty",
  "inactive",
] as const;
export const tableTypeSchema = z.enum(TABLE_TYPES);
export const tableStatusSchema = z.enum(TABLE_STATUSES);
export type TableType = z.infer<typeof tableTypeSchema>;
export type TableStatus = z.infer<typeof tableStatusSchema>;

export const TABLE_SHAPES = ["rect", "round"] as const;
export const tableShapeSchema = z.enum(TABLE_SHAPES);
export type TableShape = z.infer<typeof tableShapeSchema>;

/** Position and shape on the floor plan (JSONB `tables.layout`), in plan units. */
export const tableLayoutSchema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive(),
  height: z.number().positive(),
  rotation: z.union([
    z.literal(0),
    z.literal(90),
    z.literal(180),
    z.literal(270),
  ]),
  shape: tableShapeSchema,
});
export type TableLayout = z.infer<typeof tableLayoutSchema>;

/**
 * Table number as printed on the plan and the QR label: uppercase letters,
 * digits and dashes. Unique per outlet (a guest reads it off the sticker).
 */
export const tableCodeSchema = z
  .string()
  .regex(
    /^[A-Z0-9-]{1,20}$/,
    "Pakai huruf besar, angka, atau tanda hubung (maks. 20 karakter)",
  );

/**
 * Table DTO. The permanent signed QR token and its `qr_token_hash` are not
 * part of it: the raw token is returned only by `issueTableQr`, and the hash
 * never leaves the database.
 */
export const tableSchema = z.strictObject({
  id: tableIdSchema,
  ...scope,
  zoneId: floorZoneIdSchema,
  code: tableCodeSchema,
  capacity: z.number().int().min(1).max(50),
  type: tableTypeSchema,
  layout: tableLayoutSchema,
  status: tableStatusSchema,
});
export type Table = z.infer<typeof tableSchema>;

// ---- Floor admin writes (§3 F9 "Denah & Meja") ----------------------------
//
// The read model for the editor is `getFloorBoard` (zones, tables and the live
// session on each table). These inputs carry only what a manager edits; the
// tenant and outlet come from the route and the session (TEN-02).

export const ZONE_STATUSES = ["active", "inactive"] as const;
export const zoneStatusSchema = z.enum(ZONE_STATUSES);
export type ZoneStatus = z.infer<typeof zoneStatusSchema>;

/** Opening windows; a zone with no window never opens (PRD §3 F9 "Zona"). */
export const zoneOpeningHoursSchema = z.array(zoneHoursSchema).min(1).max(7);

/** Zone name as the settings form sends it; the message tells how to fix it. */
const zoneName = z
  .string()
  .trim()
  .min(1, "Nama zona wajib diisi")
  .max(150, "Nama zona maksimal 150 karakter");

export const createFloorZoneInputSchema = clientInputSchema({
  name: zoneName,
  paymentMode: paymentModeSchema,
  serviceChargeBp: basisPointsSchema,
  minimumSpendIdr: nonnegativeIdr,
  hours: zoneOpeningHoursSchema,
  status: zoneStatusSchema.default("active"),
  sortOrder: z.number().int().min(0).max(999).default(0),
  isWfc: z.boolean().default(false),
});

/** PATCH: only the sent fields change, and at least one must be sent. */
export const updateFloorZoneInputSchema = clientInputSchema({
  name: zoneName.optional(),
  paymentMode: paymentModeSchema.optional(),
  serviceChargeBp: basisPointsSchema.optional(),
  minimumSpendIdr: nonnegativeIdr.optional(),
  hours: zoneOpeningHoursSchema.optional(),
  status: zoneStatusSchema.optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  isWfc: z.boolean().optional(),
}).refine(
  (value) => Object.values(value).some((field) => field !== undefined),
  { message: "Send at least one field to change", path: ["name"] },
);

/**
 * The floor editor only switches a table on or off. Every other floor state
 * (occupied, reserved, dirty) belongs to the live board and its ORD-10 guard
 * (`updateTableStatus`), so an attribute edit can never empty a table in use.
 * The server applies `available` only to an inactive table (activate) and
 * `inactive` only to an available table without a session (deactivate).
 */
export const EDITOR_TABLE_STATUSES = ["available", "inactive"] as const;
export const editorTableStatusSchema = z.enum(EDITOR_TABLE_STATUSES);

export const createTableInputSchema = clientInputSchema({
  zoneId: floorZoneIdSchema,
  code: tableCodeSchema,
  capacity: z.number().int().min(1).max(50),
  type: tableTypeSchema,
  layout: tableLayoutSchema,
  status: editorTableStatusSchema.default("available"),
});

export const updateTableInputSchema = clientInputSchema({
  zoneId: floorZoneIdSchema.optional(),
  code: tableCodeSchema.optional(),
  capacity: z.number().int().min(1).max(50).optional(),
  type: tableTypeSchema.optional(),
  layout: tableLayoutSchema.optional(),
  status: editorTableStatusSchema.optional(),
}).refine(
  (value) => Object.values(value).some((field) => field !== undefined),
  { message: "Send at least one field to change", path: ["code"] },
);

/** One table's new place on the plan. */
export const tablePlacementSchema = z.strictObject({
  tableId: tableIdSchema,
  layout: tableLayoutSchema,
});
export type TablePlacement = z.infer<typeof tablePlacementSchema>;

/** The whole plan in one request, so a drag session never saves half a move. */
export const saveFloorLayoutInputSchema = clientInputSchema({
  placements: z.array(tablePlacementSchema).min(1).max(200),
});

// ---- Signed QR (§3 "Keamanan Sesi", ORD-04) -------------------------------

/** SHA-256 hex of the signed token, stored in tables.qr_token_hash. */
export const qrTokenHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
/**
 * Signed permanent table QR: `v1.<payload>.<signature>`, base64url parts. The
 * server verifies the signature and resolves tenant/outlet/table from it; the
 * client never parses it.
 */
export const signedQrTokenSchema = z
  .string()
  .min(24)
  .max(512)
  .regex(
    /^v1\.[A-Za-z0-9_-]{10,400}\.[A-Za-z0-9_-]{20,120}$/,
    "Expected a v1 signed token",
  );
/** Payload inside the signature. Server-side only; never sent to the client. */
export const qrTokenPayloadSchema = z.strictObject({
  version: z.literal(1),
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  tableId: tableIdSchema,
  keyId: z.string().min(1).max(40),
  issuedAt: isoDateTimeSchema,
});
export type QrTokenPayload = z.infer<typeof qrTokenPayloadSchema>;

/**
 * TEN-02 / ORD-04, fail closed. The ids inside a verified QR token are never
 * trusted on their own. The server (1) resolves the tenant from the request
 * host (TEN-02), (2) verifies the signature with that tenant's key `keyId`,
 * (3) loads the table by `qr_token_hash` = SHA-256(token) inside that tenant,
 * and (4) calls this check, so a token copied across tenants or outlets, a
 * reissued (rotated) token or an inactive table is refused. Every failure is
 * the same `NOT_FOUND`, so the response is not an oracle for valid ids.
 */
export function assertQrTokenMatchesTable(
  payload: QrTokenPayload,
  resolvedTenantId: string,
  table: Pick<Table, "id" | "tenantId" | "outletId" | "status"> | null,
): void {
  if (
    table === null ||
    table.status === "inactive" ||
    payload.tenantId !== resolvedTenantId ||
    table.tenantId !== resolvedTenantId ||
    payload.outletId !== table.outletId ||
    payload.tableId !== table.id
  )
    throw new CoreError("NOT_FOUND", "QR meja tidak dikenali");
}

export const tableQrSchema = z.strictObject({
  tableId: tableIdSchema,
  token: signedQrTokenSchema,
  /** Public menu URL printed on the table sticker, e.g. https://…/t/<token>. */
  url: z.string().min(1).max(500),
  issuedAt: isoDateTimeSchema,
});
export type TableQr = z.infer<typeof tableQrSchema>;

// ---- Table sessions and participants (§6.C table_sessions) ----------------

export const TABLE_SESSION_STATUSES = [
  "pending_confirmation",
  "open",
  "bill_requested",
  "closed",
  "voided",
] as const;
export const tableSessionStatusSchema = z.enum(TABLE_SESSION_STATUSES);
export type TableSessionStatus = z.infer<typeof tableSessionStatusSchema>;

export const tableSessionClosedReasonSchema = z.enum([
  "paid_and_cleaned",
  "voided",
  "expired",
]);
export type TableSessionClosedReason = z.infer<
  typeof tableSessionClosedReasonSchema
>;

export const sessionParticipantSchema = z.strictObject({
  id: sessionParticipantIdSchema,
  tenantId: tenantIdSchema,
  tableSessionId: tableSessionIdSchema,
  /** Opaque device fingerprint; the guest identity for unauthenticated orders. */
  deviceHash: z.string().min(8).max(128),
  /** Set when the guest is signed in; guests may order without it (ORD-01). */
  userId: userIdSchema.nullable(),
  joinedAt: isoDateTimeSchema,
  lastSeenAt: isoDateTimeSchema,
});
export type SessionParticipant = z.infer<typeof sessionParticipantSchema>;

export const tableSessionSchema = z
  .strictObject({
    id: tableSessionIdSchema,
    ...scope,
    tableId: tableIdSchema,
    pax: z.number().int().min(1).max(30),
    /** Snapshot of the zone's payment mode at open time. */
    paymentMode: paymentModeSchema,
    status: tableSessionStatusSchema,
    confirmedBy: userIdSchema.nullable(),
    reservationId: uuidSchema.nullable(),
    participants: z.array(sessionParticipantSchema),
    openedAt: isoDateTimeSchema,
    closedAt: isoDateTimeSchema.nullable(),
    lastActivityAt: isoDateTimeSchema,
    billRequestedAt: isoDateTimeSchema.nullable(),
    closedReason: tableSessionClosedReasonSchema.nullable(),
  })
  .superRefine((session, ctx) => {
    const active = session.status !== "closed" && session.status !== "voided";
    if (active && (session.closedAt !== null || session.closedReason !== null))
      ctx.addIssue({
        code: "custom",
        path: ["closedAt"],
        message: "An active session cannot carry closedAt or closedReason",
      });
    if (!active && (session.closedAt === null || session.closedReason === null))
      ctx.addIssue({
        code: "custom",
        path: ["closedAt"],
        message: "A closed session requires closedAt and closedReason",
      });
    if (session.status === "bill_requested" && session.billRequestedAt === null)
      ctx.addIssue({
        code: "custom",
        path: ["billRequestedAt"],
        message: "bill_requested requires billRequestedAt",
      });
    if (session.paymentMode === "pay_first" && session.confirmedBy !== null)
      ctx.addIssue({
        code: "custom",
        path: ["confirmedBy"],
        message:
          "A pay-first session is opened by the guest, not confirmed by staff",
      });
    if (
      session.paymentMode === "pay_first" &&
      session.status === "pending_confirmation"
    )
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message:
          "Only an open-bill session waits for waiter confirmation; pay-first opens immediately",
      });
    if (
      session.paymentMode === "open_bill" &&
      session.status === "pending_confirmation" &&
      session.confirmedBy !== null
    )
      ctx.addIssue({
        code: "custom",
        path: ["confirmedBy"],
        message: "pending_confirmation cannot be confirmed yet",
      });
    if (
      session.paymentMode === "open_bill" &&
      (session.status === "open" || session.status === "bill_requested") &&
      session.confirmedBy === null
    )
      ctx.addIssue({
        code: "custom",
        path: ["confirmedBy"],
        message: "An open-bill session must be confirmed before it opens",
      });
  });
export type TableSession = z.infer<typeof tableSessionSchema>;

/**
 * Coordinator decision (2026-11-01): a guest session token lives at most 12
 * hours from the session open and never past the bill close (PRD "Keamanan
 * Sesi": the session ends when the bill is settled and the table is clean).
 * Rescans never extend it.
 */
export const TABLE_SESSION_TOKEN_MAX_HOURS = 12;

/** Hard expiry of a session token: min(openedAt + 12 h, closedAt). */
export function tableSessionTokenExpiresAt(
  session: Pick<TableSession, "openedAt" | "closedAt">,
): string {
  const opened = new Date(session.openedAt).getTime();
  if (Number.isNaN(opened)) throw new RangeError("Invalid openedAt");
  const openedLimit = opened + TABLE_SESSION_TOKEN_MAX_HOURS * 60 * 60 * 1_000;
  if (session.closedAt === null) return toIsoDateTime(new Date(openedLimit));
  const closed = new Date(session.closedAt).getTime();
  if (Number.isNaN(closed)) throw new RangeError("Invalid closedAt");
  return toIsoDateTime(new Date(Math.min(openedLimit, closed)));
}

export const TABLE_SESSION_ACTIONS = [
  "confirm",
  "request_bill",
  "reopen",
  "close",
  "void",
] as const;
export type TableSessionAction = (typeof TABLE_SESSION_ACTIONS)[number];

const sessionTransitions: Record<
  TableSessionStatus,
  Partial<Record<TableSessionAction, TableSessionStatus>>
> = {
  pending_confirmation: { confirm: "open", void: "voided" },
  open: { request_bill: "bill_requested", close: "closed", void: "voided" },
  bill_requested: { reopen: "open", close: "closed", void: "voided" },
  closed: {},
  voided: {},
};

/** Explicit session lifecycle; anything not listed throws RangeError. */
export function transitionTableSession(
  status: TableSessionStatus,
  action: TableSessionAction,
): TableSessionStatus {
  const next = sessionTransitions[status]?.[action];
  if (!next)
    throw new RangeError(
      `Invalid table session transition: ${status} --${action}-->`,
    );
  return next;
}

/**
 * ORD-10: a table is emptied only after the bill is settled and the table is
 * cleaned, or when a waiter explicitly confirms it (PRD "Kontrol Open Bill").
 */
export function canCloseTableSession(input: {
  billOutstandingIdr: Idr;
  tableCleaned: boolean;
  waiterConfirmedEmpty: boolean;
}): boolean {
  return (
    input.waiterConfirmedEmpty ||
    (input.billOutstandingIdr === 0 && input.tableCleaned)
  );
}

export function assertCanCloseTableSession(input: {
  billOutstandingIdr: Idr;
  tableCleaned: boolean;
  waiterConfirmedEmpty: boolean;
}): void {
  if (!canCloseTableSession(input))
    throw new RangeError(
      "ORD-10: the bill is still outstanding; a waiter must confirm before the table is marked empty",
    );
}

/**
 * ORD-04: a session token from a closed or voided session cannot place orders
 * on behalf of that session. The table QR itself stays valid: the next scan
 * opens a new session.
 */
export function assertSessionUsable(
  session: Pick<TableSession, "status">,
): void {
  if (session.status === "closed" || session.status === "voided")
    throw new RangeError(
      "ORD-04: this table session is closed; scan the table QR again",
    );
}

// ---- Shared cart (§3 "Menu & Keranjang") ----------------------------------

export const cartLineModifierSchema = z.strictObject({
  modifierId: uuidSchema,
  groupId: uuidSchema,
  /** Snapshot: a later menu edit must not change a placed line. */
  name,
  priceIdr: nonnegativeIdr,
});

export const cartLineSchema = z
  .strictObject({
    id: cartLineIdSchema,
    ...scope,
    tableSessionId: tableSessionIdSchema,
    menuItemId: uuidSchema,
    variantId: uuidSchema.nullable(),
    name,
    quantity: z.number().int().min(1).max(99),
    modifiers: z.array(cartLineModifierSchema),
    note: note.nullable(),
    /** Channel price resolved by the server (ORD-03). */
    unitPriceIdr: positiveIdr,
    modifiersTotalIdr: nonnegativeIdr,
    lineTotalIdr: positiveIdr,
    addedByParticipantId: sessionParticipantIdSchema.nullable(),
    addedAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .superRefine((line, ctx) => {
    const modifiers = line.modifiers.reduce(
      (sum, modifier) => sum + modifier.priceIdr,
      0,
    );
    if (line.modifiersTotalIdr !== modifiers)
      ctx.addIssue({
        code: "custom",
        path: ["modifiersTotalIdr"],
        message: "modifiersTotalIdr must equal the sum of modifier prices",
      });
    if (
      line.lineTotalIdr !==
      (line.unitPriceIdr + line.modifiersTotalIdr) * line.quantity
    )
      ctx.addIssue({
        code: "custom",
        path: ["lineTotalIdr"],
        message: "lineTotalIdr must equal (unit price + modifiers) x quantity",
      });
  });
export type CartLine = z.infer<typeof cartLineSchema>;

export const cartSchema = z
  .strictObject({
    sessionId: tableSessionIdSchema,
    /** Optimistic concurrency: every write sends the version it read. */
    version: z.number().int().nonnegative(),
    lines: z.array(cartLineSchema),
    updatedAt: isoDateTimeSchema,
  })
  .superRefine((cart, ctx) => {
    for (const line of cart.lines)
      if (line.tableSessionId !== cart.sessionId)
        ctx.addIssue({
          code: "custom",
          path: ["lines"],
          message: "Every cart line must belong to the cart's session",
        });
  });
export type Cart = z.infer<typeof cartSchema>;

export const addCartLineInputSchema = clientInputSchema({
  menuItemId: uuidSchema,
  variantId: uuidSchema.nullable().optional(),
  quantity: z.number().int().min(1).max(99),
  modifierIds: z.array(uuidSchema).max(20),
  note: note.optional(),
  expectedCartVersion: z.number().int().nonnegative(),
  idempotencyKey: idempotencyKeySchema,
});

export const updateCartLineInputSchema = clientInputSchema({
  quantity: z.number().int().min(1).max(99).optional(),
  modifierIds: z.array(uuidSchema).max(20).optional(),
  note: note.nullable().optional(),
  expectedCartVersion: z.number().int().nonnegative(),
  idempotencyKey: idempotencyKeySchema,
}).refine(
  (value) =>
    value.quantity !== undefined ||
    value.modifierIds !== undefined ||
    value.note !== undefined,
  { message: "Nothing to update", path: ["quantity"] },
);

export const cartMutationResultSchema = z.strictObject({
  cart: cartSchema,
  line: cartLineSchema.nullable(),
});
export type CartMutationResult = z.infer<typeof cartMutationResultSchema>;

// ---- Server pricing quote (ORD-03) ---------------------------------------

export const quoteLineSchema = z.strictObject({
  cartLineId: cartLineIdSchema,
  menuItemId: uuidSchema,
  name,
  quantity: z.number().int().min(1).max(99),
  unitPriceIdr: positiveIdr,
  modifiersTotalIdr: nonnegativeIdr,
  lineSubtotalIdr: nonnegativeIdr,
  discountIdr: nonnegativeIdr,
  lineTotalIdr: nonnegativeIdr,
  taxRuleId: uuidSchema.nullable(),
});

export const discountLineSchema = z.strictObject({
  label: name,
  source: z.enum(["promo", "voucher", "manual"]),
  amountIdr: positiveIdr,
});

export const serviceChargeLineSchema = z.strictObject({
  rateBp: basisPointsSchema,
  baseIdr: nonnegativeIdr,
  amountIdr: nonnegativeIdr,
});

export const taxLineSchema = z.strictObject({
  taxRuleId: uuidSchema,
  name,
  rateBp: basisPointsSchema,
  baseIdr: nonnegativeIdr,
  amountIdr: nonnegativeIdr,
});

export const roundingLineSchema = z.strictObject({
  incrementIdr: z.number().int().positive(),
  mode: roundingModeSchema,
  /** orders.rounding_idr: may be negative. */
  adjustmentIdr: idrSchema,
});

export const removedCartLineSchema = z.strictObject({
  cartLineId: cartLineIdSchema,
  menuItemId: uuidSchema,
  name,
  reason: z.literal("sold_out"),
});

export const priceChangeSchema = z.strictObject({
  cartLineId: cartLineIdSchema,
  name,
  previousUnitPriceIdr: positiveIdr,
  unitPriceIdr: positiveIdr,
});

export const minimumSpendSchema = z.strictObject({
  requiredIdr: nonnegativeIdr,
  shortfallIdr: nonnegativeIdr,
});

export const servingEstimateSchema = z
  .strictObject({
    minMinutes: z.number().int().positive(),
    maxMinutes: z.number().int().positive(),
    computedAt: isoDateTimeSchema,
  })
  .refine((estimate) => estimate.minMinutes <= estimate.maxMinutes, {
    message: "minMinutes must not exceed maxMinutes",
    path: ["maxMinutes"],
  });

/**
 * The quote the guest sees before checkout. Every amount is computed by the
 * server from the cart, channel prices, zone service charge and tax rules;
 * the client sends only promo/voucher codes, never prices (ORD-03).
 */
export const orderQuoteSchema = z
  .strictObject({
    sessionId: tableSessionIdSchema,
    cartVersion: z.number().int().nonnegative(),
    lines: z.array(quoteLineSchema),
    subtotalIdr: nonnegativeIdr,
    discountLines: z.array(discountLineSchema),
    discountIdr: nonnegativeIdr,
    /**
     * Inclusive prices (legend-49pw): the menu prices already contain service
     * charge and tax. Lines stay gross, `serviceCharge` and `taxLines` are the
     * included breakdown (parts of the total, not added to it), and
     * total = subtotal - discount + rounding.
     */
    pricesIncludeTaxAndService: z.boolean().default(false),
    serviceCharge: serviceChargeLineSchema,
    taxLines: z.array(taxLineSchema),
    taxIdr: nonnegativeIdr,
    rounding: roundingLineSchema,
    totalIdr: nonnegativeIdr,
    removedLines: z.array(removedCartLineSchema),
    priceChanges: z.array(priceChangeSchema),
    minimumSpend: minimumSpendSchema,
    /** From WS-04 order pacing; null until a pacing estimate is available. */
    servingEstimate: servingEstimateSchema.nullable(),
    computedAt: isoDateTimeSchema,
  })
  .superRefine((quote, ctx) => {
    const sum = (values: readonly number[]) =>
      values.reduce((total, value) => total + value, 0);
    const add = (
      path: (string | number)[],
      message: string,
      invalid: boolean,
    ) => {
      if (invalid) ctx.addIssue({ code: "custom", path, message });
    };
    add(
      ["subtotalIdr"],
      "subtotalIdr must equal the sum of line subtotals",
      quote.subtotalIdr !==
        sum(quote.lines.map((line) => line.lineSubtotalIdr)),
    );
    add(
      ["discountIdr"],
      "discountIdr must equal the sum of line discounts",
      quote.discountIdr !== sum(quote.lines.map((line) => line.discountIdr)),
    );
    add(
      ["discountIdr"],
      "discountIdr must equal the sum of discount lines",
      quote.discountIdr !==
        sum(quote.discountLines.map((line) => line.amountIdr)),
    );
    add(
      ["taxIdr"],
      "taxIdr must equal the sum of tax lines",
      quote.taxIdr !== sum(quote.taxLines.map((line) => line.amountIdr)),
    );
    for (const line of quote.lines)
      add(
        ["lines"],
        "lineTotalIdr must equal lineSubtotalIdr - discountIdr",
        line.lineTotalIdr !== line.lineSubtotalIdr - line.discountIdr,
      );
    const netSubtotal = quote.subtotalIdr - quote.discountIdr;
    if (quote.pricesIncludeTaxAndService) {
      add(
        ["totalIdr"],
        "inclusive totalIdr must equal subtotal - discount + rounding",
        quote.totalIdr !== netSubtotal + quote.rounding.adjustmentIdr,
      );
      add(
        ["serviceCharge", "amountIdr"],
        "included service charge and tax cannot exceed the net subtotal",
        quote.serviceCharge.amountIdr + quote.taxIdr > netSubtotal,
      );
    } else
      add(
        ["totalIdr"],
        "totalIdr must equal subtotal - discount + service + tax + rounding",
        quote.totalIdr !==
          netSubtotal +
            quote.serviceCharge.amountIdr +
            quote.taxIdr +
            quote.rounding.adjustmentIdr,
      );
    add(
      ["minimumSpend", "shortfallIdr"],
      "shortfallIdr must be the missing amount up to the zone minimum spend",
      quote.minimumSpend.shortfallIdr !==
        Math.max(
          0,
          quote.minimumSpend.requiredIdr -
            orderNetSubtotalIdr({
              subtotalIdr: netSubtotal,
              serviceChargeIdr: quote.serviceCharge.amountIdr,
              taxIdr: quote.taxIdr,
              pricesIncludeTax: quote.pricesIncludeTaxAndService,
            }),
        ),
    );
  });
export type OrderQuote = z.infer<typeof orderQuoteSchema>;
export type QuoteLine = z.infer<typeof quoteLineSchema>;
export type TaxLine = z.infer<typeof taxLineSchema>;
export type DiscountLine = z.infer<typeof discountLineSchema>;

export const quoteInputSchema = clientInputSchema({
  promoCode: z
    .string()
    .min(3)
    .max(40)
    .regex(/^[A-Z0-9-]+$/)
    .optional(),
  voucherCode: z
    .string()
    .regex(/^[A-Z0-9]{3,6}(-[A-Z0-9]{4,6}){1,3}$/)
    .optional(),
});

// ---- QR orders (§6.C orders / order_items) --------------------------------

export const QR_ORDER_STATUSES = [
  "awaiting_payment",
  "sent",
  "completed",
  "voided",
] as const;
export const qrOrderStatusSchema = z.enum(QR_ORDER_STATUSES);
export type QrOrderStatus = z.infer<typeof qrOrderStatusSchema>;

export const ORDER_ITEM_STATUSES = [
  "queued",
  "in_progress",
  "ready",
  "served",
  "voided",
] as const;
export const orderItemStatusSchema = z.enum(ORDER_ITEM_STATUSES);
export type OrderItemStatus = z.infer<typeof orderItemStatusSchema>;

export const fireStatusSchema = z.enum(["held", "fired"]);
export type FireStatus = z.infer<typeof fireStatusSchema>;

export const orderModifierSnapshotSchema = z.strictObject({
  modifierId: uuidSchema,
  name,
  priceIdr: nonnegativeIdr,
});

export const qrOrderItemSchema = z
  .strictObject({
    id: orderItemIdSchema,
    tenantId: tenantIdSchema,
    orderId: orderIdSchema,
    menuItemId: uuidSchema,
    variantId: uuidSchema.nullable(),
    name,
    quantity: z.number().int().min(1).max(99),
    unitPriceIdr: positiveIdr,
    modifiersTotalIdr: nonnegativeIdr,
    lineTotalIdr: positiveIdr,
    modifiers: z.array(orderModifierSnapshotSchema),
    note: note.nullable(),
    course: z.string().max(20).nullable(),
    fireStatus: fireStatusSchema,
    status: orderItemStatusSchema,
  })
  .superRefine((item, ctx) => {
    if (
      item.lineTotalIdr !==
      (item.unitPriceIdr + item.modifiersTotalIdr) * item.quantity
    )
      ctx.addIssue({
        code: "custom",
        path: ["lineTotalIdr"],
        message: "lineTotalIdr must equal (unit price + modifiers) x quantity",
      });
    if (
      item.modifiersTotalIdr !==
      item.modifiers.reduce((sum, modifier) => sum + modifier.priceIdr, 0)
    )
      ctx.addIssue({
        code: "custom",
        path: ["modifiersTotalIdr"],
        message: "modifiersTotalIdr must equal the sum of modifier prices",
      });
  });
export type QrOrderItem = z.infer<typeof qrOrderItemSchema>;

export const qrOrderSchema = z
  .strictObject({
    id: orderIdSchema,
    ...scope,
    number: z.string().regex(/^[A-Z0-9-]{3,30}$/),
    channel: z.literal("qr"),
    serviceType: z.literal("dine_in"),
    tableSessionId: tableSessionIdSchema,
    customerProfileId: uuidSchema.nullable(),
    subtotalIdr: nonnegativeIdr,
    discountIdr: nonnegativeIdr,
    serviceChargeIdr: nonnegativeIdr,
    taxIdr: nonnegativeIdr,
    roundingIdr: idrSchema,
    totalIdr: nonnegativeIdr,
    /**
     * Inclusive prices (harga nett, legend-zmc2), as on the quote: subtotal is
     * the gross item sum, service and tax are the parts backed out of it, and
     * total = subtotal - discount + rounding.
     */
    pricesIncludeTaxAndService: z.boolean().default(false),
    /**
     * legend-pc51h: sale value of the lines a kitchen swap added. The replaced
     * line keeps the sale value inside `subtotalIdr`; the replacement is only a
     * kitchen line whose price difference is billed (order_issue_charges) or
     * credited (apology voucher) outside the order, so the order money stays
     * frozen. The server sets this from the swap links, 0 for an order
     * without a swap (then the subtotal must equal the item sum exactly).
     */
    swapReplacementIdr: nonnegativeIdr.default(0 as Idr),
    status: qrOrderStatusSchema,
    items: z.array(qrOrderItemSchema),
    createdAt: isoDateTimeSchema,
    placedAt: isoDateTimeSchema,
  })
  .superRefine((order, ctx) => {
    const netSubtotal = order.subtotalIdr - order.discountIdr;
    if (order.pricesIncludeTaxAndService) {
      if (order.totalIdr !== netSubtotal + order.roundingIdr)
        ctx.addIssue({
          code: "custom",
          path: ["totalIdr"],
          message:
            "inclusive totalIdr must equal subtotal - discount + rounding",
        });
      if (order.serviceChargeIdr + order.taxIdr > netSubtotal)
        ctx.addIssue({
          code: "custom",
          path: ["serviceChargeIdr"],
          message:
            "included service charge and tax cannot exceed the net subtotal",
        });
    } else if (
      order.totalIdr !==
      netSubtotal + order.serviceChargeIdr + order.taxIdr + order.roundingIdr
    )
      ctx.addIssue({
        code: "custom",
        path: ["totalIdr"],
        message:
          "totalIdr must equal subtotal - discount + service + tax + rounding",
      });
    for (const item of order.items)
      if (item.orderId !== order.id)
        ctx.addIssue({
          code: "custom",
          path: ["items"],
          message: "Every order item must belong to the order",
        });
    const itemSum = order.items.reduce(
      (sum, item) => sum + item.lineTotalIdr,
      0,
    );
    if (order.swapReplacementIdr > itemSum)
      ctx.addIssue({
        code: "custom",
        path: ["swapReplacementIdr"],
        message: "swapReplacementIdr cannot exceed the sum of item line totals",
      });
    if (order.subtotalIdr !== itemSum - order.swapReplacementIdr)
      ctx.addIssue({
        code: "custom",
        path: ["subtotalIdr"],
        message: "subtotalIdr must equal the sum of item line totals",
      });
  });
export type QrOrder = z.infer<typeof qrOrderSchema>;

export const placeOrderInputSchema = clientInputSchema({
  expectedCartVersion: z.number().int().nonnegative(),
  idempotencyKey: idempotencyKeySchema,
  note: note.optional(),
});

export const kitchenFireSchema = z.enum(["fired", "held_for_payment"]);
export type KitchenFire = z.infer<typeof kitchenFireSchema>;

export const qrOrderPlacementSchema = z.strictObject({
  orderStatus: z.enum(["awaiting_payment", "sent"]),
  kitchenFire: kitchenFireSchema,
  sessionStatusAfter: tableSessionStatusSchema,
});
export type QrOrderPlacement = z.infer<typeof qrOrderPlacementSchema>;

/**
 * The pay-first / open-bill gate (§3 "Mode Bayar", ORD-02, ORD-04).
 * - Pay-first: the order waits for a verified payment before the kitchen sees it.
 * - Open bill: the session must be confirmed by a waiter first; then the order
 *   fires immediately and is paid at the end.
 */
export function planQrOrderPlacement(input: {
  paymentMode: PaymentMode;
  sessionStatus: TableSessionStatus;
  cartLineCount: number;
}): QrOrderPlacement {
  if (!Number.isInteger(input.cartLineCount) || input.cartLineCount < 1)
    throw new RangeError("Cannot place an order from an empty cart");
  if (input.sessionStatus === "closed" || input.sessionStatus === "voided")
    throw new RangeError(
      "ORD-04: this table session is closed; scan the table QR again",
    );
  if (
    input.paymentMode === "open_bill" &&
    input.sessionStatus === "pending_confirmation"
  )
    throw new RangeError(
      "An open-bill session must be confirmed by a waiter before the first order",
    );
  if (input.paymentMode === "pay_first")
    return qrOrderPlacementSchema.parse({
      orderStatus: "awaiting_payment",
      kitchenFire: "held_for_payment",
      sessionStatusAfter: input.sessionStatus,
    });
  return qrOrderPlacementSchema.parse({
    orderStatus: "sent",
    kitchenFire: "fired",
    sessionStatusAfter:
      input.sessionStatus === "bill_requested" ? "open" : input.sessionStatus,
  });
}

/**
 * ORD-02: on pay-first, no item reaches the KDS before a verified payment. The
 * payment status comes from the WS-05 contract; only `paid` is confirmation.
 */
export function canFireQrOrder(input: {
  paymentMode: PaymentMode;
  orderStatus: QrOrderStatus;
  /** WS-05 payment intent status; only `paid` (set from a verified webhook or gateway status check) fires. */
  paymentStatus: PaymentStatus;
}): boolean {
  if (input.paymentMode === "open_bill") return input.orderStatus === "sent";
  return (
    input.orderStatus === "awaiting_payment" && input.paymentStatus === "paid"
  );
}

export const placeOrderResultSchema = z
  .strictObject({
    order: qrOrderSchema,
    quote: orderQuoteSchema,
    session: tableSessionSchema,
    kitchenFire: kitchenFireSchema,
  })
  .superRefine((result, ctx) => {
    const add = (
      path: (string | number)[],
      message: string,
      invalid: boolean,
    ) => {
      if (invalid) ctx.addIssue({ code: "custom", path, message });
    };
    add(
      ["order", "tableSessionId"],
      "The order must belong to the quoted session",
      result.order.tableSessionId !== result.quote.sessionId,
    );
    add(
      ["session", "id"],
      "The session must be the quoted session",
      result.session.id !== result.quote.sessionId,
    );
    add(
      ["order", "subtotalIdr"],
      "Order totals must snapshot the quote",
      result.order.subtotalIdr !== result.quote.subtotalIdr ||
        result.order.discountIdr !== result.quote.discountIdr ||
        result.order.serviceChargeIdr !==
          result.quote.serviceCharge.amountIdr ||
        result.order.taxIdr !== result.quote.taxIdr ||
        result.order.roundingIdr !== result.quote.rounding.adjustmentIdr ||
        result.order.totalIdr !== result.quote.totalIdr ||
        result.order.pricesIncludeTaxAndService !==
          result.quote.pricesIncludeTaxAndService,
    );
  });
export type PlaceOrderResult = z.infer<typeof placeOrderResultSchema>;

// ---- Split bill (§6.D bill_splits, ORD-06) --------------------------------

export const BILL_SPLIT_METHODS = ["equal", "by_item", "by_person"] as const;
export const billSplitMethodSchema = z.enum(BILL_SPLIT_METHODS);
export type BillSplitMethod = z.infer<typeof billSplitMethodSchema>;

export const BILL_SPLIT_STATUSES = ["pending", "paid", "voided"] as const;
export const billSplitStatusSchema = z.enum(BILL_SPLIT_STATUSES);
export type BillSplitStatus = z.infer<typeof billSplitStatusSchema>;

export const billSplitSchema = z
  .strictObject({
    id: billSplitIdSchema,
    ...scope,
    tableSessionId: tableSessionIdSchema,
    orderId: orderIdSchema.nullable(),
    method: billSplitMethodSchema,
    shareIndex: z.number().int().nonnegative(),
    /** Rounded part; the parts sum exactly to the bill total (ORD-06). */
    amountIdr: nonnegativeIdr,
    status: billSplitStatusSchema,
    label: name.nullable(),
    itemIds: z.array(orderItemIdSchema),
    participantId: sessionParticipantIdSchema.nullable(),
    createdAt: isoDateTimeSchema,
  })
  .superRefine((split, ctx) => {
    if (split.method === "by_item" && split.itemIds.length === 0)
      ctx.addIssue({
        code: "custom",
        path: ["itemIds"],
        message: "A by-item split needs at least one item",
      });
    if (split.method !== "by_item" && split.itemIds.length > 0)
      ctx.addIssue({
        code: "custom",
        path: ["itemIds"],
        message: "Only a by-item split carries item ids",
      });
    if (split.method === "by_person" && split.participantId === null)
      ctx.addIssue({
        code: "custom",
        path: ["participantId"],
        message: "A by-person split is tied to a session participant",
      });
  });
export type BillSplit = z.infer<typeof billSplitSchema>;

const splitIdempotency = { idempotencyKey: idempotencyKeySchema };

export const createSplitsInputSchema = z.discriminatedUnion("method", [
  clientInputSchema({
    method: z.literal("equal"),
    parts: z.number().int().min(1).max(50),
    ...splitIdempotency,
  }),
  clientInputSchema({
    method: z.literal("by_person"),
    participantIds: z.array(sessionParticipantIdSchema).min(1).max(50),
    ...splitIdempotency,
  }),
  clientInputSchema({
    method: z.literal("by_item"),
    assignments: z
      .array(
        z.strictObject({
          orderItemIds: z.array(orderItemIdSchema).min(1),
          label: name.optional(),
          participantId: sessionParticipantIdSchema.optional(),
        }),
      )
      .min(1),
    ...splitIdempotency,
  }),
]);
export type CreateSplitsInput = z.infer<typeof createSplitsInputSchema>;

/**
 * The dearer-swap difference of a failed-item issue, owed on the open bill
 * (legend-i83ls). `open` and `paid` count in the bill total, `paid` in what is
 * paid; `waived`, `expired` and `voided` (legend-s61sg: the order was voided
 * and the charge given back) are shown but owe nothing.
 */
export const ORDER_ISSUE_CHARGE_STATUSES = [
  "open",
  "paid",
  "routed_pos",
  "waived",
  "expired",
  "voided",
] as const;
export const orderIssueChargeStatusSchema = z.enum(ORDER_ISSUE_CHARGE_STATUSES);
export type OrderIssueChargeStatus = z.infer<
  typeof orderIssueChargeStatusSchema
>;
export const sessionBillChargeSchema = z.strictObject({
  id: uuidSchema,
  orderIssueId: uuidSchema,
  orderId: orderIdSchema,
  status: orderIssueChargeStatusSchema,
  differenceIdr: positiveIdr,
  grossSalesIdr: nonnegativeIdr,
  serviceChargeIdr: nonnegativeIdr,
  pbjtIdr: nonnegativeIdr,
  amountIdr: positiveIdr,
  paidAt: isoDateTimeSchema.nullable(),
});
export type SessionBillCharge = z.infer<typeof sessionBillChargeSchema>;

/**
 * The cashier takes a swap charge at the till. Cash (legend-800h1):
 * `receivedIdr` is what the guest handed over (at least the charge amount; the
 * change is the answer's `changeIdr`). QRIS and EDC card (legend-gt98h): no
 * amount is sent, the server's charge amount is the only one. QRIS answers a
 * pending code; the charge is paid when the gateway confirms it. EDC names the
 * approved `edc_transactions` sale (reference = the charge id) that paid it.
 */
export const collectChargeAtPosInputSchema = z.discriminatedUnion("method", [
  z.strictObject({
    idempotencyKey: uuidSchema,
    method: z.literal("cash"),
    receivedIdr: positiveIdr,
  }),
  z.strictObject({
    idempotencyKey: uuidSchema,
    method: z.literal("qris"),
  }),
  z.strictObject({
    idempotencyKey: uuidSchema,
    method: z.literal("edc_card"),
    edcTransactionId: uuidSchema,
  }),
]);
export type CollectChargeAtPosInput = z.infer<
  typeof collectChargeAtPosInputSchema
>;

export const sessionBillSchema = z
  .strictObject({
    sessionId: tableSessionIdSchema,
    orders: z.array(qrOrderSchema),
    /** Swap differences owed on this session (legend-i83ls). */
    charges: z.array(sessionBillChargeSchema).default([]),
    totals: z.strictObject({
      subtotalIdr: nonnegativeIdr,
      discountIdr: nonnegativeIdr,
      serviceChargeIdr: nonnegativeIdr,
      taxIdr: nonnegativeIdr,
      roundingIdr: idrSchema,
      totalIdr: nonnegativeIdr,
      paidIdr: nonnegativeIdr,
      outstandingIdr: nonnegativeIdr,
    }),
    splits: z.array(billSplitSchema),
    computedAt: isoDateTimeSchema,
  })
  .superRefine((bill, ctx) => {
    const sum = (values: readonly number[]) =>
      values.reduce((total, value) => total + value, 0);
    const add = (
      path: (string | number)[],
      message: string,
      invalid: boolean,
    ) => {
      if (invalid) ctx.addIssue({ code: "custom", path, message });
    };
    const totals = bill.totals;
    const ordersTotal = sum(bill.orders.map((order) => order.totalIdr));
    const chargesOwed = sum(
      bill.charges
        .filter(
          (charge) => charge.status === "open" || charge.status === "paid",
        )
        .map((charge) => charge.amountIdr),
    );
    add(
      ["totals", "subtotalIdr"],
      "Bill subtotal must equal the sum of order subtotals",
      totals.subtotalIdr !== sum(bill.orders.map((order) => order.subtotalIdr)),
    );
    add(
      ["totals", "discountIdr"],
      "Bill discount must equal the sum of order discounts",
      totals.discountIdr !== sum(bill.orders.map((order) => order.discountIdr)),
    );
    add(
      ["totals", "serviceChargeIdr"],
      "Bill service charge must equal the sum of order service charges",
      totals.serviceChargeIdr !==
        sum(bill.orders.map((order) => order.serviceChargeIdr)),
    );
    add(
      ["totals", "taxIdr"],
      "Bill tax must equal the sum of order taxes",
      totals.taxIdr !== sum(bill.orders.map((order) => order.taxIdr)),
    );
    add(
      ["totals", "roundingIdr"],
      "Bill rounding must equal the sum of order rounding lines",
      totals.roundingIdr !== sum(bill.orders.map((order) => order.roundingIdr)),
    );
    add(
      ["totals", "totalIdr"],
      "Bill total must equal the sum of order totals and owed charges",
      totals.totalIdr !== ordersTotal + chargesOwed,
    );
    add(
      ["totals", "outstandingIdr"],
      "outstandingIdr must be the unpaid part of the total",
      totals.outstandingIdr !== Math.max(0, totals.totalIdr - totals.paidIdr),
    );
    // ORD-06: a split set covers either the whole session bill (orderId
    // null, open bill) or one order (pay-first checkout). Each set sums
    // exactly to what it splits; the remainder rupiah is placed by
    // allocateIdr/splitIdrEvenly (largest remainder, lowest index first).
    const liveSplits = bill.splits.filter((split) => split.status !== "voided");
    const groups = new Map<string | null, typeof liveSplits>();
    for (const split of liveSplits)
      groups.set(split.orderId, [...(groups.get(split.orderId) ?? []), split]);
    add(
      ["splits"],
      "ORD-06: do not mix session-level and per-order splits",
      groups.has(null) && groups.size > 1,
    );
    for (const [orderId, parts] of groups) {
      const target =
        orderId === null
          ? ordersTotal
          : bill.orders.find((order) => order.id === orderId)?.totalIdr;
      add(
        ["splits"],
        `ORD-06: split parts must sum exactly to the ${orderId === null ? "bill" : "order"} total`,
        target === undefined ||
          sum(parts.map((split) => split.amountIdr)) !== target,
      );
      add(
        ["splits"],
        "Split share indexes must be unique and use one method per set",
        new Set(parts.map((split) => split.shareIndex)).size !== parts.length ||
          new Set(parts.map((split) => split.method)).size !== 1,
      );
    }
    for (const split of bill.splits)
      add(
        ["splits"],
        "Every split must belong to the bill's session",
        split.tableSessionId !== bill.sessionId,
      );
  });
export type SessionBill = z.infer<typeof sessionBillSchema>;

export const sessionSplitsResultSchema = z.strictObject({
  bill: sessionBillSchema,
  splits: z.array(billSplitSchema),
});
export type SessionSplitsResult = z.infer<typeof sessionSplitsResultSchema>;

// ---- Service requests (§6.C service_requests, ORD-07) --------------------

export const SERVICE_REQUEST_TYPES = [
  "call_waiter",
  "request_bill",
  "complaint",
] as const;
export const serviceRequestTypeSchema = z.enum(SERVICE_REQUEST_TYPES);
export type ServiceRequestType = z.infer<typeof serviceRequestTypeSchema>;

/** PRD "Panggil Waiter": tambah pesanan, minta alat makan, keluhan. */
export const SERVICE_REQUEST_REASONS = [
  "add_order",
  "utensils",
  "complaint",
  "other",
] as const;
export const serviceRequestReasonSchema = z.enum(SERVICE_REQUEST_REASONS);
export type ServiceRequestReason = z.infer<typeof serviceRequestReasonSchema>;

export const SERVICE_REQUEST_STATUSES = [
  "pending",
  "acknowledged",
  "resolved",
  "cancelled",
] as const;
export const serviceRequestStatusSchema = z.enum(SERVICE_REQUEST_STATUSES);
export type ServiceRequestStatus = z.infer<typeof serviceRequestStatusSchema>;

export const serviceRequestSchema = z
  .strictObject({
    id: serviceRequestIdSchema,
    ...scope,
    tableSessionId: tableSessionIdSchema,
    tableId: tableIdSchema,
    /** Printed table code; legacy payloads may omit it. */
    tableLabel: tableCodeSchema.nullable().default(null),
    zoneId: floorZoneIdSchema,
    type: serviceRequestTypeSchema,
    reason: serviceRequestReasonSchema.nullable(),
    message: z.string().max(500).nullable(),
    status: serviceRequestStatusSchema,
    /** Zone waiter who took the request. */
    assignedTo: userIdSchema.nullable(),
    createdAt: isoDateTimeSchema,
    acknowledgedAt: isoDateTimeSchema.nullable(),
    resolvedAt: isoDateTimeSchema.nullable(),
    /**
     * Staff who resolved it; may differ from `assignedTo`. Absent on rows
     * written before the column existed.
     */
    resolvedBy: userIdSchema.nullable().optional(),
  })
  .superRefine((request, ctx) => {
    const add = (
      path: (string | number)[],
      message: string,
      invalid: boolean,
    ) => {
      if (invalid) ctx.addIssue({ code: "custom", path, message });
    };
    add(
      ["reason"],
      "A waiter call needs a reason",
      request.type === "call_waiter" && request.reason === null,
    );
    add(
      ["reason"],
      "A bill request does not carry a waiter-call reason",
      request.type === "request_bill" && request.reason !== null,
    );
    add(
      ["message"],
      "A complaint needs a short message",
      request.type === "complaint" &&
        (request.message === null || request.message.trim().length < 3),
    );
    add(
      ["acknowledgedAt"],
      "pending requests are not acknowledged yet",
      request.status === "pending" && request.acknowledgedAt !== null,
    );
    add(
      ["acknowledgedAt"],
      "an acknowledged request needs acknowledgedAt and an assignee",
      request.status === "acknowledged" &&
        (request.acknowledgedAt === null || request.assignedTo === null),
    );
    add(
      ["resolvedAt"],
      "a resolved request needs resolvedAt",
      request.status === "resolved" && request.resolvedAt === null,
    );
    add(
      ["resolvedAt"],
      "a cancelled request is not resolved",
      request.status === "cancelled" && request.resolvedAt !== null,
    );
  });
export type ServiceRequest = z.infer<typeof serviceRequestSchema>;

export const SERVICE_REQUEST_ACTIONS = [
  "acknowledge",
  "resolve",
  "cancel",
] as const;
export type ServiceRequestAction = (typeof SERVICE_REQUEST_ACTIONS)[number];

const serviceRequestTransitions: Record<
  ServiceRequestStatus,
  Partial<Record<ServiceRequestAction, ServiceRequestStatus>>
> = {
  pending: {
    acknowledge: "acknowledged",
    resolve: "resolved",
    cancel: "cancelled",
  },
  acknowledged: { resolve: "resolved" },
  resolved: {},
  cancelled: {},
};

export function transitionServiceRequest(
  status: ServiceRequestStatus,
  action: ServiceRequestAction,
): ServiceRequestStatus {
  const next = serviceRequestTransitions[status]?.[action];
  if (!next)
    throw new RangeError(
      `Invalid service request transition: ${status} --${action}-->`,
    );
  return next;
}

export const createServiceRequestInputSchema = clientInputSchema({
  type: serviceRequestTypeSchema,
  reason: serviceRequestReasonSchema.optional(),
  message: z.string().max(500).optional(),
  idempotencyKey: idempotencyKeySchema,
}).superRefine((value, ctx) => {
  if (value.type === "call_waiter" && value.reason === undefined)
    ctx.addIssue({
      code: "custom",
      path: ["reason"],
      message: "A waiter call needs a reason",
    });
  if (value.type === "request_bill" && value.reason !== undefined)
    ctx.addIssue({
      code: "custom",
      path: ["reason"],
      message: "A bill request does not carry a waiter-call reason",
    });
  if (
    value.type === "complaint" &&
    (value.message === undefined || value.message.trim().length < 3)
  )
    ctx.addIssue({
      code: "custom",
      path: ["message"],
      message: "A complaint needs a short message",
    });
});

export const resolveServiceRequestInputSchema = clientInputSchema({
  note: note.optional(),
});

// ---- Failed item recovery (§6.C order_issues, ORD-08, ORD-09) ------------

export const ORDER_ISSUE_TYPES = orderIssueTypeSchema.options;
export type OrderIssueType = z.infer<typeof orderIssueTypeSchema>;

export const ORDER_ISSUE_RESOLUTIONS = orderIssueResolutionSchema.options;
export type OrderIssueResolution = z.infer<typeof orderIssueResolutionSchema>;

/** ORD-08: the customer is offered only a replacement or voucher credit. */
export const CUSTOMER_ORDER_ISSUE_RESOLUTIONS = ["swap", "voucher"] as const;
export const customerOrderIssueResolutionSchema = z.enum(
  CUSTOMER_ORDER_ISSUE_RESOLUTIONS,
);
export type CustomerOrderIssueResolution = z.infer<
  typeof customerOrderIssueResolutionSchema
>;

export type OrderIssueStatus = z.infer<typeof orderIssueStatusSchema>;

// legend-d60m: `orderIssueSchema` is the single `order_issues` record, owned by
// the kitchen contract and re-exported above. The QR recovery lifecycle
// (status, resolvedAt, replacementItemId, priceDifferenceIdr) lives on it.

/**
 * remake and comp need the staff member (`employeeId`), which this input does
 * not carry: guest-facing recovery reports only unfulfillable or complaint.
 */
export const QR_ORDER_ISSUE_INPUT_TYPES = [
  "unfulfillable",
  "complaint",
] as const;

export const createOrderIssueInputSchema = clientInputSchema({
  type: z.enum(QR_ORDER_ISSUE_INPUT_TYPES),
  reason: orderIssueReasonSchema,
  /** Written reason; stored as `order_issues.reasonNote`. */
  reasonNote: z.string().min(1).max(500),
});

export const customerOrderIssueChoiceInputSchema = clientInputSchema({
  choice: customerOrderIssueResolutionSchema,
  replacementItemId: uuidSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.choice === "swap" && value.replacementItemId === undefined)
    ctx.addIssue({
      code: "custom",
      path: ["replacementItemId"],
      message: "A swap needs the replacement menu item",
    });
});

export const staffOrderIssueResolutionInputSchema = clientInputSchema({
  resolution: orderIssueResolutionSchema,
  replacementItemId: uuidSchema.optional(),
  voucherId: apologyVoucherIdSchema.optional(),
  /** WS-01 approval request that authorizes a manual refund (ORD-09). */
  approvalRequestId: uuidSchema.optional(),
  reason: z.string().min(1).max(500).optional(),
}).superRefine((value, ctx) => {
  if (value.resolution === "swap" && value.replacementItemId === undefined)
    ctx.addIssue({
      code: "custom",
      path: ["replacementItemId"],
      message: "A swap needs the replacement menu item",
    });
  if (value.resolution === "voucher" && value.voucherId === undefined)
    ctx.addIssue({
      code: "custom",
      path: ["voucherId"],
      message: "A voucher resolution needs the apology voucher",
    });
  if (value.resolution === "manual_refund") {
    if (value.approvalRequestId === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["approvalRequestId"],
        message: "ORD-09: a manual refund needs an approved approval request",
      });
    if (value.reason === undefined || value.reason.trim().length < 10)
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message:
          "ORD-09: a manual refund needs a written reason of at least 10 characters",
      });
  }
});

export const orderIssueOptionsSchema = z.strictObject({
  issueId: orderIssueIdSchema,
  swap: z.strictObject({
    allowed: z.boolean(),
    suggestedMenuItemIds: z.array(uuidSchema),
  }),
  voucher: z.strictObject({
    allowed: z.boolean(),
    /** Value of the credit, normally the failed item's line total. */
    valueIdr: nonnegativeIdr,
  }),
  /** ORD-08: a refund is never offered to the customer. */
  manualRefundOfferedToCustomer: z.literal(false),
});
export type OrderIssueOptions = z.infer<typeof orderIssueOptionsSchema>;

// ---- Apology voucher (§3 "Voucher Permintaan Maaf") ----------------------

export const APOLOGY_VOUCHER_STATUSES = [
  "issued",
  "redeemed",
  "expired",
  "void",
] as const;
export const apologyVoucherStatusSchema = z.enum(APOLOGY_VOUCHER_STATUSES);
export type ApologyVoucherStatus = z.infer<typeof apologyVoucherStatusSchema>;

export const voucherCodeSchema = z
  .string()
  .regex(/^[A-Z0-9]{3,6}(-[A-Z0-9]{4,6}){1,3}$/, "Expected a voucher code");

export const apologyVoucherSchema = z
  .strictObject({
    id: apologyVoucherIdSchema,
    ...scope,
    code: voucherCodeSchema,
    valueIdr: positiveIdr,
    status: apologyVoucherStatusSchema,
    reason: z.string().min(10).max(500),
    orderIssueId: orderIssueIdSchema.nullable(),
    customerProfileId: uuidSchema.nullable(),
    issuedBy: userIdSchema,
    /** Above the approval matrix threshold, a WS-01 approval is recorded. */
    approvalRequestId: uuidSchema.nullable(),
    issuedAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
    redeemedAt: isoDateTimeSchema.nullable(),
    redemptionOrderId: orderIdSchema.nullable(),
  })
  .superRefine((voucher, ctx) => {
    const add = (
      path: (string | number)[],
      message: string,
      invalid: boolean,
    ) => {
      if (invalid) ctx.addIssue({ code: "custom", path, message });
    };
    add(
      ["expiresAt"],
      "A voucher must expire after it is issued",
      new Date(voucher.expiresAt).getTime() <=
        new Date(voucher.issuedAt).getTime(),
    );
    add(
      ["redeemedAt"],
      "A redeemed voucher needs redeemedAt and redemptionOrderId",
      voucher.status === "redeemed" &&
        (voucher.redeemedAt === null || voucher.redemptionOrderId === null),
    );
    add(
      ["redeemedAt"],
      "Only a redeemed voucher carries redemption fields",
      voucher.status !== "redeemed" &&
        (voucher.redeemedAt !== null || voucher.redemptionOrderId !== null),
    );
  });
export type ApologyVoucher = z.infer<typeof apologyVoucherSchema>;

export const createApologyVoucherInputSchema = clientInputSchema({
  valueIdr: positiveIdr,
  reason: z.string().min(10).max(500),
  orderIssueId: orderIssueIdSchema.optional(),
  customerProfileId: uuidSchema.optional(),
  approvalRequestId: uuidSchema.optional(),
  expiresInDays: z.number().int().min(1).max(90).default(30),
});

/** A voucher is redeemable only while issued and before it expires. */
export function canRedeemVoucher(
  voucher: Pick<ApologyVoucher, "status" | "expiresAt">,
  at: string,
): boolean {
  return (
    voucher.status === "issued" &&
    new Date(voucher.expiresAt).getTime() > new Date(at).getTime()
  );
}

// ---- Post-meal review (§3 "Ulasan Pascamakan") ---------------------------

/** Ratings at or above this value prompt a Google review. */
export const GOOGLE_REVIEW_MIN_RATING = 4;

export const reviewRatingSchema = z.number().int().min(1).max(5);

export const tableReviewSchema = z
  .strictObject({
    id: tableReviewIdSchema,
    ...scope,
    tableSessionId: tableSessionIdSchema,
    participantId: sessionParticipantIdSchema.nullable(),
    rating: reviewRatingSchema,
    comment: z.string().max(1000).nullable(),
    googleReviewPrompt: z.boolean(),
    googleReviewUrl: z.string().min(1).max(500).nullable(),
    submittedAt: isoDateTimeSchema,
  })
  .superRefine((review, ctx) => {
    const expected = review.rating >= GOOGLE_REVIEW_MIN_RATING;
    if (review.googleReviewPrompt !== expected)
      ctx.addIssue({
        code: "custom",
        path: ["googleReviewPrompt"],
        message: `googleReviewPrompt must be ${expected} for a ${review.rating}-star rating`,
      });
    if (review.googleReviewPrompt && review.googleReviewUrl === null)
      ctx.addIssue({
        code: "custom",
        path: ["googleReviewUrl"],
        message: "A Google review prompt needs the tenant's review URL",
      });
  });
export type TableReview = z.infer<typeof tableReviewSchema>;

export function googleReviewPromptFor(rating: number): boolean {
  return rating >= GOOGLE_REVIEW_MIN_RATING;
}

export const submitReviewInputSchema = clientInputSchema({
  rating: reviewRatingSchema,
  comment: z.string().max(1000).optional(),
});

export const reviewEligibilitySchema = z.strictObject({
  sessionId: tableSessionIdSchema,
  eligible: z.boolean(),
  alreadySubmitted: z.boolean(),
  googleReviewUrl: z.string().min(1).max(500).nullable(),
});
export type ReviewEligibility = z.infer<typeof reviewEligibilitySchema>;

// ---- Composite views ------------------------------------------------------

export const tableSessionViewSchema = z
  .strictObject({
    session: tableSessionSchema,
    cart: cartSchema,
    /** Null while the cart is empty. */
    quote: orderQuoteSchema.nullable(),
    orders: z.array(qrOrderSchema),
    openServiceRequests: z.array(serviceRequestSchema),
    /**
     * False while the outlet has an edge node whose cloud link is down: the
     * guest page shows the waiter notice and disables ordering (WS-02,
     * PRD "Pesanan Pelanggan dari Cloud"). Defaults to true (no edge).
     */
    orderingAvailable: z.boolean().default(true),
  })
  .superRefine((view, ctx) => {
    const add = (
      path: (string | number)[],
      message: string,
      invalid: boolean,
    ) => {
      if (invalid) ctx.addIssue({ code: "custom", path, message });
    };
    add(
      ["cart", "sessionId"],
      "The cart must belong to the session",
      view.cart.sessionId !== view.session.id,
    );
    add(
      ["quote", "sessionId"],
      "The quote must belong to the session",
      view.quote !== null && view.quote.sessionId !== view.session.id,
    );
    add(
      ["orders"],
      "Every order must belong to the session",
      view.orders.some((order) => order.tableSessionId !== view.session.id),
    );
    add(
      ["openServiceRequests"],
      "Every service request must belong to the session",
      view.openServiceRequests.some(
        (request) => request.tableSessionId !== view.session.id,
      ),
    );
  });
export type TableSessionView = z.infer<typeof tableSessionViewSchema>;

/** First scan opens the session; later scans join the active one. */
export const qrScanInputSchema = clientInputSchema({
  qrToken: signedQrTokenSchema,
  pax: z.number().int().min(1).max(30),
  deviceHash: z.string().min(8).max(128),
});

export const qrScanOutcomeSchema = z.enum(["opened", "joined"]);
export type QrScanOutcome = z.infer<typeof qrScanOutcomeSchema>;

export const qrScanResultSchema = z
  .strictObject({
    outcome: qrScanOutcomeSchema,
    table: tableSchema,
    zone: floorZoneSchema,
    outlet: outletRefSchema,
    brand: brandRefSchema,
    session: tableSessionSchema,
    /**
     * Opaque guest credential (random, base64url) for this session only. The
     * server stores only its hash (`table_sessions.session_token_hash`), never
     * derives tenant/outlet/table from it, and rotates it when the session
     * closes (PRD "Keamanan Sesi", ORD-04).
     */
    sessionToken: z
      .string()
      .min(20)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/, "Expected an opaque base64url token"),
    /** Hard expiry; the client must rescan after it. At most 12 hours from the
     * session open and never later than close (ORD-04). */
    sessionTokenExpiresAt: isoDateTimeSchema,
    menuUpdatedAt: isoDateTimeSchema,
    soldOutItemIds: z.array(uuidSchema),
    serverTime: isoDateTimeSchema,
  })
  .superRefine((scan, ctx) => {
    const add = (
      path: (string | number)[],
      message: string,
      invalid: boolean,
    ) => {
      if (invalid) ctx.addIssue({ code: "custom", path, message });
    };
    add(
      ["session", "tableId"],
      "The session must be open on the scanned table",
      scan.session.tableId !== scan.table.id,
    );
    add(
      ["table", "zoneId"],
      "The table must be in the scanned zone",
      scan.table.zoneId !== scan.zone.id,
    );
    add(
      ["outlet", "id"],
      "The scan must resolve the table's outlet",
      scan.outlet.id !== scan.table.outletId,
    );
    add(
      ["sessionTokenExpiresAt"],
      "The session token must expire after the server time",
      new Date(scan.sessionTokenExpiresAt).getTime() <=
        new Date(scan.serverTime).getTime(),
    );
    add(
      ["sessionTokenExpiresAt"],
      "ORD-04: a session token never outlives 12 hours from the session open",
      new Date(scan.sessionTokenExpiresAt).getTime() >
        new Date(scan.session.openedAt).getTime() +
          TABLE_SESSION_TOKEN_MAX_HOURS * 60 * 60 * 1_000,
    );
    add(
      ["sessionTokenExpiresAt"],
      "ORD-04: a session token never outlives the bill close",
      scan.session.closedAt !== null &&
        new Date(scan.sessionTokenExpiresAt).getTime() >
          new Date(scan.session.closedAt).getTime(),
    );
    add(
      ["session", "status"],
      "ORD-04: a scan never returns a closed or voided session",
      scan.session.status === "closed" || scan.session.status === "voided",
    );
  });
export type QrScanResult = z.infer<typeof qrScanResultSchema>;

export const tableSessionSummarySchema = z.strictObject({
  id: tableSessionIdSchema,
  status: tableSessionStatusSchema,
  pax: z.number().int().min(1).max(30),
  paymentMode: paymentModeSchema,
  openedAt: isoDateTimeSchema,
  lastActivityAt: isoDateTimeSchema,
  billTotalIdr: nonnegativeIdr,
});
export type TableSessionSummary = z.infer<typeof tableSessionSummarySchema>;

/** Service-only link: 2+ tables grouped, bills stay separate. */
export const tableLinkGroupRefSchema = z.strictObject({
  id: tableLinkGroupIdSchema,
  tableIds: z.array(tableIdSchema).min(2),
});
export type TableLinkGroupRef = z.infer<typeof tableLinkGroupRefSchema>;

/**
 * A reservation still holds this unseated table. Time and party size only: no
 * name, contact or note, so a floor reader without `reservation.view` sees it
 * (1268 W4 review no. 2).
 */
export const tableReservationHoldSchema = z.strictObject({
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema,
  pax: z.number().int().positive(),
});
export type TableReservationHold = z.infer<typeof tableReservationHoldSchema>;

export const tableLiveStatusSchema = z
  .strictObject({
    table: tableSchema,
    session: tableSessionSummarySchema.nullable(),
    reservationHold: tableReservationHoldSchema.nullable().optional(),
    linkGroup: tableLinkGroupRefSchema.nullable().optional(),
    openServiceRequestCount: z.number().int().nonnegative(),
    outstandingIdr: nonnegativeIdr,
  })
  .refine((status) => status.session !== null || status.outstandingIdr === 0, {
    message: "A table without a session has nothing outstanding",
    path: ["outstandingIdr"],
  });
export type TableLiveStatus = z.infer<typeof tableLiveStatusSchema>;

export const floorBoardSchema = z.strictObject({
  outletId: outletIdSchema,
  zones: z.array(floorZoneSchema),
  tables: z.array(tableLiveStatusSchema),
  generatedAt: isoDateTimeSchema,
});
export type FloorBoard = z.infer<typeof floorBoardSchema>;

export const closeTableSessionInputSchema = clientInputSchema({
  tableCleaned: z.boolean(),
  /** Supervisor override; ORD-10 still records who confirmed. */
  waiterConfirmedEmpty: z.boolean().default(false),
  note: note.optional(),
});

/**
 * Staff seats a walk-in party at an empty table (POS B1, brief 1268). The
 * key makes a retry (lost answer, second tap) return the same session.
 */
export const openStaffSessionInputSchema = clientInputSchema({
  pax: z.number().int().min(1).max(30),
  idempotencyKey: idempotencyKeySchema,
});

// ---- Types ----------------------------------------------------------------

export type FloorZoneId = z.infer<typeof floorZoneIdSchema>;
export type TableId = z.infer<typeof tableIdSchema>;
export type TableSessionId = z.infer<typeof tableSessionIdSchema>;
export type TableLinkGroupId = z.infer<typeof tableLinkGroupIdSchema>;
export type SessionParticipantId = z.infer<typeof sessionParticipantIdSchema>;
export type CartLineId = z.infer<typeof cartLineIdSchema>;
export type BillSplitId = z.infer<typeof billSplitIdSchema>;
export type ServiceRequestId = z.infer<typeof serviceRequestIdSchema>;
export type OrderIssueId = z.infer<typeof orderIssueIdSchema>;
export type ApologyVoucherId = z.infer<typeof apologyVoucherIdSchema>;
export type TableReviewId = z.infer<typeof tableReviewIdSchema>;
export type OrderId = z.infer<typeof orderIdSchema>;
export type OrderItemId = z.infer<typeof orderItemIdSchema>;
