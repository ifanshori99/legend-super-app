// Wire DTOs for facility access and WFC (PRD v1.7 §3 F22/F23/F39, §6 K).
// One strict schema per table/aggregate the API exchanges; request bodies live
// in `inputs.ts`, HTTP contracts in `endpoints.ts`.
//
// Conventions (docs/plan/contracts.md): money is whole rupiah (`…Idr`, BIGINT),
// ids are branded (see `ids.ts`), instants are ISO 8601 with offset, business
// dates are `YYYY-MM-DD` in the outlet time zone, and a tenant/outlet field is
// data — the server resolves them from the domain or token (TEN-02).
//
// FAC-09: nothing in this contract stores a customer's gender. The area a guest
// picked (Area Pria / Area Wanita) is recorded on the ticket only, as
// `accessTickets.areaId`; the customer profile contract has no such field and
// this domain never asks for one.

import {
  z,
  businessDateSchema,
  idrSchema,
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
  timeOfDaySchema,
  ulidSchema,
  uuidSchema,
} from "../core/index.ts";
import { facilityHoursSchema, minutesOfDay } from "./slots.ts";
import {
  accessEventIdSchema,
  accessTicketIdSchema,
  cleaningTaskIdSchema,
  entitlementLedgerIdSchema,
  entitlementRuleIdSchema,
  facilityAddonIdSchema,
  facilityAreaIdSchema,
  facilityIdSchema,
  facilityIncidentIdSchema,
  facilityLinkedOrderIdSchema,
  facilityProductIdSchema,
  facilityQueueEntryIdSchema,
  facilitySubscriptionIdSchema,
  facilityUnitIdSchema,
  lockCredentialIdSchema,
  subscriptionInvoiceIdSchema,
  subscriptionPlanIdSchema,
  wifiPolicyIdSchema,
  wifiSessionIdSchema,
} from "./ids.ts";

/** Name of one facility, area, unit, product or add-on (VARCHAR 150). */
const nameSchema = z.string().trim().min(1).max(150);
/** One short label, e.g. a unit code such as `P1` (VARCHAR 20). */
const codeSchema = z.string().trim().min(1).max(20);
/**
 * SHA-256 hex digest of a door credential. The ticket stores only digests:
 * the 6-digit PIN and the QR token are shown once at issue and never stored,
 * logged, audited or put in an event (PRD §3 F22 Tiket Akses; adapters rule
 * "lock credentials are secrets").
 */
export const credentialDigestSchema = z
  .string()
  .regex(
    /^[0-9a-f]{64}$/,
    "Expected a lowercase SHA-256 hex digest (never the plaintext credential)",
  );
const nonnegativeIdr = idrSchema.refine((value) => value >= 0);
const positiveIdr = idrSchema.refine((value) => value > 0);
const minuteCount = z.number().int().min(0).max(1440);
const scope = { tenantId: tenantIdSchema, outletId: outletIdSchema };

// ---- Facility configuration (PRD §6 K facilities / facility_areas / units) --

/** The first use is showers; the model stays generic for lockers, meeting rooms and co-working. */
export const facilityTypeSchema = z.enum([
  "shower",
  "locker",
  "meeting_room",
  "coworking",
]);
export type FacilityType = z.infer<typeof facilityTypeSchema>;

/**
 * Overtime beyond the booked session. PRD §3 F22 "Kelebihan waktu dicatat dan
 * dapat dikenai biaya tambahan sesuai konfigurasi, dengan toleransi yang dapat
 * diatur": every number here is tenant configuration, not code.
 */
export const overtimePolicySchema = z.strictObject({
  /** Minutes past `endsAt` that are still free (arrival/overrun tolerance). */
  graceMinutes: minuteCount,
  /** Overtime is charged per started block of this many minutes. */
  blockMinutes: z.number().int().min(1).max(120),
  feePerBlockIdr: nonnegativeIdr,
});
export type OvertimePolicy = z.infer<typeof overtimePolicySchema>;

/**
 * What cancelling or not showing up does with an already-issued ticket (PRD
 * §3 F22 "Pembatalan & Pengembalian": the policy is configured, the PRD does
 * not fix values). `entitlement_restored` appends a `cancel` + `grant` pair to
 * the ledger for a redeemed entitlement, `refund_*` goes through WS-05.
 */
export const cancellationResolutionSchema = z.enum([
  "entitlement_restored",
  "refund_full",
  "refund_partial",
  "no_refund",
]);
export type CancellationResolution = z.infer<
  typeof cancellationResolutionSchema
>;

export const cancellationPolicySchema = z
  .strictObject({
    /** Cancel at least this long before `startsAt` to keep the full value. */
    freeCancelMinutesBefore: minuteCount,
    /** Resolution for a cancellation inside that window. */
    lateCancelResolution: cancellationResolutionSchema,
    /** Fee kept out of a partial refund (Rp; 0 for the other resolutions). */
    lateCancelFeeIdr: nonnegativeIdr,
    /** Resolution when the guest never arrives within the arrival tolerance. */
    noShowResolution: cancellationResolutionSchema,
  })
  .refine(
    (policy) =>
      policy.lateCancelResolution !== "refund_partial" ||
      policy.lateCancelFeeIdr > 0,
    {
      path: ["lateCancelFeeIdr"],
      message: "A partial refund needs a fee above zero",
    },
  );
