// One typed caller per supplier endpoint the back office uses (docs/frontend.md
// "Typed endpoints and mock mode"). Components never call these directly: the
// hooks in ./supplier-hooks.ts own cache keys and invalidation.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  createSupplier as createSupplierEndpoint,
  createSupplierCatalogItem as createSupplierCatalogItemEndpoint,
  createSupplierContact as createSupplierContactEndpoint,
  getSupplier,
  getSupplierPerformance,
  getSupplierPriceHistory,
  listSupplierCatalog,
  listSuppliers,
  updateSupplier as updateSupplierEndpoint,
} from "@starter/shared/inventory";
import { callEndpoint } from "@/lib/api/endpoint";

type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];
type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];

let mockHandlers: Promise<void> | undefined;

/**
 * `supplier-mock.ts` is not a `features/<name>/mock.ts` file, so the eager
 * handler glob in `lib/mock/transport.ts` does not load it. Register it before
 * the first supplier call, like `lib/api/client.ts` loads the mock transport:
 * a normal build replaces the flag and compiles the import out. The registry
 * would throw on a duplicate, so this module keeps the endpoints the existing
 * `features/ws06-purchasing/mock.ts` already owns (listSuppliers and
 * listSupplierCatalog) untouched.
 */
function ensureMockHandlers(): Promise<void> {
  if (import.meta.env.VITE_API_MOCK !== "true") return Promise.resolve();
  mockHandlers ??= import("./supplier-mock.ts").then(() => undefined);
  return mockHandlers;
}

// ---- Reads ---------------------------------------------------------------

export const fetchSuppliers = async (
  query: Query<typeof listSuppliers>,
  signal?: AbortSignal,
) => {
  await ensureMockHandlers();
  return callEndpoint(listSuppliers, { query }, { signal });
};

export const fetchSupplierDetail = async (
  params: Params<typeof getSupplier>,
  signal?: AbortSignal,
) => {
  await ensureMockHandlers();
  return callEndpoint(getSupplier, { params }, { signal });
};

export const fetchSupplierCatalog = async (
  params: Params<typeof listSupplierCatalog>,
  query: Query<typeof listSupplierCatalog>,
  signal?: AbortSignal,
) => {
  await ensureMockHandlers();
  return callEndpoint(listSupplierCatalog, { params, query }, { signal });
};

export const fetchSupplierPriceHistory = async (
  params: Params<typeof getSupplierPriceHistory>,
  query: Query<typeof getSupplierPriceHistory>,
  signal?: AbortSignal,
) => {
  await ensureMockHandlers();
  return callEndpoint(getSupplierPriceHistory, { params, query }, { signal });
};

export const fetchSupplierPerformance = async (
  params: Params<typeof getSupplierPerformance>,
  query: Query<typeof getSupplierPerformance>,
  signal?: AbortSignal,
) => {
  await ensureMockHandlers();
  return callEndpoint(getSupplierPerformance, { params, query }, { signal });
};

// ---- Writes --------------------------------------------------------------

export const createSupplier = async (
  body: Body<typeof createSupplierEndpoint>,
) => {
  await ensureMockHandlers();
  return callEndpoint(createSupplierEndpoint, { body });
};

export const updateSupplier = async (
  params: Params<typeof updateSupplierEndpoint>,
  body: Body<typeof updateSupplierEndpoint>,
) => {
  await ensureMockHandlers();
  return callEndpoint(updateSupplierEndpoint, { params, body });
};

export const createContact = async (
  params: Params<typeof createSupplierContactEndpoint>,
  body: Body<typeof createSupplierContactEndpoint>,
) => {
  await ensureMockHandlers();
  return callEndpoint(createSupplierContactEndpoint, { params, body });
};

export const createCatalogItem = async (
  params: Params<typeof createSupplierCatalogItemEndpoint>,
  body: Body<typeof createSupplierCatalogItemEndpoint>,
) => {
  await ensureMockHandlers();
  return callEndpoint(createSupplierCatalogItemEndpoint, { params, body });
};
