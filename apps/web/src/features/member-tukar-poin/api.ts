// Member "tukar poin di kasir" endpoints (legend-0ne0z, flow A). One function
// per contract endpoint from @starter/shared/crm; minting the QR reuses the
// member QR token endpoint with the order and points bound into the token.
import {
  getMemberPointsQuote,
  getMemberPointsRedeemStatus,
  listMemberOpenBills,
} from "@starter/shared/crm";
import type { MemberPointsRedeemStatusInput } from "@starter/shared/crm";
import { callEndpoint } from "@/lib/api/endpoint";
import { requestMemberQrToken } from "../ws08-member/api";

export function fetchMemberOpenBills(signal?: AbortSignal) {
  return callEndpoint(listMemberOpenBills, undefined, { signal }).then(
    (response) => response.data,
  );
}

export function fetchMemberPointsQuote(orderId: string, signal?: AbortSignal) {
  return callEndpoint(
    getMemberPointsQuote,
    { params: { orderId } },
    { signal },
  ).then((response) => response.data);
}

/** The QR carries this token; the server rejects it when order or points differ. */
export function requestRedeemQrToken(
  input: { orderId: string; points: number },
  signal?: AbortSignal,
) {
  return requestMemberQrToken(input, signal);
}

/** POST so the token never appears in a URL or an access log. */
export function fetchRedeemStatus(
  input: MemberPointsRedeemStatusInput,
  signal?: AbortSignal,
) {
  return callEndpoint(
    getMemberPointsRedeemStatus,
    { body: input },
    { signal },
  ).then((response) => response.data);
}