export type CancellationPolicy = z.infer<typeof cancellationPolicySchema>;

export const facilitySchema = z.strictObject({
  id: facilityIdSchema,
  ...scope,
  name: nameSchema,
  type: facilityTypeSchema,
  /** Default session length; Legend ships 20 minutes (PRD §3 F22 Konfigurasi Legend). */
  sessionMinutes: z.number().int().min(1).max(480),
  /** Default cleaning buffer that blocks the next booking; Legend ships 10 minutes. */
  cleaningMinutes: minuteCount,
  /** Default arrival tolerance copied onto each ticket; PRD default 10 minutes. */
  arrivalGraceMinutes: minuteCount,
  /** Operating hours per weekday; Legend default 06:00–10:00. */
  operatingHours: facilityHoursSchema,
  overtimePolicy: overtimePolicySchema,
  cancellationPolicy: cancellationPolicySchema,
});
export type Facility = z.infer<typeof facilitySchema>;

/** One separated area inside a facility, e.g. Area Pria / Area Wanita. */
export const facilityAreaSchema = z.strictObject({
  id: facilityAreaIdSchema,
  ...scope,
  facilityId: facilityIdSchema,
  name: nameSchema,
  /** Lock that opens the area entrance; null when the area has no own door. */
  entranceLockDeviceId: uuidSchema.nullable(),
  sortOrder: z.number().int().min(0),
});
export type FacilityArea = z.infer<typeof facilityAreaSchema>;

/** Unit status machine values (PRD §6 K facility_units.status). */
export const facilityUnitStatusSchema = z.enum([
  "available",
  "in_use",
  "needs_cleaning",
  "cleaning",
  "maintenance",
]);
export type FacilityUnitStatus = z.infer<typeof facilityUnitStatusSchema>;

export const facilityUnitSchema = z.strictObject({
  id: facilityUnitIdSchema,
  ...scope,
  facilityId: facilityIdSchema,
  areaId: facilityAreaIdSchema,
  /** Unique per facility, e.g. `P1`, `W2` (PRD §6 K). */
  code: codeSchema,
  lockDeviceId: uuidSchema.nullable(),
  panicDeviceId: uuidSchema.nullable(),
  status: facilityUnitStatusSchema,
  sortOrder: z.number().int().min(0),
});
export type FacilityUnit = z.infer<typeof facilityUnitSchema>;

// ---- Products, add-ons and entitlement rules --------------------------------

/**
 * How an access right is obtained (PRD §3 F22 "Produk & Hak Akses"). The five
 * configured routes plus `staff_issue` for a cash sale at the POS (§3
 * Penjualan Fasilitas) and for a manual grant after an incident.
 */
export const entitlementSourceSchema = z.enum([
  "purchase",
  "package",
  "min_spend",
  "tier_benefit",
  "subscription",
  "staff_issue",
]);
export type EntitlementSource = z.infer<typeof entitlementSourceSchema>;

export const facilityProductTypeSchema = z.enum([
  "single",
  "package_component",
  "subscription_plan",
]);
export type FacilityProductType = z.infer<typeof facilityProductTypeSchema>;

export const facilityProductSchema = z.strictObject({
  id: facilityProductIdSchema,
  ...scope,
  facilityId: facilityIdSchema,
  name: nameSchema,
  type: facilityProductTypeSchema,
  priceIdr: nonnegativeIdr,
  taxRuleId: uuidSchema.nullable(),
  /** Sessions one purchase grants (1 for a single ticket, 10/20 for a plan). */
  sessions: z.number().int().min(1).max(100),
  /** Sessions per business day allowed on this product; null = unlimited. */
  maxPerDay: z.number().int().min(1).max(10).nullable(),
  /** The menu package that carries this component (PRD §3 F22 Menu paket). */
  menuItemId: uuidSchema.nullable(),
  /**
   * Stops new sales without deleting a product that tickets already reference.
   * Configuration column added by this contract (the PRD product table has no
   * enable flag; the admin panel bead legend-er32 needs one).
   */
  isActive: z.boolean(),
});
export type FacilityProduct = z.infer<typeof facilityProductSchema>;

export const facilityAddonSchema = z.strictObject({
  id: facilityAddonIdSchema,
  ...scope,
  facilityId: facilityIdSchema,
  name: nameSchema,
  priceIdr: nonnegativeIdr,
  /** Inventory item consumed by the add-on (e.g. amenities kit), else null. */
  inventoryItemId: uuidSchema.nullable(),
  isEnabled: z.boolean(),
  sortOrder: z.number().int().min(0),
});
export type FacilityAddon = z.infer<typeof facilityAddonSchema>;

/** How long an issued entitlement stays usable (PRD §6 K entitlement_rules.validity). */
export const entitlementValiditySchema = z.discriminatedUnion("kind", [
  /** Until the facility closes on the issuing business day (min-spend voucher). */
  z.strictObject({ kind: z.literal("operating_day") }),
  /** A fixed window from issue, e.g. 24 hours. */
  z.strictObject({
    kind: z.literal("duration_hours"),
    hours: z
      .number()
      .int()
      .min(1)
      .max(24 * 365),
  }),
  /** Resets with the billing period it belongs to (tier benefit, subscription). */
  z.strictObject({ kind: z.literal("billing_period") }),
]);
export type EntitlementValidity = z.infer<typeof entitlementValiditySchema>;

