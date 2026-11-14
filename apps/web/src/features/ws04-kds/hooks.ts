import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type {
  KitchenTicket,
  KitchenTicketItem,
  StationConfig,
} from "@starter/shared/kitchen";
import {
  markUnavailable,
  setPriority,
  ticketAction,
  updateItem,
  sendKdsHeartbeat,
} from "./api.ts";
import {
  boardQuery,
  kdsKeys,
  scannerStatusQuery,
  stationLabelsQuery,
  stationSummaryQuery,
  stationsQuery,
} from "./queries.ts";

export const useStations = (outletId: string | undefined) =>
  useQuery(stationsQuery(outletId));
export const useStationLabels = (outletId: string | undefined) =>
  useQuery(stationLabelsQuery(outletId));
export const useStationSummary = (outletId: string | undefined) =>
  useQuery(stationSummaryQuery(outletId));
export const useScannerStatus = (outletId: string | undefined) =>
  useQuery(scannerStatusQuery(outletId));
export const useBoard = (
  outletId: string | undefined,
  id: StationConfig["stationId"],
) => useQuery(boardQuery(outletId, id));

/** Only the displayed station reports liveness, never background count polls. */
export function useKdsHeartbeat(
  outletId: string,
  stationId: StationConfig["stationId"],
) {
  useEffect(() => {
    const controller = new AbortController();
    let sending = false;
    const heartbeat = async () => {
      if (document.visibilityState !== "visible" || sending) return;
      sending = true;
      try {
        await sendKdsHeartbeat(outletId, stationId, controller.signal);
      } catch {
        /* The next heartbeat retries; an unreachable screen stays down. */
      } finally {
        sending = false;
      }
    };
    const onVisible = () => {
      void heartbeat();
    };
    void heartbeat();
    const interval = window.setInterval(onVisible, 5_000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [outletId, stationId]);
}
export function useKdsActions(outletId: string) {
  const client = useQueryClient();
  const refresh = () =>
    client.invalidateQueries({ queryKey: kdsKeys.outlet(outletId) });
  return useMutation({
    mutationFn: async (
      action:
        | {
            kind: "ticket";
            id: KitchenTicket["id"];
            action: "start" | "bump" | "recall";
            reason?: string;
          }
        | { kind: "priority"; id: KitchenTicket["id"]; priority: number }
        | {
            kind: "item";
            id: KitchenTicketItem["id"];
            action: "start" | "ready";
          }
        | { kind: "soldOut"; id: KitchenTicketItem["menuItemId"] },
    ) => {
      switch (action.kind) {
        case "ticket":
          return ticketAction(
            outletId,
            action.id,
            action.action,
            action.reason,
          );
        case "priority":
          return setPriority(outletId, action.id, action.priority);
        case "item":
          return updateItem(outletId, action.id, action.action);
        case "soldOut":
          return markUnavailable(outletId, action.id);
      }
    },
    onSuccess: refresh,
  });
}
