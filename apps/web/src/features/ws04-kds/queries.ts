import { queryOptions } from "@tanstack/react-query";
import type { StationConfig } from "@starter/shared/kitchen";
import { fetchBoard, fetchStationLabels, fetchStations } from "./api.ts";

export const kdsKeys = {
  all: ["kds"] as const,
  stations: ["kds", "stations"] as const,
  stationLabels: ["kds", "station-labels"] as const,
  board: (stationId: StationConfig["stationId"]) =>
    ["kds", "board", stationId] as const,
};
export const stationsQuery = () =>
  queryOptions({
    queryKey: kdsKeys.stations,
    queryFn: ({ signal }) => fetchStations(signal),
  });
export const stationLabelsQuery = () =>
  queryOptions({
    queryKey: kdsKeys.stationLabels,
    queryFn: ({ signal }) => fetchStationLabels(signal),
  });
export const boardQuery = (stationId: StationConfig["stationId"]) =>
  queryOptions({
    queryKey: kdsKeys.board(stationId),
    queryFn: ({ signal }) => fetchBoard(stationId, signal),
    refetchInterval: 2000,
  });