export const entitlementRuleTypeSchema = z.enum([
  "min_spend",
  "tier_benefit",
  "package",
]);
export type EntitlementRuleType = z.infer<typeof entitlementRuleTypeSchema>;

const entitlementRuleBase = {
  id: entitlementRuleIdSchema,
  ...scope,
  facilityId: facilityIdSchema,
  /** Sessions one qualification grants. */
  sessions: z.number().int().min(1).max(100),
  validity: entitlementValiditySchema,
  isEnabled: z.boolean(),
};

/**
 * Rules under which conditions issue an access right (PRD §3 F22). The
 * condition shape is fixed per type so a rule cannot be written ambiguously:
 * a min-spend rule always carries a threshold, a tier rule the tier keys, a
 * package rule the menu package it belongs to.
 */
export const entitlementRuleSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...entitlementRuleBase,
    type: z.literal("min_spend"),
    condition: z.strictObject({
      /** Qualifying same-day F&B spend (Rp). */
      minSpendIdr: positiveIdr,
    }),
  }),
  z.strictObject({
    ...entitlementRuleBase,
    type: z.literal("tier_benefit"),
    condition: z.strictObject({
      /** Loyalty tier keys the benefit applies to (WS-08 owns the tier list). */
      tierKeys: z.array(z.string().trim().min(1).max(30)).min(1).max(20),
    }),
  }),
  z.strictObject({
    ...entitlementRuleBase,
    type: z.literal("package"),
    condition: z.strictObject({
      /** Menu package whose paid order issues the entitlement. */
      menuItemId: uuidSchema,
    }),
  }),
]);
export type EntitlementRule = z.infer<typeof entitlementRuleSchema>;

// ---- Entitlement ledger (append-only) ---------------------------------------

export const entitlementLedgerTypeSchema = z.enum([
  "grant",
  "redeem",
  "cancel",
  "expire",
]);
export type EntitlementLedgerType = z.infer<typeof entitlementLedgerTypeSchema>;

/**
 * One append-only movement of access rights (PRD §6 K entitlement_ledger).
 * Signs are decided by `type` (see `entitlement.ts`): grant +sessions, redeem
 * and cancel −sessions, expire is the audit record of a grant reaching
 * `expiresAt` and never changes the balance itself.
 */
export const entitlementLedgerEntrySchema = z
  .strictObject({
    id: entitlementLedgerIdSchema,
    ...scope,
    facilityId: facilityIdSchema,
    customerProfileId: uuidSchema,
    type: entitlementLedgerTypeSchema,
    sessions: z.number().int().min(1).max(100),
    sourceType: entitlementSourceSchema,
    /**
     * The source transaction: an order id (ULID) for a package/min-spend
     * source, a subscription, rule or staff user id (UUID) otherwise.
     */
    sourceRef: z.union([uuidSchema, ulidSchema]),
    /** Set on a redemption: the ticket that consumed the grant. 1:1 (FAC-05). */
    accessTicketId: accessTicketIdSchema.nullable(),
    /** Null = never expires (staff grant); otherwise FAC-04 validity end. */
    expiresAt: isoDateTimeSchema.nullable(),
    occurredAt: isoDateTimeSchema,
    /** Staff or system actor that wrote the row; null for an automatic job. */
    actorUserId: uuidSchema.nullable(),
    reason: z.string().trim().max(500).nullable(),
  })
  .superRefine((entry, ctx) => {
    if (entry.type === "redeem" && entry.accessTicketId === null)
      ctx.addIssue({
        code: "custom",
        path: ["accessTicketId"],
        message: "A redemption names the ticket that consumed the grant",
      });
    if (entry.type !== "redeem" && entry.accessTicketId !== null)
      ctx.addIssue({
        code: "custom",
        path: ["accessTicketId"],
        message: "Only a redemption may reference a ticket",
      });
  });
export type EntitlementLedgerEntry = z.infer<
  typeof entitlementLedgerEntrySchema
>;

// ---- Access tickets ---------------------------------------------------------

/** Ticket status machine values (PRD §6 K access_tickets.status). */
export const accessTicketStatusSchema = z.enum([
  "pending_payment",
  "issued",
  "in_use",
  "completed",
  "no_show",
  "cancelled",
  "refunded",
]);
export type AccessTicketStatus = z.infer<typeof accessTicketStatusSchema>;

/** An add-on chosen for one ticket (PRD §6 K access_tickets.addons JSONB). */
export const ticketAddonSchema = z.strictObject({
  addonId: facilityAddonIdSchema,
  name: nameSchema,
  priceIdr: nonnegativeIdr,
  quantity: z.number().int().min(1).max(20),
});
export type TicketAddon = z.infer<typeof ticketAddonSchema>;

