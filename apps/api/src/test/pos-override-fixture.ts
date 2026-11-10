// Fingerprint for a `supervisor_pin` pos_overrides row written straight into
// the table by a test (bead legend-fjwxo). The shift close and the POS order
// consumers re-derive the request fingerprint from the stored row and refuse
// one that matches neither the unbound form nor the caller's device; every
// row production writes carries a real fingerprint (createPosOverride), so a
// fixture must too. This is the unbound form (an approval typed on no device).
import { posOverrideFingerprint } from "../services/device-pin-support.ts";

export function pinOverrideFixtureFingerprint(fields: {
  requestedBy: string;
  outletId: string;
  action: string;
  valueIdr: number;
  reason: string;
  objectType: string;
  objectId: string;
  approverUserId: string;
}): string {
  return posOverrideFingerprint(
    { ...fields, reasonCode: null, method: "supervisor_pin" },
    null,
  );
}
