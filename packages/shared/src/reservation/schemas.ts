// Reservation, waitlist and event pre-order contracts (PRD v1.7 §3 F19 and
// §3.22 "Reservasi & Event", §6.G `reservations` and `waitlist_entries`).
// Acceptance criteria RSV-01 (no overlapping table slots), RSV-02 (a paid DP is
// a deposit allocated to the bill when the guest arrives) and RSV-03 (a
// cancellation follows the policy captured when the reservation was made).
//
// Conventions (docs/plan/contracts.md):
// - ids are UUIDs (reservations, waitlist entries, packages, pre-orders); the
//   pre-order's kitchen order follows the WS-04 order contract (ULID).
// - money is whole rupiah (`*Idr`); DP amount, minimum spend and pre-order
//   subtotal are server-computed and never come from the client.
// - guest contact is write-only: the API receives `contactPhone` once and
//   stores/returns only its keyed digest `contactHash` (`hashGuestContact`:
//   HMAC-SHA-256 with a server secret, never a bare SHA-256 — the Indonesian
//   mobile number space is small enough to brute-force), so list and detail
//   payloads never leak a phone number.
// - menu prices exclude tax and service charge (owner decision, 1 Nov 2026);
//   the pre-order subtotal is therefore net and tax is applied at checkout.

import {
  z,
  uuidSchema,
  tenantIdSchema,
  outletIdSchema,
  uuidIdSchema,
  idrSchema,
  isoDateTimeSchema,
  businessDateSchema,
  timeZoneSchema,
  clientInputSchema,
} from "../core/index.ts";
import {
  normalizeWhatsAppNumber,
  whatsAppNumberDigest,
} from "../identity/index.ts";
import { orderIdSchema } from "../kitchen/schemas.ts";
import {
  floorZoneIdSchema,
  tableIdSchema,
  tableSessionIdSchema,
} from "../qr-order/schemas.ts";
import { paymentStatusSchema } from "../payment/index.ts";
import { channelSchema } from "../menu/schemas.ts";

const name = z.string().min(1).max(150);
const note300 = z.string().max(300);
const nonnegativeIdr = idrSchema.refine((value) => value >= 0);
const positiveIdr = idrSchema.refine((value) => value > 0);
const safeInt = (value: number) => Number.isSafeInteger(value);
const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
/** HMAC-SHA-256 hex digest produced by `hashGuestContact`. */
const contactDigestSchema = sha256HexSchema;
/**
 * WhatsApp number as digits in international form without `+` (AUTH-02 uses the
 * same shape: `628…`). Accepted only on the way in; the API stores its hash.
 */
const phoneDigitsSchema = z
  .string()
  .max(32)
  .transform((value, ctx) => {
    // One normalizer for every stored WhatsApp number (identity contract):
    // "0812…", "+62 812-…" and "62812…" all become "62812…".
    const digits = normalizeWhatsAppNumber(value);
    if (digits === null) {
      ctx.addIssue({
        code: "custom",
        message:
          "Phone numbers are WhatsApp numbers, e.g. 6281234567890 or 081234567890",
      });
      return z.NEVER;
    }
    return digits;
  });

/**
 * `contactHash` for a reservation or waitlist entry: exactly
 * `identity.whatsAppNumberDigest` (HMAC-SHA-256 of the normalized number with a
 * server secret of at least 16 characters; never a bare SHA-256). Use the same
 * secret as the identity digest so a guest's reservation links to their
 * verified WhatsApp identity and customer profile.
 */
export async function hashGuestContact(
  phone: string,
  secret: string,
): Promise<string> {
  return whatsAppNumberDigest(phone, secret);
}

const scope = { tenantId: tenantIdSchema, outletId: outletIdSchema };

// ---- Ids ------------------------------------------------------------------

export const reservationIdSchema = uuidIdSchema<"ReservationId">();
export const reservationPackageIdSchema =
  uuidIdSchema<"ReservationPackageId">();
export const reservationPreOrderIdSchema =
  uuidIdSchema<"ReservationPreOrderId">();
export const waitlistEntryIdSchema = uuidIdSchema<"WaitlistEntryId">();
/** Rows of the planned `reservation_table_slots` join table (RSV-01). */
export const reservationTableSlotIdSchema =
  uuidIdSchema<"ReservationTableSlotId">();

