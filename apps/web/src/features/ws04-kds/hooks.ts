import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
} from "./api.ts";
import {
  boardQuery,
  kdsKeys,
  menuStationsQuery,
  stationsQuery,
} from "./queries.ts";

export const useStations = () => useQuery(stationsQuery());
export const useMenuStations = () => useQuery(menuStationsQuery());
export const useBoard = (id: StationConfig["stationId"]) =>
  useQuery(boardQuery(id));
export function useKdsActions() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: kdsKeys.all });
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
          return ticketAction(action.id, action.action, action.reason);
        case "priority":
          return setPriority(action.id, action.priority);
        case "item":
          return updateItem(action.id, action.action);
        case "soldOut":
          return markUnavailable(action.id);
      }
    },
    onSuccess: refresh,
  });
}
