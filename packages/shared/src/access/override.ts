// Device PIN + supervisor override contract (bead legend-dxb; PRD v1.7 §3 F6
// "Staf — PIN Perangkat" + "Override Supervisor", §6 B staff_pins, AUTH-06).
//
// Published as its own subpath (`@starter/shared/access/override`) instead of
// through `access/index.ts`: it reuses identity schemas (pin input, digest,
// object reference), and identity already imports the access barrel, so a
// re-export from there would create an import cycle.
//
// What lives here:
// - the user-targeted pin verify body. The identity contract's
//   `verifyStaffPinSchema` carries only the pin, which cannot attribute a miss
//   to one staff row, so "PIN dikunci setelah 5 kali salah" (per staff_pins
//   row) would be unenforceable; the POS sends the staff tile it switches to;
// - the POS override request (PIN on the device, or approval from the
//   supervisor's phone through the generic approval inbox) and its view;
// - the edge replication record of a staff pin (hash only, never the pin);
// - the domain events. Payloads carry ids and enums, never the pin.
//   `pos_override.recorded` also carries the reason (legend-kyie: the cloud
//   writes the audit row of an override recorded offline on an edge), and an
//   EDGE node's `staff_pin.set` carries the hash material (never the pin) so
//   the cloud can take over a pin set on the edge. That material only travels
//   edge -> cloud and is stripped before any event is stored for review
//   (edge/access-applier.ts `redactEdgeEnvelopeSecrets`).

import {
  clientInputSchema,
  dataResponseSchema,
  idrSchema,
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
  ulidIdSchema,
  userIdSchema,
  z,
} from "../core/index.ts";
import { defineEndpoint } from "../api/index.ts";
import { defineDomainEvent } from "../events/index.ts";
import {
  MAX_STAFF_PIN_ATTEMPTS,
  approvalRequestParamsSchema,
  approvalRequestSchema,
  identityDigestSchema,
  objectIdSchema,
  objectTypeSchema,
  staffPinIdSchema,
  staffPinInputSchema,
  staffPinSwitchSchema,
} from "../identity/index.ts";
import {
  POS_OVERRIDE_ACTIONS,
  posOverrideSchema,
  type PosOverride,
  type PosOverrideAction,
} from "./approval.ts";
import type { PermissionCode } from "./permissions.ts";

// ------------------------------------------------------------ permissions

/**
 * The permission an approver must hold over the outlet for each override
 * (§3.6 Override Supervisor; catalog codes in permissions.ts). Fail closed:
 * an action without an entry cannot be approved.
 */
export const POS_OVERRIDE_APPROVE_PERMISSION = {
  void: "pos.void.approve",
  discount: "pos.discount.approve",
  refund: "pos.refund.approve",
  cash_drawer_open: "pos.cash_drawer.approve",
  price_correction: "pos.price_correction.approve",
  cash_shift_close: "shift.cash.approve_close",
  edc_standalone: "pos.edc_standalone.approve",
} as const satisfies Record<PosOverrideAction, PermissionCode>;

// -------------------------------------------------------------- staff pins

/**
 * Switch user on a registered outlet device: the staff tile picked on the
 * device plus that person's 6-digit pin. The outlet comes from the device
 * token (TEN-02), never from the body.
 */
export const verifyStaffPinForUserSchema = clientInputSchema({
  userId: userIdSchema,
  pin: staffPinInputSchema,
  /**
   * Optional (bead legend-u7g9w): `attendance_clock` asks for a single-use PIN
   * proof for the outlet clock route. Without it the answer is unchanged.
   */
  purpose: z.literal("attendance_clock").optional(),
});
export type VerifyStaffPinForUserInput = z.infer<
  typeof verifyStaffPinForUserSchema
>;

/** Key-derivation parameters of a stored pin hash (scrypt). */
export const staffPinKdfParamsSchema = z.strictObject({
  N: z.number().int().min(1024).max(1_048_576),
  r: z.number().int().min(1).max(32),
  p: z.number().int().min(1).max(16),
  keyLength: z.literal(32),
});
export type StaffPinKdfParams = z.infer<typeof staffPinKdfParamsSchema>;