export const accessTicketSchema = z
  .strictObject({
    id: accessTicketIdSchema,
    ...scope,
    facilityId: facilityIdSchema,
    /** The area the guest picked; it lives on the ticket, not the profile (FAC-09). */
    areaId: facilityAreaIdSchema,
    /** The unit the ticket opens. A ticket never opens another unit (FAC-01). */
    unitId: facilityUnitIdSchema,
    customerProfileId: uuidSchema,
    productId: facilityProductIdSchema,
    source: entitlementSourceSchema,
    /** The `redeem` ledger row this ticket consumed (UUID FK, unique; FAC-05). */
    entitlementLedgerId: uuidSchema.nullable(),
    slot: z.strictObject({
      startsAt: isoDateTimeSchema,
      endsAt: isoDateTimeSchema,
      cleaningEndsAt: isoDateTimeSchema,
    }),
    /** Arrival tolerance copied from the facility at issue (PRD default 10). */
    graceMinutes: minuteCount,
    addons: z.array(ticketAddonSchema).max(10),
    status: accessTicketStatusSchema,
    /** Issued by the edge node while the outlet had no internet (FAC-03). */
    issuedOffline: z.boolean(),
    firstOpenedAt: isoDateTimeSchema.nullable(),
    endedAt: isoDateTimeSchema.nullable(),
    overtimeMinutes: minuteCount,
    overtimeFeeIdr: nonnegativeIdr,
    createdAt: isoDateTimeSchema,
  })
  .superRefine((ticket, ctx) => {
    const start = Date.parse(ticket.slot.startsAt);
    const end = Date.parse(ticket.slot.endsAt);
    const clean = Date.parse(ticket.slot.cleaningEndsAt);
    if (!(end > start))
      ctx.addIssue({
        code: "custom",
        path: ["slot", "endsAt"],
        message: "endsAt must be after startsAt",
      });
    if (!(clean >= end))
      ctx.addIssue({
        code: "custom",
        path: ["slot", "cleaningEndsAt"],
        message: "cleaningEndsAt must not be before endsAt",
      });
    if (
      (ticket.status === "in_use" || ticket.status === "completed") &&
      ticket.firstOpenedAt === null
    )
      ctx.addIssue({
        code: "custom",
        path: ["firstOpenedAt"],
        message: "An opened ticket records when it was first opened",
      });
    if (ticket.status === "completed" && ticket.endedAt === null)
      ctx.addIssue({
        code: "custom",
        path: ["endedAt"],
        message: "A completed ticket records when the session ended",
      });
    if (
      (ticket.overtimeMinutes > 0 || ticket.overtimeFeeIdr > 0) &&
      ticket.endedAt === null
    )
      ctx.addIssue({
        code: "custom",
        path: ["overtimeMinutes"],
        message: "Overtime is recorded when the session ends",
      });
    // FAC-04/FAC-05: the four entitlement sources always consume a grant, so a
    // ticket from one of them without a ledger reference would skip the atomic
    // redemption. A purchase or staff issue never consumes one.
    const entitled =
      ticket.source === "package" ||
      ticket.source === "min_spend" ||
      ticket.source === "tier_benefit" ||
      ticket.source === "subscription";
    if (entitled && ticket.entitlementLedgerId === null)
      ctx.addIssue({
        code: "custom",
        path: ["entitlementLedgerId"],
        message: "An entitlement-sourced ticket names the grant it redeemed",
      });
    if (!entitled && ticket.entitlementLedgerId !== null)
      ctx.addIssue({
        code: "custom",
        path: ["entitlementLedgerId"],
        message: "Only an entitlement source consumes a grant",
      });
  });
export type AccessTicket = z.infer<typeof accessTicketSchema>;

/**
 * SHA-256 digests of the door credential. These are the PRD §6 K
 * `access_tickets.qr_hash` / `pin_hash` columns, split out of the ticket DTO so
 * no client response can carry them: a 6-digit PIN has only 10^6 possible
 * digests, so a leaked hash is a leaked PIN. Clients receive the plaintext once
 * at issue (`accessTicketCredentialSchema`) and never the digests. For the
 * same reason the digest must be keyed — HMAC-SHA-256 with a per-tenant secret
 * held by the API and the edge (lock agent), never a bare SHA-256 — so a
 * database or backup leak alone cannot be brute-forced back to PINs.
 */
export const accessTicketCredentialDigestSchema = z.strictObject({
  ticketId: accessTicketIdSchema,
  qrHash: credentialDigestSchema,
  pinHash: credentialDigestSchema,
});
export type AccessTicketCredentialDigest = z.infer<
  typeof accessTicketCredentialDigestSchema
>;

/**
 * What the guest shows at the door: QR token and 6-digit PIN, bound to one
 * unit and area for a window that starts at the arrival tolerance and ends
 * when the session ends (FAC-01). Returned once when the ticket is issued;
 * never logged, audited, stored or put in an event.
 */
export const accessTicketCredentialSchema = z
  .strictObject({
    ticketId: accessTicketIdSchema,
    facilityId: facilityIdSchema,
    areaId: facilityAreaIdSchema,
    unitId: facilityUnitIdSchema,
    qrToken: z.string().min(16).max(512),
    pin: z.string().regex(/^\d{6}$/, "The door PIN is exactly 6 digits"),
    validFrom: isoDateTimeSchema,
    validUntil: isoDateTimeSchema,
  })
  .refine(
    (credential) =>
      Date.parse(credential.validUntil) > Date.parse(credential.validFrom),
    {
      path: ["validUntil"],
      message: "validUntil must be after validFrom",
    },
  );
