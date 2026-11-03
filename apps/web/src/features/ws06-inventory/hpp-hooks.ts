// The only way the HPP screens touch report data: React Query hooks with the
// endpoint keys from hpp-queries.ts. The reports are read-only, so there are
// no mutations here.
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { HPP_LIST_LIMIT, type HppPeriod } from "./hpp-lib";
import {
  coverageQuery,
  engineeringQuery,
  foodCostQuery,
  menuCostsQuery,
} from "./hpp-queries";
import { INVENTORY_OUTLET_ID } from "./outlet";

export function useMenuCosts() {
  return useQuery(
    menuCostsQuery({ outletId: INVENTORY_OUTLET_ID, limit: HPP_LIST_LIMIT }),
  );
}

export function useFoodCost(period: HppPeriod) {
  return useQuery(
    foodCostQuery({
      outletId: INVENTORY_OUTLET_ID,
      fromDate: period.fromDate,
      toDate: period.toDate,
      limit: HPP_LIST_LIMIT,
    }),
  );
}

export function useMenuEngineering(period: HppPeriod) {
  return useQuery(
    engineeringQuery({
      outletId: INVENTORY_OUTLET_ID,
      fromDate: period.fromDate,
      toDate: period.toDate,
      limit: HPP_LIST_LIMIT,
    }),
  );
}

export function useRecipeCoverage() {
  return useQuery(coverageQuery({ limit: HPP_LIST_LIMIT }));
}

// ---- Connection ----------------------------------------------------------

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

const onlineSnapshot = () => navigator.onLine;
const serverSnapshot = () => true;

/**
 * `navigator.onLine`, kept current across online/offline events. The server
 * snapshot assumes online so SSR and the first client render agree.
 */
export function useOnlineStatus(): boolean {
  return React.useSyncExternalStore(
    subscribeOnline,
    onlineSnapshot,
    serverSnapshot,
  );
}