// ---- Status machine values (§6.G reservations.status) ---------------------

export const RESERVATION_STATUSES = [
  "pending_deposit",
  "confirmed",
  "seated",
  "completed",
  "cancelled",
  "no_show",
] as const;
export const reservationStatusSchema = z.enum(RESERVATION_STATUSES);
export type ReservationStatus = z.infer<typeof reservationStatusSchema>;

export const RESERVATION_SOURCES = ["website", "staff", "whatsapp"] as const;
export const reservationSourceSchema = z.enum(RESERVATION_SOURCES);
export type ReservationSource = z.infer<typeof reservationSourceSchema>;

// ---- Policy snapshot (§6.G reservations.policy_snapshot, RSV-03) ----------

export const DEPOSIT_REQUIREMENTS = ["none", "required", "optional"] as const;
export const depositRequirementSchema = z.enum(DEPOSIT_REQUIREMENTS);
export type DepositRequirement = z.infer<typeof depositRequirementSchema>;

/**
 * The rules that applied when the reservation was created, frozen into
 * `reservations.policy_snapshot` (RSV-03). Later configuration changes must
 * never rewrite this object: cancellation and no-show outcomes are computed
 * from the snapshot, not from the current policy.
 */
export const reservationPolicySnapshotSchema = z
  .strictObject({
    /** Version label of the outlet policy this snapshot came from. */
    version: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,39}$/),
    depositRequirement: depositRequirementSchema,
    /** DP per reservation in whole rupiah; 0 when no DP applies. */
    depositAmountIdr: nonnegativeIdr,
    /** How long the DP payment link stays valid (minutes). */
    paymentWindowMinutes: z.number().int().min(5).max(1440),
    /** Cancel at least this many hours before `reservedFor` for a full DP refund. */
    freeCancellationHours: z.number().int().min(0).max(720),
    /** DP refund inside the free window, basis points of the paid DP. */
    lateCancellationRefundBp: z.number().int().min(0).max(10_000),
    /** DP refund when the guest never arrives, basis points of the paid DP. */
    noShowRefundBp: z.number().int().min(0).max(10_000),
    /** Private-room minimum spend; 0 when the zone has none (§3.22 DP & Kebijakan). */
    minimumSpendIdr: nonnegativeIdr,
    /** The instant this snapshot was frozen; shown on the guest's confirmation. */
    capturedAt: isoDateTimeSchema,
  })
  .superRefine((policy, ctx) => {
    if (policy.depositRequirement === "none" && policy.depositAmountIdr !== 0)
      ctx.addIssue({
        code: "custom",
        path: ["depositAmountIdr"],
        message: "A reservation without DP carries a zero deposit",
      });
    if (
      policy.depositRequirement === "required" &&
      policy.depositAmountIdr <= 0
    )
      ctx.addIssue({
        code: "custom",
        path: ["depositAmountIdr"],
        message: "A required DP must be above zero",
      });
  });
export type ReservationPolicySnapshot = z.infer<
  typeof reservationPolicySnapshotSchema
>;

// ---- Reservation (§6.G reservations) --------------------------------------

