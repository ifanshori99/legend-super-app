// Fixture-backed supplier endpoints (bead legend-xjb; PRD v1.7 §3 F18
// "Supplier"). Loaded lazily from ./supplier-api.ts in mock mode: the eager
// handler glob only picks up `features/<name>/mock.ts`, and this feature's
// pre-existing handlers stay in `features/ws06-purchasing/mock.ts`.
//
// `listSuppliers` and `listSupplierCatalog` are registered there, so they are
// NOT registered here (the registry throws on a duplicate). Their handlers read
// the shared fixtures directly, which is why a supplier or catalog row created
// below does not appear in those lists in mock mode — a mock-only gap reported
// by the bead.
import { ApiError } from "@/lib/api/errors";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import {
  cafeLegendPurchasingFixtures as fixtures,
  createSupplier,
  createSupplierCatalogItem,
  createSupplierContact,
  getSupplier,
  getSupplierPerformance,
  getSupplierPriceHistory,
  supplierCatalogItemSchema,
  supplierContactSchema,
  supplierDetailSchema,
  supplierPerformanceSchema,
  supplierPriceHistory,
  supplierSchema,
  updateSupplier,
} from "@starter/shared/inventory";
import { newIdempotencyKey } from "../../lib/idempotency.ts";

const now = () => new Date().toISOString();
const mint = () => newIdempotencyKey();
const tenantId = fixtures.suppliers[0].tenantId;

const store = createMockStore(() => ({
  suppliers: structuredClone(fixtures.suppliers),
  contacts: structuredClone(fixtures.supplierContacts),
  catalog: structuredClone(fixtures.supplierCatalog),
  performances: structuredClone(fixtures.supplierPerformances),
  receipts: new Map<string, { fingerprint: string; value: unknown }>(),
}));

const missing = (): never => {
  throw new ApiError(404, "NOT_FOUND", "Supplier tidak ditemukan.");
};

/**
 * A create is retried with the same Idempotency-Key after a timeout or drop.
 * Same key + same payload returns the stored response; a different payload is
 * a conflict, exactly like the API (mocks must behave like the real provider).
 */
function once<T>(key: string, payload: unknown, run: () => T): T {
  const fingerprint = JSON.stringify(payload);
  const existing = store.get().receipts.get(key);
  if (existing) {
    if (existing.fingerprint !== fingerprint)
      throw new ApiError(409, "CONFLICT", "Idempotency-Key dipakai ulang.");
    return structuredClone(existing.value) as T;
  }
  const value = run();
  store.get().receipts.set(key, { fingerprint, value: structuredClone(value) });
  return value;
}

function supplierOrMissing(supplierId: string) {
  return (
    store.get().suppliers.find((supplier) => supplier.id === supplierId) ??
    missing()
  );
}

/** An honest report for a period without deliveries: zeros, null rates. */
function emptyPerformance(
  supplierId: string,
  fromDate: string,
  toDate: string,
) {
  return supplierPerformanceSchema.parse({
    tenantId,
    supplierId,
    fromDate,
    toDate,
    deliveriesTotal: 0,
    onTimeDeliveries: 0,
    onTimeRateBp: null,
    receivedQty: "0.0000",
    rejectedQty: "0.0000",
    rejectionRateBp: null,
    priceVarianceBp: null,
    computedAt: now(),
  });
}

// ---- Reads ---------------------------------------------------------------

registerMock(getSupplier, ({ params, scenario }) => {
  if (scenario === "empty") return missing();
  const supplier = supplierOrMissing(params.supplierId);
  const contacts = store
    .get()
    .contacts.filter((contact) => contact.supplierId === supplier.id);
  return { data: supplierDetailSchema.parse({ supplier, contacts }) };
});

registerMock(getSupplierPriceHistory, ({ params, query, scenario }) => {
  supplierOrMissing(params.supplierId);
  if (scenario === "empty") return { data: [] };
  return {
    data: supplierPriceHistory(
      store.get().catalog,
      params.supplierId,
      query.inventoryItemId,
    ),
  };
});

