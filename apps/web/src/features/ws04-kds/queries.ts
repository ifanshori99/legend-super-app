import { queryOptions } from "@tanstack/react-query";
import type { StationConfig } from "@starter/shared/kitchen";
import { fetchBoard, fetchMenuStations, fetchStations } from "./api.ts";

export const kdsKeys = {
  all: ["kds"] as const,
  stations: ["kds", "stations"] as const,
  menuStations: ["kds", "menu-stations"] as const,
  board: (stationId: StationConfig["stationId"]) =>
    ["kds", "board", stationId] as const,
};
export const stationsQuery = () =>
  queryOptions({
    queryKey: kdsKeys.stations,
    queryFn: ({ signal }) => fetchStations(signal),
  });
export const menuStationsQuery = () =>
  queryOptions({
    queryKey: kdsKeys.menuStations,
    queryFn: ({ signal }) => fetchMenuStations(signal),
  });
export const boardQuery = (stationId: StationConfig["stationId"]) =>
  queryOptions({
    queryKey: kdsKeys.board(stationId),
    queryFn: ({ signal }) => fetchBoard(stationId, signal),
    refetchInterval: 2000,
  });
