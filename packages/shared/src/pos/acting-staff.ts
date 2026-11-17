// Acting cashier per device (bead legend-aruta; docs/DECISIONS.md "Kasir aktif
// per perangkat lewat token server").
//
// Published as its own subpath (`@starter/shared/pos/acting-staff`): the web
// client imports the header name and error codes without pulling the POS
// barrel. After a PIN switch the server issues an opaque `pas_` token bound to
// device, outlet, staff member and login session; the client sends it in the
// `X-Acting-Staff` header and the server treats that staff member as the actor
// and permission subject of POS requests.

import {
  isoDateTimeSchema,
  outletIdSchema,
  userIdSchema,
  z,
} from "../core/index.ts";
import { verifyStaffPinForUserSchema } from "../access/override.ts";

/** Request header carrying the acting-staff token (lower case for Node). */
export const ACTING_STAFF_HEADER = "x-acting-staff";

/** Every token starts with this prefix (the PIN proof tokens use `pp_`). */
export const ACTING_STAFF_TOKEN_PREFIX = "pas_";

/** Longest life of a token; shift and day close revoke earlier. */
export const ACTING_STAFF_TTL_MS = 12 * 60 * 60 * 1000;

export const ACTING_STAFF_ERROR_CODES = {
  /** Wrong format, unknown token, or another device, session or tenant. */
  INVALID: "ACTING_STAFF_INVALID",
  EXPIRED: "ACTING_STAFF_EXPIRED",
  /** Revoked; the response details carry the reason. */
  REVOKED: "ACTING_STAFF_REVOKED",
  OUTLET_MISMATCH: "ACTING_STAFF_OUTLET_MISMATCH",
  /** The staff member is no longer active in the outlet. */
  INACTIVE: "ACTING_STAFF_INACTIVE",
  /** The header was sent to a route that does not support it (fail closed). */
  UNSUPPORTED: "ACTING_STAFF_UNSUPPORTED",
  /** The route refuses an acting staff member (e.g. receipt write-off). */
  NOT_ALLOWED: "ACTING_STAFF_NOT_ALLOWED",
  /** A registered shared outlet device sent a POS request without a cashier token. */
  REQUIRED: "ACTING_STAFF_REQUIRED",
} as const;
export type ActingStaffErrorCode =
  (typeof ACTING_STAFF_ERROR_CODES)[keyof typeof ACTING_STAFF_ERROR_CODES];

export const ACTING_STAFF_REVOKE_REASONS = [
  "switched",
  "ended",
  "shift_closed",
  "day_closed",
  "pin_reset",
  "staff_inactive",
] as const;
export type ActingStaffRevokeReason =
  (typeof ACTING_STAFF_REVOKE_REASONS)[number];

/** `POST /api/staff-pins/pos-session`: the staff tile and that person's PIN. */
export const posSessionRequestSchema = z.strictObject({
  userId: verifyStaffPinForUserSchema.shape.userId,
  pin: verifyStaffPinForUserSchema.shape.pin,
});
export type PosSessionRequest = z.infer<typeof posSessionRequestSchema>;

export const posSessionResponseSchema = z.strictObject({
  token: z.string().startsWith(ACTING_STAFF_TOKEN_PREFIX),
  expiresAt: isoDateTimeSchema,
  staff: z.strictObject({
    id: userIdSchema,
    displayName: z.string(),
  }),
  outletId: outletIdSchema,
});
export type PosSessionResponse = z.infer<typeof posSessionResponseSchema>;
