// One function per charge call; components never call these (they use
// ./charge-hooks.ts). The charge read has no API route yet: outside mock mode
// it fails with CONTRACT_PENDING so the screen says so instead of showing made
// up data.
import { callEndpoint } from "@/lib/api/endpoint";
import { ApiError } from "@/lib/api/errors";
import { API_MOCK } from "@/lib/api/mock-flag";
import {
  collectIssueChargeAtPos,
  getIssueCharge,
  type IssueChargeDetail,
  type IssueChargeView,
} from "./charge-endpoints";

export const CONTRACT_PENDING = "CONTRACT_PENDING";

export async function fetchIssueCharge(
  chargeId: string,
  signal?: AbortSignal,
): Promise<IssueChargeDetail> {
  if (!API_MOCK)
    throw new ApiError(
      501,
      CONTRACT_PENDING,
      "Rincian tagihan selisih belum tersedia di server.",
    );
  const { data } = await callEndpoint(
    getIssueCharge,
    { params: { chargeId } },
    { signal },
  );
  return data;
}

/**
 * Takes the exact amount in cash. `idempotencyKey` is kept by the hook until
 * the answer is known, so a retry replays instead of recording twice.
 */
export async function collectCharge(
  chargeId: string,
  input: { receivedIdr: number; idempotencyKey: string },
): Promise<{ charge: IssueChargeView; changeIdr: number }> {
  const { data } = await callEndpoint(collectIssueChargeAtPos, {
    params: { chargeId },
    body: {
      idempotencyKey: input.idempotencyKey,
      method: "cash",
      receivedIdr: input.receivedIdr,
    },
  });
  return data;
}
