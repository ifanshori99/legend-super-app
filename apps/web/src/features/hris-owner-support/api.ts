import { orgEndpoints } from "@starter/shared/platform";
import { callEndpoint } from "@/lib/api/endpoint";

export function endOwnerSupportAccessCall(grantId: string) {
  return callEndpoint(orgEndpoints.endSupportAccess, { params: { grantId } });
}