export type AccessTicketCredential = z.infer<
  typeof accessTicketCredentialSchema
>;

// ---- Lock credentials, access log -------------------------------------------

export const lockCredentialStatusSchema = z.enum([
  "pending",
  "pushed",
  "active",
  "revoked",
  "expired",
]);
export type LockCredentialStatus = z.infer<typeof lockCredentialStatusSchema>;

/**
 * Time-boxed credential the edge pushes to a smart lock (PRD §6 K
 * lock_credentials, FAC-03). The lock verifies it locally against its own
 * clock: no network call, so an issued ticket still opens a door during an
 * outage. `validUntil` is fixed at issue and never extended online.
 */
export const lockCredentialSchema = z
  .strictObject({
    id: lockCredentialIdSchema,
    ...scope,
    accessTicketId: accessTicketIdSchema,
    lockDeviceId: uuidSchema,
    /** Provider-side reference returned by LockProvider.issue. */
    providerRef: z.string().min(1).max(255).nullable(),
    validFrom: isoDateTimeSchema,
    validUntil: isoDateTimeSchema,
    pushedAt: isoDateTimeSchema.nullable(),
    revokedAt: isoDateTimeSchema.nullable(),
    status: lockCredentialStatusSchema,
  })
  .refine(
    (credential) =>
      Date.parse(credential.validUntil) > Date.parse(credential.validFrom),
    {
      path: ["validUntil"],
      message: "validUntil must be after validFrom",
    },
  );
export type LockCredential = z.infer<typeof lockCredentialSchema>;

/** Door log types (PRD §6 K access_events.type). */
export const accessEventTypeSchema = z.enum([
  "unlock",
  "denied",
  "door_open_too_long",
  "low_battery",
  "tamper",
]);
export type AccessEventType = z.infer<typeof accessEventTypeSchema>;

export const accessEventSchema = z.strictObject({
  id: accessEventIdSchema,
  ...scope,
  lockDeviceId: uuidSchema,
  accessTicketId: accessTicketIdSchema.nullable(),
  unitId: facilityUnitIdSchema.nullable(),
  type: accessEventTypeSchema,
  occurredAt: isoDateTimeSchema,
  /** Recorded by the lock agent while the edge was offline (FAC-03). */
  offline: z.boolean(),
});
export type AccessEvent = z.infer<typeof accessEventSchema>;

// ---- Cleaning, incidents, breakfast links, queue ---------------------------

/** Checklist keys for one cleaning cycle (PRD §3 F22 Siklus Kebersihan: lantai, saluran air, perlengkapan, sampah). */
export const CLEANING_CHECKLIST_KEYS = [
  "floor",
  "drain",
  "supplies",
  "trash",
] as const;
export const cleaningChecklistItemSchema = z.strictObject({
  key: z.enum(CLEANING_CHECKLIST_KEYS),
  done: z.boolean(),
  note: z.string().trim().max(200).nullable(),
});
export type CleaningChecklistItem = z.infer<typeof cleaningChecklistItemSchema>;

/** Every checklist item exactly once; the staff board shows all four. */
export const cleaningChecklistSchema = z
  .array(cleaningChecklistItemSchema)
  .length(CLEANING_CHECKLIST_KEYS.length)
  .superRefine((items, ctx) => {
    const keys = new Set(items.map((item) => item.key));
    if (keys.size !== CLEANING_CHECKLIST_KEYS.length)
      ctx.addIssue({
        code: "custom",
        message: "Checklist must contain each key exactly once",
      });
  });
export type CleaningChecklist = z.infer<typeof cleaningChecklistSchema>;

export const cleaningTaskSchema = z
  .strictObject({
    id: cleaningTaskIdSchema,
    ...scope,
    facilityId: facilityIdSchema,
    unitId: facilityUnitIdSchema,
    /** The finished session that dirtied the unit; null for a deep clean. */
    accessTicketId: accessTicketIdSchema.nullable(),
    checklist: cleaningChecklistSchema,
    /** Storage media ids of optional photos (WS-00 storage adapter). */
    mediaIds: z.array(uuidSchema).max(10),
    assignedTo: uuidSchema.nullable(),
    startedAt: isoDateTimeSchema.nullable(),
    completedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
  })
  .superRefine((task, ctx) => {
    if (task.completedAt !== null && task.startedAt === null)
      ctx.addIssue({
        code: "custom",
        path: ["startedAt"],
        message: "A completed task records when cleaning started",
      });
    if (task.completedAt !== null && task.checklist.some((item) => !item.done))
      ctx.addIssue({
        code: "custom",
        path: ["checklist"],
        message: "A completed task has every checklist item done",
      });
  });
export type CleaningTask = z.infer<typeof cleaningTaskSchema>;

export const facilityIncidentTypeSchema = z.enum(["panic", "assist", "damage"]);
export type FacilityIncidentType = z.infer<typeof facilityIncidentTypeSchema>;