export const STAFF_PIN_HASH_ALGORITHM = "scrypt-hmac-sha256-v1";

/**
 * One staff pin as replicated to the outlet edge (§6 B staff_pins "(T, E)").
 * The edge verifies offline with this record plus the tenant pin pepper it
 * receives at provisioning; the pin itself never leaves the device that typed
 * it. `pinHash` is the scrypt output (64 hex), bound to tenant, outlet and
 * user, so a hash copied onto another row never verifies.
 */
export const staffPinEdgeRecordSchema = z.strictObject({
  id: staffPinIdSchema,
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  userId: userIdSchema,
  algorithm: z.literal(STAFF_PIN_HASH_ALGORITHM),
  /** Random per-pin salt, base64 (16 bytes). */
  salt: z
    .string()
    .regex(/^[A-Za-z0-9+/]{22}==$/, "Expected a 16-byte base64 salt"),
  pinHash: identityDigestSchema,
  params: staffPinKdfParamsSchema,
  /** Pepper generation the hash was made with (rotation). */
  pepperVersion: z.number().int().min(1),
  failedAttempts: z.number().int().min(0).max(MAX_STAFF_PIN_ATTEMPTS),
  lockedUntil: isoDateTimeSchema.nullable(),
  updatedAt: isoDateTimeSchema,
  /**
   * Order key of the pin generation (`staff_pins.pin_generation_at`,
   * legend-t9ii), exact to the microsecond. The edge orders a cloud reset
   * against its own generation with this key, never with a node clock, and
   * stores it so its next set is stamped after it.
   */
  pinGenerationAt: isoDateTimeSchema,
  /**
   * Counter revision (`staff_pins.attempt_revision`, legend-r11j7): bumped on
   * every change of the counter or the hash material, so the edge sees a
   * counter that went 3 -> 0 -> 3 between two pulls as moved. Optional: the
   * cloud sends it only to an edge that asks (`revision=1`), since an older
   * edge parses this record strictly; without it the edge compares the
   * counter by value.
   */
  attemptRevision: z.number().int().nonnegative().optional(),
});
export type StaffPinEdgeRecord = z.infer<typeof staffPinEdgeRecordSchema>;

// ------------------------------------------------------------ POS override

export const posOverrideIdSchema = ulidIdSchema<"PosOverrideId">();
export type PosOverrideId = z.infer<typeof posOverrideIdSchema>;

export const POS_OVERRIDE_METHODS = [
  "supervisor_pin",
  "supervisor_phone",
] as const;
export type PosOverrideMethod = (typeof POS_OVERRIDE_METHODS)[number];

/**
 * Lifecycle of one override request. A PIN override is `approved` at once; a
 * phone approval is `pending` until the approval chain ends. Only `approved`
 * is an override (AUTH-06 record); rejected/expired/cancelled grant nothing.
 */
export const POS_OVERRIDE_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled",
] as const;
export type PosOverrideStatus = (typeof POS_OVERRIDE_STATUSES)[number];

/**
 * Closed list of override reason codes (PRD v1.7 §3 F6, bead legend-5vlw).
 * The POS modal offers exactly these; any other code is a 422.
 */
export const posOverrideReasonCodes = [
  "wrong_item",
  "customer_cancel",
  "out_of_stock",
  "quality_complaint",
  "price_mismatch",
  "other",
] as const;
export const posOverrideReasonCodeSchema = z.enum(posOverrideReasonCodes);
export type PosOverrideReasonCode = z.infer<typeof posOverrideReasonCodeSchema>;

const overrideReasonSchema = z.string().trim().min(3).max(500);
const overrideValueSchema = idrSchema.refine(
  (value) => value >= 0,
  "valueIdr must be >= 0",
);

