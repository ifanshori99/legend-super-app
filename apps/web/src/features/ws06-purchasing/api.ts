import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  createPurchaseOrder as createOrderEndpoint,
  createPurchaseRequest as createRequestEndpoint,
  postPurchaseOrderTransition,
  postPurchaseRequestTransition,
  sendPurchaseOrder as sendOrderEndpoint,
} from "@starter/shared/inventory";
import { callEndpoint } from "@/lib/api/endpoint";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];

export const createPurchaseRequest = (
  body: Body<typeof createRequestEndpoint>,
) => callEndpoint(createRequestEndpoint, { body });
export const transitionPurchaseRequest = (input: {
  id: string;
  body: Body<typeof postPurchaseRequestTransition>;
}) =>
  callEndpoint(postPurchaseRequestTransition, {
    params: { purchaseRequestId: input.id },
    body: input.body,
  });
export const createPurchaseOrder = (body: Body<typeof createOrderEndpoint>) =>
  callEndpoint(createOrderEndpoint, { body });
export const transitionPurchaseOrder = (input: {
  id: string;
  body: Body<typeof postPurchaseOrderTransition>;
}) =>
  callEndpoint(postPurchaseOrderTransition, {
    params: { purchaseOrderId: input.id },
    body: input.body,
  });
export const sendPurchaseOrder = (input: {
  id: string;
  body: Body<typeof sendOrderEndpoint>;
}) =>
  callEndpoint(sendOrderEndpoint, {
    params: { purchaseOrderId: input.id },
    body: input.body,
  });