/** Emergency button / assistance / damage report (PRD §6 K facility_incidents, FAC-08). */
export const facilityIncidentSchema = z.strictObject({
  id: facilityIncidentIdSchema,
  ...scope,
  facilityId: facilityIdSchema,
  unitId: facilityUnitIdSchema.nullable(),
  accessTicketId: accessTicketIdSchema.nullable(),
  type: facilityIncidentTypeSchema,
  triggeredAt: isoDateTimeSchema,
  /** Raised on the edge while the outlet had no internet (FAC-08). */
  offline: z.boolean(),
  respondedBy: uuidSchema.nullable(),
  respondedAt: isoDateTimeSchema.nullable(),
  resolution: z.string().trim().max(500).nullable(),
});
export type FacilityIncident = z.infer<typeof facilityIncidentSchema>;

/**
 * Breakfast order held until shortly before the session ends (PRD §6 K
 * facility_linked_orders, §3 F22 Sarapan Siap Saat Keluar Shower, FAC-10).
 * `fireAt` is `slot.endsAt - fireOffsetMinutes`, recomputed when the session
 * is extended or the guest is late.
 */
export const facilityLinkedOrderSchema = z.strictObject({
  id: facilityLinkedOrderIdSchema,
  ...scope,
  facilityId: facilityIdSchema,
  accessTicketId: accessTicketIdSchema,
  /** WS-04 order (ULID). */
  orderId: ulidSchema,
  fireOffsetMinutes: z.number().int().min(0).max(240),
  fireAt: isoDateTimeSchema,
  firedAt: isoDateTimeSchema.nullable(),
});
export type FacilityLinkedOrder = z.infer<typeof facilityLinkedOrderSchema>;

export const facilityQueueEntryStatusSchema = z.enum([
  "waiting",
  "notified",
  "converted",
  "expired",
]);
export type FacilityQueueEntryStatus = z.infer<
  typeof facilityQueueEntryStatusSchema
>;

/**
 * "Masuk sekarang" wait queue (PRD §3 F22 Pemesanan: estimate and notify when
 * a unit is ready). PRD §6 K lists no queue table; this is the contract shape
 * the BE bead legend-nm4f implements, kept on the ticket's own facility/area.
 */
export const facilityQueueEntrySchema = z.strictObject({
  id: facilityQueueEntryIdSchema,
  ...scope,
  facilityId: facilityIdSchema,
  areaId: facilityAreaIdSchema,
  customerProfileId: uuidSchema,
  joinedAt: isoDateTimeSchema,
  status: facilityQueueEntryStatusSchema,
  notifiedAt: isoDateTimeSchema.nullable(),
});
export type FacilityQueueEntry = z.infer<typeof facilityQueueEntrySchema>;

// ---- Subscriptions ----------------------------------------------------------

/** Monthly plans ship first; the interval stays configurable (PRD §3 F22 Langganan Bulanan). */
export const subscriptionIntervalSchema = z.enum(["month", "year"]);
export type SubscriptionInterval = z.infer<typeof subscriptionIntervalSchema>;

export const subscriptionPlanSchema = z.strictObject({
  id: subscriptionPlanIdSchema,
  ...scope,
  facilityId: facilityIdSchema,
  name: nameSchema,
  priceIdr: nonnegativeIdr,
  /** Sessions included per period, e.g. 10 or 20 (PRD §3 F22). */
  quotaPerPeriod: z.number().int().min(1).max(100),
  interval: subscriptionIntervalSchema,
  /** Optional per-day cap, e.g. 1 session per day (PRD §3 F22). */
  maxPerDay: z.number().int().min(1).max(10).nullable(),
  /** Plan id in the recurring-billing provider (DOIT). */
  providerPlanId: z.string().min(1).max(100).nullable(),
  isActive: z.boolean(),
});
export type SubscriptionPlan = z.infer<typeof subscriptionPlanSchema>;

export const facilitySubscriptionStatusSchema = z.enum([
  "active",
  "past_due",
  "suspended",
  "paused",
  "cancelled",
]);
export type FacilitySubscriptionStatus = z.infer<
  typeof facilitySubscriptionStatusSchema
>;

export const facilitySubscriptionSchema = z.strictObject({
  id: facilitySubscriptionIdSchema,
  ...scope,
  facilityId: facilityIdSchema,
  customerProfileId: uuidSchema,
  planId: subscriptionPlanIdSchema,
  /** Subscription id in the recurring-billing provider (DOIT). */
  providerSubscriptionId: z.string().min(1).max(100).nullable(),
  quotaPerPeriod: z.number().int().min(1).max(100),
  currentPeriodStart: businessDateSchema,
  currentPeriodEnd: businessDateSchema,
  quotaUsed: z.number().int().min(0).max(100),
  /**
   * FAC-07: the last instant the quota stays usable while the bill is unpaid
   * (PRD default grace 3 days). Null when the plan is paid up.
   */
  graceUntil: isoDateTimeSchema.nullable(),
  status: facilitySubscriptionStatusSchema,
  startedAt: isoDateTimeSchema,
  cancelledAt: isoDateTimeSchema.nullable(),
});
export type FacilitySubscription = z.infer<typeof facilitySubscriptionSchema>;

export const subscriptionInvoiceStatusSchema = z.enum([
  "pending",
  "paid",
  "expired",
  "failed",
  "refunded",
]);
export type SubscriptionInvoiceStatus = z.infer<
  typeof subscriptionInvoiceStatusSchema
>;