/**
 * The requester (session or POS service) asks for an override. The approver
 * is either present (`supervisor_pin`: their tile + pin on this device) or
 * remote (`supervisor_phone`: a request in the approval inbox). The outlet
 * must be inside the requester's own membership (checked by the service).
 */
export const createPosOverrideSchema = clientInputSchema({
  outletId: outletIdSchema,
  action: z.enum(POS_OVERRIDE_ACTIONS),
  /** Value affected; 0 for a no-sale drawer open (posOverrideSchema). */
  valueIdr: overrideValueSchema,
  reason: overrideReasonSchema,
  reasonCode: posOverrideReasonCodeSchema.optional(),
  /** The object the override acts on (order, order_item, cash_drawer...). */
  objectType: objectTypeSchema,
  objectId: objectIdSchema,
  approval: z.discriminatedUnion("method", [
    z.strictObject({
      method: z.literal("supervisor_pin"),
      approverUserId: userIdSchema,
      pin: staffPinInputSchema,
    }),
    z.strictObject({ method: z.literal("supervisor_phone") }),
  ]),
});
export type CreatePosOverrideInput = z.infer<typeof createPosOverrideSchema>;

export const posOverrideParamsSchema = z.strictObject({
  overrideId: posOverrideIdSchema,
});

/** One override request as the POS sees it. */
export const posOverrideViewSchema = z
  .strictObject({
    id: posOverrideIdSchema,
    tenantId: tenantIdSchema,
    outletId: outletIdSchema,
    action: z.enum(POS_OVERRIDE_ACTIONS),
    method: z.enum(POS_OVERRIDE_METHODS),
    status: z.enum(POS_OVERRIDE_STATUSES),
    requestedBy: userIdSchema,
    approvedBy: userIdSchema.nullable(),
    reasonCode: z.string().min(1).max(50).nullable(),
    reason: overrideReasonSchema,
    /** Null when hidden from this viewer (blind cash count: the requester never sees the variance). */
    valueIdr: overrideValueSchema.nullable(),
    objectType: objectTypeSchema,
    objectId: objectIdSchema,
    approvalRequestId: z.uuid().toLowerCase().nullable(),
    createdAt: isoDateTimeSchema,
    resolvedAt: isoDateTimeSchema.nullable(),
  })
  .superRefine((row, ctx) => {
    const add = (path: string, message: string, invalid: boolean) => {
      if (invalid) ctx.addIssue({ code: "custom", path: [path], message });
    };
    add(
      "approvedBy",
      "An approved override names its approver; nothing else does (AUTH-06)",
      (row.status === "approved") !== (row.approvedBy !== null),
    );
    add(
      "approvedBy",
      "Approver must differ from requester (AUTH-06)",
      row.approvedBy !== null &&
        row.approvedBy.toLowerCase() === row.requestedBy.toLowerCase(),
    );
    add(
      "approvalRequestId",
      "A phone approval links its approval request; a PIN override does not",
      (row.method === "supervisor_phone") !== (row.approvalRequestId !== null),
    );
    add(
      "status",
      "A PIN override is recorded approved at once",
      row.method === "supervisor_pin" && row.status !== "approved",
    );
    add(
      "resolvedAt",
      "Only a pending request is unresolved",
      (row.status === "pending") !== (row.resolvedAt === null),
    );
  });
export type PosOverrideView = z.infer<typeof posOverrideViewSchema>;

/**
 * The AUTH-06 record of an approved override; null for anything else, and
 * null when the value is hidden from this view (a record needs its value).
 */
export function posOverrideRecordOf(view: PosOverrideView): PosOverride | null {
  if (
    view.status !== "approved" ||
    view.approvedBy === null ||
    view.valueIdr === null
  )
    return null;
  return posOverrideSchema.parse({
    id: view.id,
    outletId: view.outletId,
    action: view.action,
    requestedBy: view.requestedBy,
    approvedBy: view.approvedBy,
    method: view.method,
    reasonCode: view.reasonCode,
    reason: view.reason,
    valueIdr: view.valueIdr,
    approvalRequestId: view.approvalRequestId,
    occurredAt: view.resolvedAt ?? view.createdAt,
  });
}

