import { queryOptions, skipToken } from "@tanstack/react-query";
import type { StationConfig } from "@starter/shared/kitchen";
import {
  fetchBoard,
  fetchScannerStatus,
  fetchStationLabels,
  fetchStationSummary,
  fetchStations,
} from "./api.ts";
import { KDS_SCANNER_STATUS_AVAILABLE } from "./contract-gap.ts";

// Every key carries the outlet, so switching outlet never serves another
// outlet's stations or board from cache. A missing outlet (the session has
// none) disables the query instead of calling the API.
export const kdsKeys = {
  all: ["kds"] as const,
  outlet: (outletId: string | undefined) => ["kds", outletId] as const,
  stations: (outletId: string | undefined) =>
    ["kds", outletId, "stations"] as const,
  stationLabels: (outletId: string | undefined) =>
    ["kds", outletId, "station-labels"] as const,
  stationSummary: (outletId: string | undefined) =>
    ["kds", outletId, "station-summary"] as const,
  scannerStatus: (outletId: string | undefined) =>
    ["kds", outletId, "scanner-status"] as const,
  board: (
    outletId: string | undefined,
    stationId: StationConfig["stationId"],
  ) => ["kds", outletId, "board", stationId] as const,
};
export const stationsQuery = (outletId: string | undefined) =>
  queryOptions({
    queryKey: kdsKeys.stations(outletId),
    queryFn: outletId
      ? ({ signal }) => fetchStations(outletId, signal)
      : skipToken,
  });
export const stationLabelsQuery = (outletId: string | undefined) =>
  queryOptions({
    queryKey: kdsKeys.stationLabels(outletId),
    queryFn: outletId
      ? ({ signal }) => fetchStationLabels(outletId, signal)
      : skipToken,
  });
export const boardQuery = (
  outletId: string | undefined,
  stationId: StationConfig["stationId"],
) =>
  queryOptions({
    queryKey: kdsKeys.board(outletId, stationId),
    queryFn: outletId
      ? ({ signal }) => fetchBoard(outletId, stationId, signal)
      : skipToken,
    refetchInterval: 2000,
  });
export const stationSummaryQuery = (outletId: string | undefined) =>
  queryOptions({
    queryKey: kdsKeys.stationSummary(outletId),
    queryFn: outletId
      ? ({ signal }) => fetchStationSummary(outletId, signal)
      : skipToken,
    refetchInterval: 30_000,
  });
// No endpoint answers outside mock mode (contract-gap.ts): the query stays off
// and the screen reads the scanner as "unknown" instead of faking a status.
export const scannerStatusQuery = (outletId: string | undefined) =>
  queryOptions({
    queryKey: kdsKeys.scannerStatus(outletId),
    queryFn:
      outletId && KDS_SCANNER_STATUS_AVAILABLE
        ? ({ signal }) => fetchScannerStatus(outletId, signal)
        : skipToken,
    refetchInterval: 10_000,
  });