export const subscriptionInvoiceSchema = z.strictObject({
  id: subscriptionInvoiceIdSchema,
  ...scope,
  subscriptionId: facilitySubscriptionIdSchema,
  /** PRD `period`, expressed as the billing period it covers. */
  periodStart: businessDateSchema,
  periodEnd: businessDateSchema,
  amountIdr: nonnegativeIdr,
  /** Hosted payment page link sent by push/email (PRD §3 F22). */
  hostedUrl: z.url().max(2000).nullable(),
  status: subscriptionInvoiceStatusSchema,
  paidAt: isoDateTimeSchema.nullable(),
});
export type SubscriptionInvoice = z.infer<typeof subscriptionInvoiceSchema>;

/** Why a subscription may or may not use its quota right now (FAC-07). */
export const subscriptionQuotaReasonSchema = z.enum([
  "ok",
  "past_due_within_grace",
  "past_due_grace_expired",
  "quota_exhausted",
  "paused",
  "suspended",
  "cancelled",
]);
export type SubscriptionQuotaReason = z.infer<
  typeof subscriptionQuotaReasonSchema
>;

export const subscriptionQuotaSchema = z.strictObject({
  perPeriod: z.number().int().min(0).max(100),
  used: z.number().int().min(0).max(100),
  remaining: z.number().int().min(0).max(100),
  usable: z.boolean(),
  reason: subscriptionQuotaReasonSchema,
});
export type SubscriptionQuota = z.infer<typeof subscriptionQuotaSchema>;

// ---- Wi-Fi and WFC (PRD §6 K wifi_policies / wifi_sessions, §3 F39) ---------

/** Recurring local window, e.g. weekday peak 11:30–14:00 (PRD §3 F39 Jam Ramai). */
export const peakWindowSchema = z
  .strictObject({
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    startsAt: timeOfDaySchema,
    endsAt: timeOfDaySchema,
  })
  .refine(
    (window) => minutesOfDay(window.endsAt) > minutesOfDay(window.startsAt),
    { path: ["endsAt"], message: "endsAt must be after startsAt" },
  );
export type PeakWindow = z.infer<typeof peakWindowSchema>;

export const wifiPolicySchema = z
  .strictObject({
    id: wifiPolicyIdSchema,
    ...scope,
    /** Floor zone the policy applies to (PRD §6 C floor_zones, WS-03). */
    zoneId: uuidSchema,
    /** Free minutes per day per account outside peak hours (PRD default 120). */
    freeMinutes: minuteCount,
    /** Free minutes per day per account during peak hours (PRD default 60). */
    peakFreeMinutes: minuteCount,
    /** Every full amount of this spend adds `extraMinutes` (PRD default Rp30.000). */
    spendPerExtraHourIdr: nonnegativeIdr,
    /** Minutes added per full spend step (PRD default 60 = one hour). */
    extraMinutes: z.number().int().min(1).max(1440),
    /** Devices per account (PRD §3 "Maksimal 2 perangkat per akun", FAC-12). */
    maxDevices: z.number().int().min(1).max(20),
    peakSchedule: z.array(peakWindowSchema).max(14),
    /** Throttled speed once the quota is spent — the session is never cut (FAC-13). */
    baseSpeedKbps: z.number().int().min(1).max(1_000_000),
    fullSpeedKbps: z.number().int().min(1).max(1_000_000),
    /** WFC zones ask for a minimum spend per hour; null where not enforced. */
    minSpendPerHourIdr: nonnegativeIdr.nullable(),
    /** Extra daily minutes per loyalty tier key (PRD §3 "tier Gold dan Platinum"). */
    tierBonusMinutes: z.record(z.string(), z.number().int().min(0).max(720)),
  })
  .superRefine((policy, ctx) => {
    if (policy.peakFreeMinutes > policy.freeMinutes)
      ctx.addIssue({
        code: "custom",
        path: ["peakFreeMinutes"],
        message: "Peak free minutes cannot exceed the off-peak allowance",
      });
    if (policy.fullSpeedKbps <= policy.baseSpeedKbps)
      ctx.addIssue({
        code: "custom",
        path: ["fullSpeedKbps"],
        message: "Full speed must be faster than the throttled base speed",
      });
    if (policy.spendPerExtraHourIdr === 0 && policy.extraMinutes > 0)
      ctx.addIssue({
        code: "custom",
        path: ["spendPerExtraHourIdr"],
        message: "A zero spend step would make extra minutes unlimited",
      });
    for (const tierKey of Object.keys(policy.tierBonusMinutes))
      if (tierKey.trim().length === 0 || tierKey.length > 30)
        ctx.addIssue({
          code: "custom",
          path: ["tierBonusMinutes", tierKey],
          message: "Tier keys are 1–30 characters",
        });
  });
export type WifiPolicy = z.infer<typeof wifiPolicySchema>;

export const wifiSpeedTierSchema = z.enum(["full", "base"]);
export type WifiSpeedTier = z.infer<typeof wifiSpeedTierSchema>;

