// One function per charge call; components never call these (they use
// ./charge-hooks.ts). Every amount is the server's: the card start and the
// supervisor's settle send none (the slip's printed amount is evidence the
// server compares, never a figure it books).
import type { z } from "@starter/shared/core";
import { callEndpoint } from "@/lib/api/endpoint";
import type { EdcTransaction } from "@starter/shared/edc";
import type {
  CollectChargeAtPosInput,
  GuestPayment,
} from "@starter/shared/qr-order";
import {
  collectIssueChargeAtPos,
  getIssueCharge,
  resolveIssueChargeAttempt,
  startIssueChargeEdc,
  type IssueChargeDetail,
  type IssueChargeView,
} from "./charge-endpoints";

export async function fetchIssueCharge(
  chargeId: string,
  signal?: AbortSignal,
): Promise<IssueChargeDetail> {
  const { data } = await callEndpoint(
    getIssueCharge,
    { params: { chargeId } },
    { signal },
  );
  return data;
}

/**
 * Takes the charge at the till. Cash sends what the guest handed over; QRIS
 * sends no amount (the server's charge is the only one) and answers a pending
 * code; EDC names the approved card sale that paid it. `idempotencyKey` is kept
 * by the hook until the answer is known, so a retry replays instead of
 * recording twice.
 */
export async function collectCharge(
  chargeId: string,
  input: CollectChargeAtPosInput,
): Promise<{
  charge: IssueChargeView;
  changeIdr: number;
  payment?: GuestPayment;
}> {
  const { data } = await callEndpoint(collectIssueChargeAtPos, {
    params: { chargeId },
    body: input,
  });
  return data;
}

/**
 * Starts the card sale on the outlet's terminal. The server takes the charge's
 * amount and reference; the same key replays the same sale.
 */
export async function startChargeEdc(
  chargeId: string,
  input: z.input<typeof startIssueChargeEdc.body>,
): Promise<EdcTransaction> {
  const { data } = await callEndpoint(startIssueChargeEdc, {
    params: { chargeId },
    body: input,
  });
  return data;
}

export type ResolveChargeAttemptInput = z.input<
  typeof resolveIssueChargeAttempt.body
>;

/** A supervisor settles a cash or card attempt that never answered (d). */
export async function resolveChargeAttempt(
  chargeId: string,
  input: ResolveChargeAttemptInput,
): Promise<z.output<typeof resolveIssueChargeAttempt.response>["data"]> {
  const { data } = await callEndpoint(resolveIssueChargeAttempt, {
    params: { chargeId },
    body: input,
  });
  return data;
}
