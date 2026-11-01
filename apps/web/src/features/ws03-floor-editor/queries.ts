// Query keys and options for the floor editor. `endpointQueryOptions` keys by
// endpoint id + input, so invalidating `[getCurrentFloor.id]` refreshes the
// zone list, the plan and the QR sheet at once.
import { endpointQueryOptions } from "@/lib/api/endpoint";
import { getCurrentFloor } from "@starter/shared/qr-order";

/** Every floor read hangs off one snapshot; writes invalidate it. */
export const floorKeys = { all: [getCurrentFloor.id] as const };

/** Zones, tables and the live session on each table of the caller's outlet. */
export const currentFloorQuery = () => endpointQueryOptions(getCurrentFloor);
