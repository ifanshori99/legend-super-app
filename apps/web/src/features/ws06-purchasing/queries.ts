import { listExampleOutlets } from "@starter/shared/api";
import {
  getPurchaseOrder,
  getPurchaseRequest,
  listInventoryItems,
  listPurchaseOrders,
  listPurchaseRequests,
  listSupplierCatalog,
  listSuppliers,
  listUoms,
} from "@starter/shared/inventory";
import { endpointQueryOptions } from "@/lib/api/endpoint";

export const outletsQuery = () =>
  endpointQueryOptions(listExampleOutlets, { query: { limit: 100 } });
export const purchaseRequestsQuery = (outletId: string) =>
  endpointQueryOptions(listPurchaseRequests, {
    query: { outletId, limit: 100 },
  });
export const purchaseOrdersQuery = (outletId: string) =>
  endpointQueryOptions(listPurchaseOrders, { query: { outletId, limit: 100 } });
export const purchaseRequestQuery = (id: string) =>
  endpointQueryOptions(getPurchaseRequest, {
    params: { purchaseRequestId: id },
  });
export const purchaseOrderQuery = (id: string) =>
  endpointQueryOptions(getPurchaseOrder, { params: { purchaseOrderId: id } });
export const suppliersQuery = () =>
  endpointQueryOptions(listSuppliers, { query: { limit: 100 } });
export const inventoryItemsQuery = () =>
  endpointQueryOptions(listInventoryItems, { query: { limit: 100 } });
export const uomsQuery = () =>
  endpointQueryOptions(listUoms, { query: { limit: 100 } });
export const supplierCatalogQuery = (id: string) =>
  endpointQueryOptions(listSupplierCatalog, {
    params: { supplierId: id },
    query: { limit: 100 },
  });