registerMock(getSupplierPerformance, ({ params, query, scenario }) => {
  const supplier = supplierOrMissing(params.supplierId);
  if (query.fromDate > query.toDate)
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Periode tidak boleh berakhir sebelum mulai.",
    );
  if (scenario === "empty")
    return {
      data: emptyPerformance(supplier.id, query.fromDate, query.toDate),
    };
  const report = store
    .get()
    .performances.find(
      (row) =>
        row.supplierId === params.supplierId &&
        row.fromDate === query.fromDate &&
        row.toDate === query.toDate,
    );
  return {
    data: report ?? emptyPerformance(supplier.id, query.fromDate, query.toDate),
  };
});

// ---- Writes --------------------------------------------------------------

registerMock(createSupplier, ({ body }) =>
  once(`supplier-create:${body.idempotencyKey}`, body, () => {
    const time = now();
    const supplier = supplierSchema.parse({
      id: mint(),
      tenantId,
      name: body.name,
      legalName: body.legalName ?? null,
      contactName: body.contactName ?? null,
      phone: body.phone ?? null,
      email: body.email ?? null,
      address: body.address ?? null,
      paymentTermsDays: body.paymentTermsDays,
      rating: body.rating ?? null,
      isActive: true,
      createdAt: time,
      updatedAt: time,
    });
    store.get().suppliers.unshift(supplier);
    return { data: supplier };
  }),
);

registerMock(updateSupplier, ({ params, body }) => {
  const state = store.get();
  const index = state.suppliers.findIndex(
    (supplier) => supplier.id === params.supplierId,
  );
  if (index === -1) return missing();
  const current = state.suppliers[index];
  // CORE PRECONDITION_FAILED on a stale value (contract comment on
  // updateSupplierInputSchema.expectedUpdatedAt).
  if (current.updatedAt !== body.expectedUpdatedAt)
    throw new ApiError(
      412,
      "PRECONDITION_FAILED",
      "Data supplier sudah berubah. Muat ulang lalu coba lagi.",
    );
  const next = supplierSchema.parse({
    ...current,
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.legalName !== undefined ? { legalName: body.legalName } : {}),
    ...(body.contactName !== undefined
      ? { contactName: body.contactName }
      : {}),
    ...(body.phone !== undefined ? { phone: body.phone } : {}),
    ...(body.email !== undefined ? { email: body.email } : {}),
    ...(body.address !== undefined ? { address: body.address } : {}),
    ...(body.paymentTermsDays !== undefined
      ? { paymentTermsDays: body.paymentTermsDays }
      : {}),
    ...(body.rating !== undefined ? { rating: body.rating } : {}),
    ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
    updatedAt: now(),
  });
  state.suppliers[index] = next;
  return { data: next };
});

registerMock(createSupplierContact, ({ params, body }) =>
  once(`supplier-contact:${body.idempotencyKey}`, { params, body }, () => {
    const state = store.get();
    supplierOrMissing(params.supplierId);
    // One primary contact per supplier (contract `primarySupplierContact`):
    // flagging a new one clears the old flag.
    if (body.isPrimary)
      state.contacts = state.contacts.map((contact) =>
        contact.supplierId === params.supplierId && contact.isPrimary
          ? supplierContactSchema.parse({ ...contact, isPrimary: false })
          : contact,
      );
    const contact = supplierContactSchema.parse({
      id: mint(),
      tenantId,
      supplierId: params.supplierId,
      name: body.name,
      role: body.role ?? null,
      phone: body.phone,
      email: body.email ?? null,
      isPrimary: body.isPrimary,
    });
    state.contacts.push(contact);
    return { data: contact };
  }),
);

registerMock(createSupplierCatalogItem, ({ params, body }) =>
  once(`supplier-catalog:${body.idempotencyKey}`, { params, body }, () => {
    const state = store.get();
    supplierOrMissing(params.supplierId);
    const item = supplierCatalogItemSchema.parse({
      id: mint(),
      tenantId,
      supplierId: params.supplierId,
      inventoryItemId: body.inventoryItemId,
      purchaseUomId: body.purchaseUomId,
      priceIdr: body.priceIdr,
      effectiveFrom: body.effectiveFrom,
      isActive: true,
      createdAt: now(),
    });
    state.catalog.unshift(item);
    return { data: item };
  }),
);
