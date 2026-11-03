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

// ---- Reads ---------------------------------------------------------------

export const fetchSuppliers = (
  query: Query<typeof listSuppliers>,
  signal?: AbortSignal,
) => callEndpoint(listSuppliers, { query }, { signal });

export const fetchSupplierDetail = (
  params: Params<typeof getSupplier>,
  signal?: AbortSignal,
) => callEndpoint(getSupplier, { params }, { signal });

export const fetchSupplierCatalog = (
  params: Params<typeof listSupplierCatalog>,
  query: Query<typeof listSupplierCatalog>,
  signal?: AbortSignal,
) => callEndpoint(listSupplierCatalog, { params, query }, { signal });

export const fetchSupplierPriceHistory = (
  params: Params<typeof getSupplierPriceHistory>,
  query: Query<typeof getSupplierPriceHistory>,
  signal?: AbortSignal,
) => callEndpoint(getSupplierPriceHistory, { params, query }, { signal });

export const fetchSupplierPerformance = (
  params: Params<typeof getSupplierPerformance>,
  query: Query<typeof getSupplierPerformance>,
  signal?: AbortSignal,
) => callEndpoint(getSupplierPerformance, { params, query }, { signal });

// ---- Writes --------------------------------------------------------------

export const createSupplier = (body: Body<typeof createSupplierEndpoint>) =>
  callEndpoint(createSupplierEndpoint, { body });

export const updateSupplier = (
  params: Params<typeof updateSupplierEndpoint>,
  body: Body<typeof updateSupplierEndpoint>,
) => callEndpoint(updateSupplierEndpoint, { params, body });

export const createContact = (
  params: Params<typeof createSupplierContactEndpoint>,
  body: Body<typeof createSupplierContactEndpoint>,
) => callEndpoint(createSupplierContactEndpoint, { params, body });

export const createCatalogItem = (
  params: Params<typeof createSupplierCatalogItemEndpoint>,
  body: Body<typeof createSupplierCatalogItemEndpoint>,
) => callEndpoint(createSupplierCatalogItemEndpoint, { params, body });