export const reservationSchema = z
  .strictObject({
    id: reservationIdSchema,
    ...scope,
    /** Member link when the guest booked while signed in; null for guests. */
    customerProfileId: uuidSchema.nullable(),
    /** Display name the guest or host entered; the only personal data on the wire. */
    guestName: name,
    /** `hashGuestContact` digest of the WhatsApp number. Never the number itself. */
    contactHash: contactDigestSchema.nullable(),
    reservedFor: isoDateTimeSchema,
    durationMinutes: z.number().int().min(15).max(720),
    pax: z.number().int().min(1).max(60),
    zoneId: floorZoneIdSchema.nullable(),
    tableIds: z.array(tableIdSchema),
    depositIdr: nonnegativeIdr,
    /**
     * `payment_intents.id` of the settled DP (WS-05). The guest pays through a
     * bill link and creates the intent on the hosted page, so this stays null
     * until an intent on the DP link is paid, and when no DP applies.
     */
    depositPaymentId: uuidSchema.nullable(),
    /**
     * Derived from WS-05, never written by this domain: the settled intent's
     * status once `depositPaymentId` is set; while the DP is still awaited it
     * is `pending` (or `expired` once the link's window passed); null when no
     * DP applies or nothing was paid before the reservation closed.
     */
    depositStatus: paymentStatusSchema.nullable(),
    policy: reservationPolicySnapshotSchema,
    status: reservationStatusSchema,
    note: note300.nullable(),
    source: reservationSourceSchema,
    /** Derived from the reservation events, not stored columns. */
    seatedAt: isoDateTimeSchema.nullable(),
    completedAt: isoDateTimeSchema.nullable(),
    /** Set when the reservation left the active flow as `cancelled` or `no_show`. */
    closedAt: isoDateTimeSchema.nullable(),
    closeReason: note300.nullable(),
    /** Table session opened for this reservation when the guest was seated. */
    tableSessionId: tableSessionIdSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .superRefine((reservation, ctx) => {
    if (new Set(reservation.tableIds).size !== reservation.tableIds.length)
      ctx.addIssue({
        code: "custom",
        path: ["tableIds"],
        message: "A table can be assigned once",
      });
    // A settled DP always reports its status; an awaited DP has a status but
    // no intent yet (the guest has not paid through the link).
    if (
      reservation.depositPaymentId !== null &&
      reservation.depositStatus === null
    )
      ctx.addIssue({
        code: "custom",
        path: ["depositStatus"],
        message: "A DP payment id always comes with its status",
      });
    if (
      reservation.depositIdr === 0 &&
      (reservation.depositPaymentId !== null ||
        reservation.depositStatus !== null)
    )
      ctx.addIssue({
        code: "custom",
        path: ["depositPaymentId"],
        message: "A zero DP has no payment intent",
      });
    // The DP amount comes from the policy snapshot, never from elsewhere.
    if (
      reservation.policy.depositRequirement === "required" &&
      reservation.depositIdr !== reservation.policy.depositAmountIdr
    )
      ctx.addIssue({
        code: "custom",
        path: ["depositIdr"],
        message: "A required DP equals the snapshot's DP amount (RSV-02)",
      });
    if (
      reservation.policy.depositRequirement === "none" &&
      reservation.depositIdr !== 0
    )
      ctx.addIssue({
        code: "custom",
        path: ["depositIdr"],
        message: "A reservation without DP carries a zero deposit",
      });
    if (
      reservation.policy.depositRequirement === "optional" &&
      reservation.depositIdr !== 0 &&
      reservation.depositIdr !== reservation.policy.depositAmountIdr
    )
      ctx.addIssue({
        code: "custom",
        path: ["depositIdr"],
        message: "An optional DP is either zero or the snapshot's DP amount",
      });
    // RSV-02: a reservation waiting for its DP is the only state with an
    // unpaid DP, and it must carry the DP amount and the DP's status.
    if (
      reservation.status === "pending_deposit" &&
      (reservation.depositIdr === 0 || reservation.depositStatus === null)
    )
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "pending_deposit needs a DP amount and its status (RSV-02)",
      });
    // A required DP must be settled before the reservation is confirmed, and
    // stays settled once the guest is seated (same rule as `depositIsSettled`).
    // A later WS-05 refund of that settled DP (`refunded`) keeps it valid: it
    // was paid when the reservation moved on.
    if (
      (reservation.status === "confirmed" ||
        reservation.status === "seated" ||
        reservation.status === "completed") &&
      reservation.policy.depositRequirement === "required" &&
      reservation.depositStatus !== "paid" &&
      reservation.depositStatus !== "partially_refunded" &&
      reservation.depositStatus !== "refunded"
    )
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "A confirmed reservation has its required DP paid (RSV-02)",
      });
    if (
      (reservation.status === "seated" || reservation.status === "completed") &&
      (reservation.seatedAt === null || reservation.tableSessionId === null)
    )
      ctx.addIssue({
        code: "custom",
        path: ["seatedAt"],
        message: "A seated reservation names its session and seating instant",
      });
    if (reservation.status === "completed" && reservation.completedAt === null)
      ctx.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "A completed reservation records when it completed",
      });
    const closed =
      reservation.status === "cancelled" || reservation.status === "no_show";
    if (closed && reservation.closedAt === null)
      ctx.addIssue({
        code: "custom",
        path: ["closedAt"],
        message: "A cancelled or no-show reservation records when it closed",
      });
    if (!closed && reservation.closedAt !== null)
      ctx.addIssue({
        code: "custom",
        path: ["closedAt"],
        message: "Only a cancelled or no-show reservation has a close instant",
      });
  });
