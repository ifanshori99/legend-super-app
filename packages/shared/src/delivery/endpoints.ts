// Typed endpoint contracts for the delivery channel ops screen (PRD v1.7
// §3.23, F20, D12). Every route requires an outlet-scoped staff session and the
// RBAC permission of the action; the store open/close and status steps are the
// cashier/supervisor's job, reconciliation is finance's.
//
// Incoming platform orders arrive through webhooks, not through these routes:
// the API imports them (idempotent on `externalOrderId`) and injects them into
// the KDS. The ops screen lists them, accepts or rejects them, moves them
// along the fulfilment machine and reconciles the platform statement.

import {
  cursorPageSchema,
  dataResponseSchema,
  outletIdSchema,
  z,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import {
  createManualDeliveryOrderInputSchema,
  deliveryChannelOrderIdSchema,
  deliveryChannelOrderSchema,
  deliveryChannelSchema,
  deliveryMenuSyncResultSchema,
  deliveryPlatformSchema,
  deliveryReconciliationQuerySchema,
  deliveryReconciliationSchema,
  linkDeliveryChannelInputSchema,
  listDeliveryOrdersQuerySchema,
  resendDeliveryOrderSyncInputSchema,
  resolveDeliveryOrderSyncInputSchema,
  mapDeliveryOrderLinesInputSchema,
  setDeliveryChannelStateInputSchema,
  updateDeliveryOrderStatusInputSchema,
} from "./schemas.ts";

const outletParams = z.strictObject({ outletId: outletIdSchema });
const channelParams = z.strictObject({
  outletId: outletIdSchema,
  platform: deliveryPlatformSchema,
});
const orderParams = z.strictObject({
  outletId: outletIdSchema,
  deliveryOrderId: deliveryChannelOrderIdSchema,
});

/** Store state and menu sync status per platform (GoFood, GrabFood, ShopeeFood). */
export const listDeliveryChannels = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/delivery-channels",
  params: outletParams,
  response: dataResponseSchema(z.array(deliveryChannelSchema)),
});

/** Create the channel or change its store id (legend-cbd0); never calls the platform. */
export const linkDeliveryChannel = defineEndpoint({
  method: "PUT",
  path: "/api/outlets/:outletId/delivery-channels/:platform",
  params: channelParams,
  body: linkDeliveryChannelInputSchema,
  response: dataResponseSchema(deliveryChannelSchema),
});

/** Open or close the store on one platform. */
export const setDeliveryChannelState = defineEndpoint({
  method: "PATCH",
  path: "/api/outlets/:outletId/delivery-channels/:platform",
  params: channelParams,
  body: setDeliveryChannelStateInputSchema,
  response: dataResponseSchema(deliveryChannelSchema),
});

/** Push menu, prices and sold-out status to one platform. */
export const syncDeliveryChannelMenu = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/delivery-channels/:platform/sync",
  params: channelParams,
  response: dataResponseSchema(deliveryMenuSyncResultSchema),
});

/** Incoming and active platform orders, newest first. */
export const listDeliveryOrders = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/delivery-orders",
  params: outletParams,
  query: listDeliveryOrdersQuerySchema,
  response: cursorPageSchema(deliveryChannelOrderSchema),
});

export const getDeliveryOrder = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/delivery-orders/:deliveryOrderId",
  params: orderParams,
  response: dataResponseSchema(deliveryChannelOrderSchema),
});

/** D12 manual mode: record a platform order in the POS before integration. */
export const createManualDeliveryOrder = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/delivery-orders/manual",
  params: outletParams,
  body: createManualDeliveryOrderInputSchema,
  response: dataResponseSchema(deliveryChannelOrderSchema),
});

/** Accept, progress, cancel or reject; the service pushes the adapter action. */
export const updateDeliveryOrderStatus = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/delivery-orders/:deliveryOrderId/status",
  params: orderParams,
  body: updateDeliveryOrderStatusInputSchema,
  response: dataResponseSchema(deliveryChannelOrderSchema),
});

/**
 * Staff resend of the held step of a `platformSync: needs_action` order: one
 * platform call (same idempotent reference as the sweep). 200 with the order:
 * `platformSync` is `ok` when the platform took it, else still `needs_action`.
 * 409 `DELIVERY_SYNC_NOT_PENDING` when the order is not `needs_action`.
 */
export const resendDeliveryOrderSync = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/delivery-orders/:deliveryOrderId/platform-sync/resend",
  params: orderParams,
  body: resendDeliveryOrderSyncInputSchema,
  response: dataResponseSchema(deliveryChannelOrderSchema),
});

/**
 * Staff mark a `needs_action` order as handled in the partner app: sync flag
 * cleared (`ok`), audited with who, when and the optional reason. 409
 * `DELIVERY_SYNC_NOT_PENDING` when the order is not `needs_action`.
 */
export const resolveDeliveryOrderSync = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/delivery-orders/:deliveryOrderId/platform-sync/resolve",
  params: orderParams,
  body: resolveDeliveryOrderSyncInputSchema,
  response: dataResponseSchema(deliveryChannelOrderSchema),
});

/**
 * Staff map the unmatched or sold_out lines of a needs_review order (status
 * `received`, `orderId` null) and inject it into the KDS (legend-5d76).
 * Idempotent: an order already injected answers 200 with the current row (no
 * second KDS order). 422 `DELIVERY_MAPPING_INCOMPLETE` when a line stays
 * unmatched or sold_out, or maps to an unknown, inactive, unpriced or sold-out
 * item. 409 `DELIVERY_ORDER_CHANGED` when a mapping's `externalItemId` differs
 * from the stored line (the webhook changed the order); nothing is injected.
 */
export const mapDeliveryOrderLines = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/delivery-orders/:deliveryOrderId/map-lines",
  params: orderParams,
  body: mapDeliveryOrderLinesInputSchema,
  response: dataResponseSchema(deliveryChannelOrderSchema),
});

/** Commission reconciliation for one platform and period. */
export const getDeliveryReconciliation = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/delivery-reconciliation",
  params: outletParams,
  query: deliveryReconciliationQuerySchema,
  response: dataResponseSchema(deliveryReconciliationSchema),
});
