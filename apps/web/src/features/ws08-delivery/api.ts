// One typed caller per delivery channel endpoint (docs/frontend.md "Typed
// endpoints and mock mode"). Each caller unwraps the `{ data }` envelope so
// hooks and components see the payload the contract describes; the order list
// stays a cursor page. Components never call these directly — they use
// ./hooks.ts, which owns cache keys and invalidation.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  createManualDeliveryOrder as createManualDeliveryOrderEndpoint,
  getDeliveryOrder as getDeliveryOrderEndpoint,
  getDeliveryReconciliation as getDeliveryReconciliationEndpoint,
  listDeliveryChannels as listDeliveryChannelsEndpoint,
  listDeliveryOrders as listDeliveryOrdersEndpoint,
  mapDeliveryOrderLines as mapDeliveryOrderLinesEndpoint,
  resendDeliveryOrderSync as resendDeliveryOrderSyncEndpoint,
  resolveDeliveryOrderSync as resolveDeliveryOrderSyncEndpoint,
  setDeliveryChannelState as setDeliveryChannelStateEndpoint,
  syncDeliveryChannelMenu as syncDeliveryChannelMenuEndpoint,
  updateDeliveryOrderStatus as updateDeliveryOrderStatusEndpoint,
} from "@starter/shared/delivery";
import {
  listItems as listItemsEndpoint,
  listPriceListItems as listPriceListItemsEndpoint,
  listPriceLists as listPriceListsEndpoint,
  listVariants as listVariantsEndpoint,
} from "@starter/shared/menu";
import { callEndpoint } from "@/lib/api/endpoint";
import type { CallOptions } from "@/lib/api/endpoint";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];

/** Channels, the live orders behind the review hints, menu picks. */
export const DELIVERY_LIST_LIMIT = 100;

export const fetchChannels = async (
  params: Params<typeof listDeliveryChannelsEndpoint>,
  options?: CallOptions,
) =>
  (await callEndpoint(listDeliveryChannelsEndpoint, { params }, options)).data;

export const setChannelState = async (
  params: Params<typeof setDeliveryChannelStateEndpoint>,
  body: Body<typeof setDeliveryChannelStateEndpoint>,
  options?: CallOptions,
) =>
  (
    await callEndpoint(
      setDeliveryChannelStateEndpoint,
      { params, body },
      options,
    )
  ).data;

export const syncChannelMenu = async (
  params: Params<typeof syncDeliveryChannelMenuEndpoint>,
  options?: CallOptions,
) =>
  (await callEndpoint(syncDeliveryChannelMenuEndpoint, { params }, options))
    .data;

/** Newest first (contract comment); the tab appends the next cursor page. */
export const fetchOrders = (
  params: Params<typeof listDeliveryOrdersEndpoint>,
  query: Query<typeof listDeliveryOrdersEndpoint>,
  options?: CallOptions,
) => callEndpoint(listDeliveryOrdersEndpoint, { params, query }, options);

export const fetchOrder = async (
  params: Params<typeof getDeliveryOrderEndpoint>,
  options?: CallOptions,
) => (await callEndpoint(getDeliveryOrderEndpoint, { params }, options)).data;

/** D12 manual mode: the server resolves prices from the channel price list. */
export const createManualOrder = async (
  params: Params<typeof createManualDeliveryOrderEndpoint>,
  body: Body<typeof createManualDeliveryOrderEndpoint>,
  options?: CallOptions,
) =>
  (
    await callEndpoint(
      createManualDeliveryOrderEndpoint,
      { params, body },
      options,
    )
  ).data;

export const updateOrderStatus = async (
  params: Params<typeof updateDeliveryOrderStatusEndpoint>,
  body: Body<typeof updateDeliveryOrderStatusEndpoint>,
  options?: CallOptions,
) =>
  (
    await callEndpoint(
      updateDeliveryOrderStatusEndpoint,
      { params, body },
      options,
    )
  ).data;

/** Staff resend of the held step (Q58): one press, one request. */
export const resendOrderSync = async (
  params: Params<typeof resendDeliveryOrderSyncEndpoint>,
  options?: CallOptions,
) =>
  (
    await callEndpoint(
      resendDeliveryOrderSyncEndpoint,
      { params, body: {} },
      options,
    )
  ).data;

/** Staff marks the order handled in the partner app; the server audits it. */
export const resolveOrderSync = async (
  params: Params<typeof resolveDeliveryOrderSyncEndpoint>,
  body: Body<typeof resolveDeliveryOrderSyncEndpoint>,
  options?: CallOptions,
) =>
  (
    await callEndpoint(
      resolveDeliveryOrderSyncEndpoint,
      { params, body },
      options,
    )
  ).data;

/** Staff map the unmatched lines of a needs_review order; the server injects it. */
export const mapOrderLines = async (
  params: Params<typeof mapDeliveryOrderLinesEndpoint>,
  body: Body<typeof mapDeliveryOrderLinesEndpoint>,
  options?: CallOptions,
) =>
  (await callEndpoint(mapDeliveryOrderLinesEndpoint, { params, body }, options))
    .data;

export const fetchReconciliation = async (
  params: Params<typeof getDeliveryReconciliationEndpoint>,
  query: Query<typeof getDeliveryReconciliationEndpoint>,
  options?: CallOptions,
) =>
  (
    await callEndpoint(
      getDeliveryReconciliationEndpoint,
      { params, query },
      options,
    )
  ).data;

/**
 * Active menu items for the manual order picker. A read of the WS-03 back
 * office (its mock is registered by `features/ws03-menu/mock.ts`): the manual
 * form never invents a menu of its own.
 */
export const fetchMenuItems = async (
  query: Query<typeof listItemsEndpoint>,
  options?: CallOptions,
) => {
  let page = await callEndpoint(listItemsEndpoint, { query }, options);
  const data = [...page.data];
  while (page.meta.nextCursor) {
    page = await callEndpoint(
      listItemsEndpoint,
      { query: { ...query, cursor: page.meta.nextCursor } },
      options,
    );
    data.push(...page.data);
  }
  return { ...page, data };
};

/** Variants of one menu item: the mapping picker asks for one when it exists. */
export const fetchItemVariants = (
  params: Params<typeof listVariantsEndpoint>,
  options?: CallOptions,
) =>
  callEndpoint(
    listVariantsEndpoint,
    { params, query: { limit: DELIVERY_LIST_LIMIT } },
    options,
  );

/**
 * The platform's channel price list (WS-03 "harga per kanal"). Shown read-only
 * next to each manual line; the client never submits money (contract input).
 */
export const fetchPriceLists = (
  query: Query<typeof listPriceListsEndpoint>,
  options?: CallOptions,
) => callEndpoint(listPriceListsEndpoint, { query }, options);

export const fetchPriceListItems = async (
  params: Params<typeof listPriceListItemsEndpoint>,
  options?: CallOptions,
) => {
  let page = await callEndpoint(
    listPriceListItemsEndpoint,
    { params, query: { limit: DELIVERY_LIST_LIMIT } },
    options,
  );
  const data = [...page.data];
  while (page.meta.nextCursor) {
    page = await callEndpoint(
      listPriceListItemsEndpoint,
      {
        params,
        query: { limit: DELIVERY_LIST_LIMIT, cursor: page.meta.nextCursor },
      },
      options,
    );
    data.push(...page.data);
  }
  return { ...page, data };
};