export const wifiSessionSchema = z.strictObject({
  id: wifiSessionIdSchema,
  ...scope,
  customerProfileId: uuidSchema,
  zoneId: uuidSchema,
  /** The policy the quota was computed with, kept for audit and re-checks. */
  policyId: wifiPolicyIdSchema,
  /** SHA-256 of the device fingerprint; the raw fingerprint is never stored. */
  deviceHash: credentialDigestSchema,
  quotaMinutes: minuteCount,
  usedMinutes: minuteCount,
  speedTier: wifiSpeedTierSchema,
  startedAt: isoDateTimeSchema,
  endedAt: isoDateTimeSchema.nullable(),
});
export type WifiSession = z.infer<typeof wifiSessionSchema>;

// ---- Read models ------------------------------------------------------------

/** One bookable slot on the availability screen. */
export const facilitySlotOptionSchema = z
  .strictObject({
    startsAt: isoDateTimeSchema,
    endsAt: isoDateTimeSchema,
    cleaningEndsAt: isoDateTimeSchema,
    available: z.boolean(),
  })
  .refine(
    (slot) =>
      Date.parse(slot.endsAt) > Date.parse(slot.startsAt) &&
      Date.parse(slot.cleaningEndsAt) >= Date.parse(slot.endsAt),
    { path: ["cleaningEndsAt"], message: "Slot instants are out of order" },
  );
export type FacilitySlotOption = z.infer<typeof facilitySlotOptionSchema>;

export const facilityAvailabilitySchema = z.strictObject({
  facilityId: facilityIdSchema,
  /** Business date the slots belong to, in the outlet time zone. */
  businessDate: businessDateSchema,
  /** Server clock: the FE derives countdowns from this, never the device clock. */
  serverTime: isoDateTimeSchema,
  areas: z.array(
    z.strictObject({
      areaId: facilityAreaIdSchema,
      name: nameSchema,
      units: z.array(
        z.strictObject({
          unitId: facilityUnitIdSchema,
          code: codeSchema,
          status: facilityUnitStatusSchema,
          /** FAC-06: false when the unit needs cleaning or is under maintenance. */
          bookable: z.boolean(),
          slots: z.array(facilitySlotOptionSchema),
        }),
      ),
    }),
  ),
  waitEstimate: z.strictObject({
    queueLength: z.number().int().min(0).max(1000),
    freeUnitsNow: z.number().int().min(0).max(1000),
    /** Minutes until a unit is likely free (0 when one is free now). */
    estimatedWaitMinutes: minuteCount,
  }),
});
export type FacilityAvailability = z.infer<typeof facilityAvailabilitySchema>;

/** One row of the staff status board (bead legend-1oi9). */
export const facilityUnitBoardRowSchema = z.strictObject({
  unit: facilityUnitSchema,
  currentTicket: z
    .strictObject({
      ticketId: accessTicketIdSchema,
      startedAt: isoDateTimeSchema,
      scheduledEndsAt: isoDateTimeSchema,
    })
    .nullable(),
  cleaningTask: cleaningTaskSchema.nullable(),
});
export type FacilityUnitBoardRow = z.infer<typeof facilityUnitBoardRowSchema>;

/** What the guest's phone shows for one ticket (QR/PIN screen with a timer). */
export const accessTicketViewSchema = z.strictObject({
  ticket: accessTicketSchema,
  /** Door window: arrival tolerance start to session end (FAC-01). */
  credentialWindow: z.strictObject({
    validFrom: isoDateTimeSchema,
    validUntil: isoDateTimeSchema,
  }),
  session: z.strictObject({
    startedAt: isoDateTimeSchema.nullable(),
    scheduledEndsAt: isoDateTimeSchema,
    endedAt: isoDateTimeSchema.nullable(),
    overtimeMinutes: minuteCount,
    overtimeFeeIdr: nonnegativeIdr,
  }),
  /** Server clock for the countdown (the device clock is not trusted). */
  serverTime: isoDateTimeSchema,
});
export type AccessTicketView = z.infer<typeof accessTicketViewSchema>;

/** Admin configuration of one facility (bead legend-er32). */
export const facilityConfigSchema = z.strictObject({
  facility: facilitySchema,
  areas: z.array(facilityAreaSchema),
  units: z.array(facilityUnitSchema),
  products: z.array(facilityProductSchema),
  addons: z.array(facilityAddonSchema),
  entitlementRules: z.array(entitlementRuleSchema),
  subscriptionPlans: z.array(subscriptionPlanSchema),
  wifiPolicies: z.array(wifiPolicySchema),
});
export type FacilityConfig = z.infer<typeof facilityConfigSchema>;

/** Wi-Fi quota meter (captive portal, bead legend-g9r3). */
export const wifiQuotaViewSchema = z.strictObject({
  session: wifiSessionSchema,
  policy: wifiPolicySchema,
  /** quotaMinutes − usedMinutes, never negative. */
  remainingMinutes: minuteCount,
  serverTime: isoDateTimeSchema,
});
export type WifiQuotaView = z.infer<typeof wifiQuotaViewSchema>;

/** Subscription screen: plan, quota and invoice history (bead legend-gr3j). */
export const facilitySubscriptionViewSchema = z.strictObject({
  subscription: facilitySubscriptionSchema,
  plan: subscriptionPlanSchema,
  quota: subscriptionQuotaSchema,
  invoices: z.array(subscriptionInvoiceSchema),
  serverTime: isoDateTimeSchema,
});
export type FacilitySubscriptionView = z.infer<
  typeof facilitySubscriptionViewSchema
>;
