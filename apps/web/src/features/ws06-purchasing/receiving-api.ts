// Typed callers for the WS-06 receiving screens (bead legend-xkk; PRD v1.7 §3
// F18, INV-05). Reads and writes both go through this module so mock handlers
// are registered before the first request; the Idempotency-Key header carries
// the same key as the write body so the API can deduplicate a retry
// (docs/plan/contracts.md).
//
// `receiving-mock.ts` is not a `features/<name>/mock.ts` file, so the eager
// handler glob in lib/mock/transport.ts does not load it. Register it before
// the first receiving call, like lib/api/client.ts loads the mock transport;
// a normal build replaces the flag and compiles the import out. The registry
// itself refuses a second registration of an endpoint another module owns.
import type {
  AnyEndpoint,
  EndpointInput,
  EndpointOutput,
} from "@starter/shared/api";
import {
  createGoodsReceipt as createGoodsReceiptEndpoint,
  createPettyPurchase as createPettyPurchaseEndpoint,
  createPurchaseReturn as createPurchaseReturnEndpoint,
  createSupplierInvoice as createSupplierInvoiceEndpoint,
  createSupplierPayment as createSupplierPaymentEndpoint,
  getGoodsReceipt,
  getPettyPurchase,
  getPettyPurchasePolicy,
  getPurchaseReturn,
  getSupplierInvoice,
  getSupplierPayment,
  journalizeGoodsReceipt as journalizeGoodsReceiptEndpoint,
  listGoodsReceipts,
  listPettyPurchases,
  listPurchaseReturns,
  listSupplierInvoices,
  listSupplierPayments,
  postSupplierInvoiceMatch as postSupplierInvoiceMatchEndpoint,
  postSupplierPaymentTransition as postSupplierPaymentTransitionEndpoint,
} from "@starter/shared/inventory";
import { callEndpoint } from "@/lib/api/endpoint";
import type { CallArgs } from "@/lib/api/endpoint";

type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];
type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];

let mockHandlers: Promise<void> | undefined;
function ensureMockHandlers() {
  if (import.meta.env.VITE_API_MOCK !== "true") return Promise.resolve();
  mockHandlers ??= import("./receiving-mock.ts").then(() => undefined);
  return mockHandlers;
}

/** GET caller that registers the feature's mock handlers first (mock mode). */
async function fetchEndpoint<E extends AnyEndpoint & { method: "GET" }>(
  endpoint: E,
  input: EndpointInput<E>,
  signal?: AbortSignal,
): Promise<EndpointOutput<E>> {
  await ensureMockHandlers();
  return callEndpoint(
    endpoint,
    ...([input, { signal }] as unknown as CallArgs<E>),
  );
}

// ---- Reads ---------------------------------------------------------------

export const fetchGoodsReceipts = (
  query: Query<typeof listGoodsReceipts>,
  signal?: AbortSignal,
) => fetchEndpoint(listGoodsReceipts, { query }, signal);

export const fetchGoodsReceipt = (
  params: Params<typeof getGoodsReceipt>,
  signal?: AbortSignal,
) => fetchEndpoint(getGoodsReceipt, { params }, signal);

export const fetchSupplierInvoices = (
  query: Query<typeof listSupplierInvoices>,
  signal?: AbortSignal,
) => fetchEndpoint(listSupplierInvoices, { query }, signal);

export const fetchSupplierInvoice = (
  params: Params<typeof getSupplierInvoice>,
  signal?: AbortSignal,
) => fetchEndpoint(getSupplierInvoice, { params }, signal);

export const fetchSupplierPayments = (
  query: Query<typeof listSupplierPayments>,
  signal?: AbortSignal,
) => fetchEndpoint(listSupplierPayments, { query }, signal);

export const fetchSupplierPayment = (
  params: Params<typeof getSupplierPayment>,
  signal?: AbortSignal,
) => fetchEndpoint(getSupplierPayment, { params }, signal);

export const fetchPurchaseReturns = (
  query: Query<typeof listPurchaseReturns>,
  signal?: AbortSignal,
) => fetchEndpoint(listPurchaseReturns, { query }, signal);

export const fetchPurchaseReturn = (
  params: Params<typeof getPurchaseReturn>,
  signal?: AbortSignal,
) => fetchEndpoint(getPurchaseReturn, { params }, signal);

export const fetchPettyPurchases = (
  query: Query<typeof listPettyPurchases>,
  signal?: AbortSignal,
) => fetchEndpoint(listPettyPurchases, { query }, signal);

export const fetchPettyPurchase = (
  params: Params<typeof getPettyPurchase>,
  signal?: AbortSignal,
) => fetchEndpoint(getPettyPurchase, { params }, signal);

export const fetchPettyPurchasePolicy = (
  query: Query<typeof getPettyPurchasePolicy>,
  signal?: AbortSignal,
) => fetchEndpoint(getPettyPurchasePolicy, { query }, signal);

// ---- Writes --------------------------------------------------------------

export const createGoodsReceipt = async (
  body: Body<typeof createGoodsReceiptEndpoint>,
) => {
  await ensureMockHandlers();
  return callEndpoint(
    createGoodsReceiptEndpoint,
    { body },
    { headers: { "Idempotency-Key": body.idempotencyKey } },
  );
};

// The journal key is the receipt itself (server side), so a retry never books
// twice and the request carries no idempotency header.
export const journalizeGoodsReceipt = async (id: string) => {
  await ensureMockHandlers();
  return callEndpoint(journalizeGoodsReceiptEndpoint, {
    params: { goodsReceiptId: id },
    body: {},
  });
};

export const createSupplierInvoice = async (
  body: Body<typeof createSupplierInvoiceEndpoint>,
) => {
  await ensureMockHandlers();
  return callEndpoint(
    createSupplierInvoiceEndpoint,
    { body },
    { headers: { "Idempotency-Key": body.idempotencyKey } },
  );
};

export const runSupplierInvoiceMatch = async (input: {
  id: string;
  body: Body<typeof postSupplierInvoiceMatchEndpoint>;
}) => {
  await ensureMockHandlers();
  return callEndpoint(
    postSupplierInvoiceMatchEndpoint,
    { params: { supplierInvoiceId: input.id }, body: input.body },
    { headers: { "Idempotency-Key": input.body.idempotencyKey } },
  );
};

export const createSupplierPayment = async (
  body: Body<typeof createSupplierPaymentEndpoint>,
) => {
  await ensureMockHandlers();
  return callEndpoint(
    createSupplierPaymentEndpoint,
    { body },
    { headers: { "Idempotency-Key": body.idempotencyKey } },
  );
};

export const transitionSupplierPayment = async (input: {
  id: string;
  body: Body<typeof postSupplierPaymentTransitionEndpoint>;
}) => {
  await ensureMockHandlers();
  return callEndpoint(
    postSupplierPaymentTransitionEndpoint,
    { params: { supplierPaymentId: input.id }, body: input.body },
    { headers: { "Idempotency-Key": input.body.idempotencyKey } },
  );
};

export const createPurchaseReturn = async (
  body: Body<typeof createPurchaseReturnEndpoint>,
) => {
  await ensureMockHandlers();
  return callEndpoint(
    createPurchaseReturnEndpoint,
    { body },
    { headers: { "Idempotency-Key": body.idempotencyKey } },
  );
};

export const createPettyPurchase = async (
  body: Body<typeof createPettyPurchaseEndpoint>,
) => {
  await ensureMockHandlers();
  return callEndpoint(
    createPettyPurchaseEndpoint,
    { body },
    { headers: { "Idempotency-Key": body.idempotencyKey } },
  );
};
