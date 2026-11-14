// CONTRACT GAP (bead legend-uqfu). @starter/shared/kitchen has no scanner
// status endpoint: a web page cannot detect a keyboard-wedge scanner, so the
// connection has to come from the edge node or the device shell. The local
// endpoint below types that source; a follow-up contract bead should move it
// into the kitchen package.
//
// Outside mock mode nothing answers it, so the KDS sends no request
// (KDS_SCANNER_STATUS_AVAILABLE) and treats the scanner as "unknown": the
// input stays enabled and no "Terhubung" claim is shown. Ticket buttons stay
// enabled whatever the status says.
import { defineEndpoint } from "@starter/shared/api";
import { dataResponseSchema, outletIdSchema, z } from "@starter/shared/core";
import { API_MOCK } from "@/lib/api/mock-flag";

export const kdsScannerStatusSchema = z.enum(["connected", "disconnected"]);
export type KdsScannerStatus = z.infer<typeof kdsScannerStatusSchema>;

export const getKdsScannerStatus = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/kitchen/scanner-status",
  params: z.object({ outletId: outletIdSchema }),
  response: dataResponseSchema(z.object({ status: kdsScannerStatusSchema })),
});

/** True only where something answers getKdsScannerStatus (the mock). */
export const KDS_SCANNER_STATUS_AVAILABLE: boolean = API_MOCK;
