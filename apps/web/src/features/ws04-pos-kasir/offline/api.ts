// O3 calls of the offline POS: the kit (O1) and the batch sync (O2).
import {
  issuePosOfflineKit,
  submitPosOfflineBatch,
  type OfflineSaleEvent,
  type PosOfflineBatchResult,
  type PosOfflineKit,
} from "@starter/shared/pos";
import { callEndpoint } from "@/lib/api/endpoint";

export async function fetchOfflineKit(
  outletId: string,
  shiftId: string,
  resumeSequenceId: string | null,
): Promise<PosOfflineKit> {
  const { data } = await callEndpoint(issuePosOfflineKit, {
    params: { outletId, shiftId },
    body: { resumeSequenceId },
  });
  return data;
}

export async function sendOfflineBatch(
  outletId: string,
  events: OfflineSaleEvent[],
): Promise<PosOfflineBatchResult> {
  const { data } = await callEndpoint(submitPosOfflineBatch, {
    params: { outletId },
    body: { events },
  });
  return data;
}
