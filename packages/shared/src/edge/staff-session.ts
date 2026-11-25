// Staff PIN login on the outlet edge (E2, brief 1269): a registered device's
// token plus a staff PIN open a session bound to that device. Edge only
// (`POST /api/edge/staff-session`); the cloud answers 404 EDGE_ONLY_ROUTE.
import {
  dataResponseSchema,
  isoDateTimeSchema,
  outletIdSchema,
  userIdSchema,
  z,
} from "../core/index.ts";
import { verifyStaffPinForUserSchema } from "../access/override.ts";
import type { PermissionCode } from "../access/permissions.ts";

/** Longest life of an edge staff session; a device revocation ends it earlier. */
export const EDGE_STAFF_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Device types a staff member signs in on. */
export const EDGE_STAFF_SESSION_DEVICE_TYPES = [
  "pos",
  "kds",
  "waiter_phone",
] as const;

/**
 * The only permissions an edge staff session can carry, and only when the
 * user's role holds them (deny by default: a code that is not here grants
 * nothing). No `pos.*.approve`: an approver proves it with their own PIN. No
 * refund, write-off, master data or payment administration.
 */
export const EDGE_STAFF_SESSION_PERMISSIONS: readonly PermissionCode[] = [
  "order.view",
  "order.create",
  "pos.sale.create",
  "pos.payment.accept",
  "pos.discount.apply",
  "pos.void.request",
  "shift.cash.operate",
  "shift.cash.approve_close",
  "shift.cash.view_all",
  "pos.day.close",
  "floor.table.view",
  "floor.table.operate",
  "floor.session.open_bill",
  "kds.ticket.process",
  "kds.expo.operate",
];

export const edgeStaffSessionRequestSchema = z.strictObject({
  userId: verifyStaffPinForUserSchema.shape.userId,
  pin: verifyStaffPinForUserSchema.shape.pin,
});
export type EdgeStaffSessionRequest = z.infer<
  typeof edgeStaffSessionRequestSchema
>;

export const edgeStaffSessionSchema = z.strictObject({
  staff: z.strictObject({ id: userIdSchema, displayName: z.string() }),
  outletId: outletIdSchema,
  expiresAt: isoDateTimeSchema,
});
export type EdgeStaffSession = z.infer<typeof edgeStaffSessionSchema>;
export const edgeStaffSessionResponseSchema = dataResponseSchema(
  edgeStaffSessionSchema,
);
