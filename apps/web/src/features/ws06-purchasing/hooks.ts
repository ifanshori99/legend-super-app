import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getPurchaseOrder,
  getPurchaseRequest,
  listPurchaseOrders,
  listPurchaseRequests,
} from "@starter/shared/inventory";
import * as api from "./api";
import * as queries from "./queries";

export const useOutlets = () => useQuery(queries.outletsQuery());
export const usePurchaseRequests = (id: string) =>
  useQuery({ ...queries.purchaseRequestsQuery(id), enabled: Boolean(id) });
export const usePurchaseOrders = (id: string) =>
  useQuery({ ...queries.purchaseOrdersQuery(id), enabled: Boolean(id) });
export const usePurchaseRequest = (id: string) =>
  useQuery({ ...queries.purchaseRequestQuery(id), enabled: Boolean(id) });
export const usePurchaseOrder = (id: string) =>
  useQuery({ ...queries.purchaseOrderQuery(id), enabled: Boolean(id) });
export const useSuppliers = () => useQuery(queries.suppliersQuery());
export const useInventoryItems = () => useQuery(queries.inventoryItemsQuery());
export const useUoms = () => useQuery(queries.uomsQuery());
export const useSupplierCatalog = (id: string) =>
  useQuery({ ...queries.supplierCatalogQuery(id), enabled: Boolean(id) });

function usePurchasingMutation<T, R>(fn: (input: T) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () =>
      Promise.all(
        [
          listPurchaseRequests,
          getPurchaseRequest,
          listPurchaseOrders,
          getPurchaseOrder,
        ].map((endpoint) =>
          client.invalidateQueries({ queryKey: [endpoint.id] }),
        ),
      ),
  });
}
export const useCreatePurchaseRequest = () =>
  usePurchasingMutation(api.createPurchaseRequest);
export const useTransitionPurchaseRequest = () =>
  usePurchasingMutation(api.transitionPurchaseRequest);
export const useCreatePurchaseOrder = () =>
  usePurchasingMutation(api.createPurchaseOrder);
export const useTransitionPurchaseOrder = () =>
  usePurchasingMutation(api.transitionPurchaseOrder);
export const useSendPurchaseOrder = () =>
  usePurchasingMutation(api.sendPurchaseOrder);
