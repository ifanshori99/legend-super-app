// O3 calls of the offline POS: the kit (O1) and the batch sync (O2).
import { listPosOverrideApprovers } from "@starter/shared/access/override";
import {
  issuePosOfflineKit,
  reportPosOfflineConflict,
  reportPosOfflineStuck,
  submitPosOfflineBatch,
  type OfflineEventResult,
  type OfflineSaleEvent,
  type OfflineStuckReason,
  type PosOfflineBatchResult,
  type PosOfflineKit,
} from "@starter/shared/pos";
import { callEndpoint } from "@/lib/api/endpoint";
import type { OfflineStuckApproval } from "./queue";

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

/** Review O3 P1: the report of a sale the batch refused with OFFLINE_EVENT_CONFLICT. */
export async function sendOfflineConflict(
  outletId: string,
  event: OfflineSaleEvent,
): Promise<OfflineEventResult> {
  const { data } = await callEndpoint(reportPosOfflineConflict, {
    params: { outletId },
    body: { event },
  });
  return data;
}

/** 1273 P2-1: a sale the cloud refuses for good, with a supervisor's PIN. */
export async function sendOfflineStuck(
  outletId: string,
  event: OfflineSaleEvent,
  stuck: OfflineStuckReason,
  approval: OfflineStuckApproval,
): Promise<OfflineEventResult> {
  const { data } = await callEndpoint(reportPosOfflineStuck, {
    params: { outletId },
    body: { event, stuck, ...approval },
  });
  return data;
}

/** Supervisors who may approve the report (the cash close approvers). */
export async function fetchStuckApprovers(
  outletId: string,
): Promise<{ userId: string; name: string }[]> {
  const { data } = await callEndpoint(listPosOverrideApprovers, {
    query: { outletId, action: "cash_shift_close" },
  });
  return data.map((row) => ({ userId: row.userId, name: row.displayName }));
}