export type Reservation = z.infer<typeof reservationSchema>;

/**
 * The DP payment link returned to the guest when the reservation is created
 * (and on an idempotent replay). The DP is a WS-05 bill link: the guest opens
 * the hosted payment page and picks a method there, which creates the intent.
 */
export const reservationDepositLinkSchema = z.strictObject({
  /** `payment_links.id` (WS-05) of the DP bill. */
  paymentLinkId: uuidSchema,
  amountIdr: positiveIdr,
  /**
   * App-local path of the hosted payment page (`/bayar/<token>`), served by
   * the same web app as the booking page; the token is the guest credential.
   */
  paymentPath: z
    .string()
    .max(300)
    .regex(/^\/bayar\/[A-Za-z0-9._-]+$/, "Expected the hosted payment path"),
  expiresAt: isoDateTimeSchema,
});
export type ReservationDepositLink = z.infer<
  typeof reservationDepositLinkSchema
>;

export const reservationCreatedSchema = z.strictObject({
  reservation: reservationSchema,
  /** Null when the snapshot requires no DP. */
  deposit: reservationDepositLinkSchema.nullable(),
});
export type ReservationCreated = z.infer<typeof reservationCreatedSchema>;

// ---- Requests -------------------------------------------------------------

/**
 * Public reservation form: date/time, pax, zone and note (PRD §3.22 "Reservasi
 * Online"), plus the guest's name and WhatsApp number for the reminder. The
 * server derives tenant, outlet, DP amount, policy snapshot and status.
 */
export const createReservationInputSchema = clientInputSchema({
  reservedFor: isoDateTimeSchema,
  /** Reserved length; the outlet default applies when omitted. */
  durationMinutes: z.number().int().min(15).max(720).optional(),
  pax: z.number().int().min(1).max(60),
  zoneId: floorZoneIdSchema.nullable().optional(),
  guestName: name,
  contactPhone: phoneDigitsSchema,
  note: note300.nullable().optional(),
  /** Optional event pre-order package for groups (PRD §3.22 "Pre-order Event"). */
  preOrderPackageId: reservationPackageIdSchema.nullable().optional(),
});
export type CreateReservationInput = z.infer<
  typeof createReservationInputSchema
>;

/** Availability search from the website form (RSV-01). */
export const reservationAvailabilityQuerySchema = clientInputSchema({
  date: businessDateSchema,
  pax: z.coerce.number().int().min(1).max(60),
  zoneId: floorZoneIdSchema.optional(),
  durationMinutes: z.coerce.number().int().min(15).max(720).optional(),
});
export type ReservationAvailabilityQuery = z.infer<
  typeof reservationAvailabilityQuerySchema
>;

/** One bookable start time and the tables free for the whole slot (RSV-01). */
export const reservationAvailabilitySlotSchema = z.strictObject({
  startsAt: isoDateTimeSchema,
  tableIds: z.array(tableIdSchema),
  /** Total seats of the free tables in the slot. */
  seatsAvailable: z.number().int().nonnegative(),
});
export type ReservationAvailabilitySlot = z.infer<
  typeof reservationAvailabilitySlotSchema
>;

export const reservationAvailabilitySchema = z.strictObject({
  date: businessDateSchema,
  timeZone: timeZoneSchema,
  durationMinutes: z.number().int().min(15).max(720),
  pax: z.number().int().min(1).max(60),
  zoneId: floorZoneIdSchema.nullable(),
  slots: z.array(reservationAvailabilitySlotSchema),
});
export type ReservationAvailability = z.infer<
  typeof reservationAvailabilitySchema
>;