// ---------------------------------------------------------------- endpoints

/**
 * Switch user on a registered outlet device (X-Device-Token). Same path as
 * identity `verifyStaffPin`; the body adds the staff tile (see file header).
 */
export const verifyStaffPinForUser = defineEndpoint({
  method: "POST",
  path: "/api/staff-pins/verify",
  body: verifyStaffPinForUserSchema,
  response: dataResponseSchema(staffPinSwitchSchema),
});

/** Ask for a supervisor override. 201 created, 200 for an idempotent replay. */
export const createPosOverride = defineEndpoint({
  method: "POST",
  path: "/api/pos-overrides",
  body: createPosOverrideSchema,
  response: dataResponseSchema(posOverrideViewSchema),
});

/** Poll a phone-approved override; resolves it once the approval chain ends. */
export const getPosOverride = defineEndpoint({
  method: "GET",
  path: "/api/pos-overrides/:overrideId",
  params: posOverrideParamsSchema,
  response: dataResponseSchema(posOverrideViewSchema),
});

/**
 * Supervisors the POS PIN dialog may offer for one override action (card 1268
 * B3). Only the staff the server will accept: they hold the action's approve
 * permission (`POS_OVERRIDE_APPROVE_PERMISSION`) at the outlet and have a
 * usable staff PIN there; the requester never appears. Answered only to a
 * valid staff session at that outlet, never to a bare shared device.
 */
export const posOverrideApproversQuerySchema = z.strictObject({
  outletId: outletIdSchema,
  action: z.enum(POS_OVERRIDE_ACTIONS),
});
export type PosOverrideApproversQuery = z.infer<
  typeof posOverrideApproversQuerySchema
>;

export const posOverrideApproverSchema = z.strictObject({
  userId: userIdSchema,
  displayName: z.string().min(1),
});
export type PosOverrideApprover = z.infer<typeof posOverrideApproverSchema>;

export const listPosOverrideApprovers = defineEndpoint({
  method: "GET",
  path: "/api/pos-overrides/approvers",
  query: posOverrideApproversQuerySchema,
  response: dataResponseSchema(z.array(posOverrideApproverSchema)),
});

/**
 * PhoneWait poll (sub-brief E3): the acting cashier reads their own phone
 * override's approval request (`:requestId` = its `approvalRequestId`) at the
 * device's outlet, as the latest level of its chain. Same guards and scope as
 * `cancelPosOverrideApproval`; anything else is 404.
 */
export const getPosOverrideApproval = defineEndpoint({
  method: "GET",
  path: "/api/pos-overrides/approvals/:requestId",
  params: approvalRequestParamsSchema,
  response: dataResponseSchema(approvalRequestSchema),
});

/**
 * POS "Berhenti menunggu" (sub-brief E3): the device's acting cashier
 * withdraws their own pending phone override (`createPosOverride` with
 * `supervisor_phone`; `:requestId` = its `approvalRequestId`) at the device's
 * outlet; the override then ends as `cancelled`. Needs the device token and
 * the X-Acting-Staff token, not the back-office MFA. 200 cancelled (also on a
 * repeat), 404 for anyone else's or a non-POS request, 409 once decided.
 */
export const cancelPosOverrideApproval = defineEndpoint({
  method: "POST",
  path: "/api/pos-overrides/approvals/:requestId/cancel",
  params: approvalRequestParamsSchema,
  response: dataResponseSchema(approvalRequestSchema),
});

// ------------------------------------------------------------------- events

/**
 * Hash material of a pin set on an edge node (legend-kyie), so the cloud can
 * adopt it. Same shape as the edge replication record: hash, salt, cost and
 * pepper version, never the pin or the pepper. `setAt` is the edge's
 * `pin_set_at`, the ordering key of pin generations.
 */