/** Staff list query: one business date (or all upcoming), status and zone. */
export const listReservationsQuerySchema = z.strictObject({
  date: businessDateSchema.optional(),
  status: reservationStatusSchema.optional(),
  zoneId: floorZoneIdSchema.optional(),
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListReservationsQuery = z.infer<typeof listReservationsQuerySchema>;

/** Staff table assignment on the floor plan (§3.22 "Penugasan Meja"). */
export const assignReservationTablesInputSchema = clientInputSchema({
  tableIds: z.array(tableIdSchema).min(1).max(10),
});
export type AssignReservationTablesInput = z.infer<
  typeof assignReservationTablesInputSchema
>;

/** Host seats the party; the server opens the table session (QR order contract). */
export const seatReservationInputSchema = clientInputSchema({
  tableIds: z.array(tableIdSchema).min(1).max(10),
});
export type SeatReservationInput = z.infer<typeof seatReservationInputSchema>;

export const seatReservationResultSchema = z.strictObject({
  reservation: reservationSchema,
  tableSessionId: tableSessionIdSchema,
});
export type SeatReservationResult = z.infer<typeof seatReservationResultSchema>;

export const cancelReservationInputSchema = clientInputSchema({
  reason: z.string().min(1).max(300),
});
export type CancelReservationInput = z.infer<
  typeof cancelReservationInputSchema
>;

export const markNoShowInputSchema = clientInputSchema({
  note: note300.optional(),
});
export type MarkNoShowInput = z.infer<typeof markNoShowInputSchema>;

/**
 * Staff resend of the DP link: no fields, the server reuses the stored link or
 * opens a new one inside the frozen payment window.
 */
export const resendDepositLinkInputSchema = clientInputSchema({});
export type ResendDepositLinkInput = z.infer<
  typeof resendDepositLinkInputSchema
>;

// ---- Table slots (RSV-01) -------------------------------------------------

/**
 * One reserved table interval, half-open `[startsAt, endsAt)`. The BE bead
 * stores these rows in a join table with a `tstzrange` exclusion constraint
 * (BREAKDOWN W30: `reservations.table_ids UUID[]` has no FK integrity); the
 * contract keeps the same bound convention so the API, the migration and the
 * availability query cannot disagree.
 */
export const reservationTableSlotSchema = z
  .strictObject({
    id: reservationTableSlotIdSchema,
    ...scope,
    reservationId: reservationIdSchema,
    tableId: tableIdSchema,
    startsAt: isoDateTimeSchema,
    /** Half-open upper bound: a slot ending exactly when the next starts is free. */
    endsAt: isoDateTimeSchema,
    /** Released slots stay as history but stop blocking (cancelled / no-show). */
    releasedAt: isoDateTimeSchema.nullable(),
  })
  .refine((slot) => Date.parse(slot.endsAt) > Date.parse(slot.startsAt), {
    path: ["endsAt"],
    message: "endsAt must be after startsAt",
  });
export type ReservationTableSlot = z.infer<typeof reservationTableSlotSchema>;

// ---- Waitlist (§6.G waitlist_entries, §3.22 "Waitlist Walk-in") -----------

export const WAITLIST_STATUSES = [
  "waiting",
  "called",
  "seated",
  "left",
  "cancelled",
] as const;
export const waitlistStatusSchema = z.enum(WAITLIST_STATUSES);
export type WaitlistStatus = z.infer<typeof waitlistStatusSchema>;

export const waitlistEntrySchema = z
  .strictObject({
    id: waitlistEntryIdSchema,
    ...scope,
    name,
    pax: z.number().int().min(1).max(60),
    /** SHA-256 of the WhatsApp number; never the number itself. */
    contactHash: contactDigestSchema,
    zoneId: floorZoneIdSchema.nullable(),
    status: waitlistStatusSchema,
    joinedAt: isoDateTimeSchema,
    calledAt: isoDateTimeSchema.nullable(),
    seatedAt: isoDateTimeSchema.nullable(),
    leftAt: isoDateTimeSchema.nullable(),
    /** Server estimate quoted at join/call time; null once the guest sits or leaves. */
    estimatedWaitMinutes: z
      .number()
      .int()
      .refine(safeInt)
      .min(0)
      .max(600)
      .nullable(),
  })
  .superRefine((entry, ctx) => {
    if (entry.status === "called" && entry.calledAt === null)
      ctx.addIssue({
        code: "custom",
        path: ["calledAt"],
        message: "A called entry records when it was called",
      });
    if (entry.status === "seated" && entry.seatedAt === null)
      ctx.addIssue({
        code: "custom",
        path: ["seatedAt"],
        message: "A seated entry records when it was seated",
      });
    if (entry.status === "left" && entry.leftAt === null)
      ctx.addIssue({
        code: "custom",
        path: ["leftAt"],
        message: "A left entry records when the guest left",
      });
  });
export type WaitlistEntry = z.infer<typeof waitlistEntrySchema>;

export const joinWaitlistInputSchema = clientInputSchema({
  name,
  pax: z.number().int().min(1).max(60),
  contactPhone: phoneDigitsSchema,
  zoneId: floorZoneIdSchema.nullable().optional(),
});
export type JoinWaitlistInput = z.infer<typeof joinWaitlistInputSchema>;

export const joinWaitlistResultSchema = z.strictObject({
  entry: waitlistEntrySchema,
  /** Browser notification text is built by the FE from i18n, not the API. */
  estimatedWaitMinutes: z.number().int().min(0).max(600),
});
export type JoinWaitlistResult = z.infer<typeof joinWaitlistResultSchema>;

/** Close a waitlist entry: seat it (opens a session) or release it. */
export const resolveWaitlistEntryInputSchema = clientInputSchema({
  resolution: z.enum(["seated", "left", "cancelled"]),
  /** Required for `seated`; the tables the party takes. */
  tableIds: z.array(tableIdSchema).min(1).max(10).optional(),
})
  .refine(
    (input) =>
      input.resolution !== "seated" ||
      (input.tableIds !== undefined && input.tableIds.length > 0),
    {
      path: ["tableIds"],
      message: "Seating a waitlist entry needs at least one table",
    },
  )
  .refine(
    (input) => input.resolution === "seated" || input.tableIds === undefined,
    {
      path: ["tableIds"],
      message: "Only a seated resolution takes tables",
    },
  );
export type ResolveWaitlistEntryInput = z.infer<
  typeof resolveWaitlistEntryInputSchema
>;

export const resolveWaitlistEntryResultSchema = z.strictObject({
  entry: waitlistEntrySchema,
  /** Null unless the entry was seated. */
  tableSessionId: tableSessionIdSchema.nullable(),
});
export type ResolveWaitlistEntryResult = z.infer<
  typeof resolveWaitlistEntryResultSchema
>;

// ---- Event pre-order (§3.22 "Pre-order Event") ----------------------------

/** A menu package for events and groups, ordered before the reservation day. */
export const reservationPackageSchema = z
  .strictObject({
    id: reservationPackageIdSchema,
    ...scope,
    name,
    description: z.string().max(500),
    minPax: z.number().int().min(1).max(60),
    maxPax: z.number().int().min(1).max(200),
    /** Price per person; menu prices exclude tax and service (owner decision). */
    pricePerPaxIdr: positiveIdr,
    /** Composition for one person; the server multiplies by pax. */
    items: z
      .array(
        z.strictObject({
          menuItemId: uuidSchema,
          quantity: z.number().int().min(1).max(20),
        }),
      )
      .min(1),
    /** Ordered at least this many hours before `reservedFor` (PRD "sebelum hari H"). */
    leadTimeHours: z.number().int().min(1).max(336),
    status: z.enum(["active", "inactive"]),
    sortOrder: z.number().int().min(0),
  })
  .refine((pack) => pack.maxPax >= pack.minPax, {
    path: ["maxPax"],
    message: "maxPax must be at least minPax",
  });
export type ReservationPackage = z.infer<typeof reservationPackageSchema>;

/**
 * Composition snapshot: the package's menu items per person, frozen when the
 * guest orders. Money lives on the package price, not on the items; the
 * kitchen order (channel `reservation`) expands them on the event day.
 */
export const reservationPreOrderItemSchema = z.strictObject({
  menuItemId: uuidSchema,
  name,
  quantityPerPax: z.number().int().min(1).max(20),
});
export type ReservationPreOrderItem = z.infer<
  typeof reservationPreOrderItemSchema
>;

export const PRE_ORDER_STATUSES = [
  "draft",
  "confirmed",
  "preparing",
  "served",
  "cancelled",
] as const;
export const preOrderStatusSchema = z.enum(PRE_ORDER_STATUSES);
export type PreOrderStatus = z.infer<typeof preOrderStatusSchema>;

export const reservationPreOrderSchema = z
  .strictObject({
    id: reservationPreOrderIdSchema,
    ...scope,
    reservationId: reservationIdSchema,
    packageId: reservationPackageIdSchema,
    packageName: name,
    pax: z.number().int().min(1).max(60),
    items: z.array(reservationPreOrderItemSchema).min(1),
    /** Package price per person frozen at order time. */
    pricePerPaxIdr: positiveIdr,
    /** Net subtotal before tax and service charge (owner decision). */
    subtotalIdr: nonnegativeIdr,
    status: preOrderStatusSchema,
    /** Kitchen order created for the event; channel `reservation` (WS-04). */
    orderId: orderIdSchema.nullable(),
    createdAt: isoDateTimeSchema,
  })
  .superRefine((preOrder, ctx) => {
    if (preOrder.pricePerPaxIdr * preOrder.pax !== preOrder.subtotalIdr)
      ctx.addIssue({
        code: "custom",
        path: ["subtotalIdr"],
        message: "The pre-order subtotal is pax × price per pax",
      });
    // A pre-order that reached the kitchen names its order.
    if (
      (preOrder.status === "preparing" || preOrder.status === "served") &&
      preOrder.orderId === null
    )
      ctx.addIssue({
        code: "custom",
        path: ["orderId"],
        message: "A preparing or served pre-order names its kitchen order",
      });
  });
export type ReservationPreOrder = z.infer<typeof reservationPreOrderSchema>;

/** Attach or change the pre-order after the reservation exists. */
export const placePreOrderInputSchema = clientInputSchema({
  packageId: reservationPackageIdSchema,
});
export type PlacePreOrderInput = z.infer<typeof placePreOrderInputSchema>;

/** The channel an event pre-order uses on the shared order path (PRD §6 orders.channel). */
export const RESERVATION_ORDER_CHANNEL = "reservation" as const;
export const reservationOrderChannelSchema = channelSchema.extract([
  "reservation",
]);
export type ReservationOrderChannel = z.infer<
  typeof reservationOrderChannelSchema
>;

export const DEPOSIT_OUTCOMES = [
  "nothing_paid",
  "refund_full",
  "refund_partial",
  "no_refund",
] as const;
export type DepositOutcomeKind = (typeof DEPOSIT_OUTCOMES)[number];

/**
 * What happens to the DP under the snapshot. `refundIdr + forfeitedIdr` equals
 * the DP that was actually paid; the refund itself is a WS-05 payment action.
 */
export const reservationDepositOutcomeSchema = z
  .strictObject({
    resolution: z.enum(DEPOSIT_OUTCOMES),
    refundIdr: nonnegativeIdr,
    forfeitedIdr: nonnegativeIdr,
    /** Snapshot version used, so a support agent can audit the decision. */
    policyVersion: z.string().min(1).max(40),
  })
  .superRefine((outcome, ctx) => {
    if (
      outcome.resolution === "nothing_paid" &&
      outcome.refundIdr + outcome.forfeitedIdr !== 0
    )
      ctx.addIssue({
        code: "custom",
        path: ["resolution"],
        message: "Nothing paid means nothing to refund or forfeit",
      });
    if (outcome.resolution === "refund_full" && outcome.forfeitedIdr !== 0)
      ctx.addIssue({
        code: "custom",
        path: ["forfeitedIdr"],
        message: "A full refund forfeits nothing",
      });
    if (outcome.resolution === "no_refund" && outcome.refundIdr !== 0)
      ctx.addIssue({
        code: "custom",
        path: ["refundIdr"],
        message: "No refund refunds nothing",
      });
  });
export type ReservationDepositOutcome = z.infer<
  typeof reservationDepositOutcomeSchema
>;

/** Detail payload: the reservation plus its pre-order and table slots. */
export const reservationDetailSchema = z.strictObject({
  reservation: reservationSchema,
  preOrder: reservationPreOrderSchema.nullable(),
  tableSlots: z.array(reservationTableSlotSchema),
});
export type ReservationDetail = z.infer<typeof reservationDetailSchema>;

/**
 * Staff cancellation / no-show result: the closed reservation plus what the
 * snapshot says happens to the DP (RSV-03). The refund itself is a WS-05
 * payment action; this payload tells the host and the guest what to expect.
 */
export const reservationCloseResultSchema = z.strictObject({
  reservation: reservationSchema,
  depositOutcome: reservationDepositOutcomeSchema,
});
export type ReservationCloseResult = z.infer<
  typeof reservationCloseResultSchema
>;