export const staffPinSetMaterialSchema = z.strictObject({
  algorithm: z.literal(STAFF_PIN_HASH_ALGORITHM),
  /** Random per-pin salt, base64 (16 bytes). */
  salt: z
    .string()
    .regex(/^[A-Za-z0-9+/]{22}==$/, "Expected a 16-byte base64 salt"),
  pinHash: identityDigestSchema,
  params: staffPinKdfParamsSchema,
  pepperVersion: z.number().int().min(1),
  setAt: isoDateTimeSchema,
});
export type StaffPinSetMaterial = z.infer<typeof staffPinSetMaterialSchema>;

/** A pin was set or reset (the counter and lock are cleared with it). */
export const staffPinSetEvent = defineDomainEvent({
  name: "staff_pin.set",
  payload: z.strictObject({
    staffPinId: staffPinIdSchema,
    userId: userIdSchema,
    setBy: userIdSchema,
    /** True when the staff member set their own pin. */
    self: z.boolean(),
    /** Edge node only (legend-kyie); absent on the cloud and on old events. */
    material: staffPinSetMaterialSchema.optional(),
  }),
});

/** The fifth consecutive miss locked a pin (§3 F6). */
export const staffPinLockedEvent = defineDomainEvent({
  name: "staff_pin.locked",
  payload: z.strictObject({
    staffPinId: staffPinIdSchema,
    userId: userIdSchema,
    lockedUntil: isoDateTimeSchema,
  }),
});

/**
 * AUTH-06: an approved override, with requester, approver and value. For
 * `cash_shift_close` the value is the variance of the cashier's blind count,
 * which is secret from the cashier (legend-o0w6): the event never carries it
 * (`valueIdr` null). The value stays in the supervisor-only audit and the
 * override row. The refine acts when the event is written; edge-to-cloud
 * ingest checks only the generic envelope, so v1 rows written before this
 * change (with the number) still sync, and still hold the number in the
 * outbox, edge queue and conflict tables (database access only).
 *
 * legend-7iti: an override approved on an edge node carries the count's
 * figures in `shiftCloseVariance`, edge process only, so the cloud audit row
 * shows them as a cloud override's audit does. The edge event travels edge ->
 * cloud only (never to a cashier device); `valueIdr` stays null.
 */
export const posOverrideRecordedEvent = defineDomainEvent({
  name: "pos_override.recorded",
  payload: z
    .strictObject({
      overrideId: posOverrideIdSchema,
      action: z.enum(POS_OVERRIDE_ACTIONS),
      method: z.enum(POS_OVERRIDE_METHODS),
      requestedBy: userIdSchema,
      approvedBy: userIdSchema,
      valueIdr: overrideValueSchema.nullable(),
      objectType: objectTypeSchema,
      objectId: objectIdSchema,
      approvalRequestId: z.uuid().toLowerCase().nullable(),
      /** legend-kyie: for the cloud audit row; optional on old events. */
      reasonCode: z.string().min(1).max(50).nullable().optional(),
      reason: z.string().trim().min(3).max(500).optional(),
      /**
       * legend-7iti: the blind-count figures of a `cash_shift_close` override
       * approved on an edge node, so the cloud audit row carries them like a
       * cloud override's audit. Edge process only (it travels edge -> cloud;
       * the cloud's own event never carries it); absent on old events.
       */
      shiftCloseVariance: z
        .strictObject({
          expectedIdr: idrSchema,
          countedIdr: idrSchema,
          varianceIdr: idrSchema,
        })
        .optional(),
    })
    .refine(
      (payload) =>
        payload.action !== "cash_shift_close" || payload.valueIdr === null,
      {
        message: "cash_shift_close must not carry valueIdr (blind count)",
        path: ["valueIdr"],
      },
    )
    .refine(
      (payload) =>
        payload.shiftCloseVariance === undefined ||
        payload.action === "cash_shift_close",
      {
        message: "shiftCloseVariance belongs to cash_shift_close only",
        path: ["shiftCloseVariance"],
      },
    ),
});
