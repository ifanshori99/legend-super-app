// One function per charge call; components never call these (they use
// ./charge-hooks.ts). Every amount is the server's: the card start and the
// supervisor's settle send none (the slip's printed amount is evidence the
// server compares, never a figure it books).
import type { z } from "@starter/shared/core";
import { callEndpoint } from "@/lib/api/endpoint";
import { API_MOCK } from "@/lib/api/mock-flag";
import {
  fetchEdcTerminals,
  fetchResolveApprovers,
} from "@/features/ws04-pos-kasir/api";
import type { EdcTransaction } from "@starter/shared/edc";
import { PRECHECK_DEADLINE_MS, readWithin } from "./charge-method-logic";
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

/** A card terminal the charge can be sent to (the outlet's payment options). */
export type ChargeTerminal = { id: string; label: string; detail: string };

// Mock mode: the demo terminal the charge mock answers for (an id the start
// contract accepts).
const MOCK_TERMINALS: ChargeTerminal[] = [
  {
    id: "7e9a4b12-6c38-4d5f-8b20-1f3c5d7e9a02",
    label: "BCA · EDC 01",
    detail: "•••• 4021",
  },
];

/** The outlet's terminals that take cards; a QRIS-only one is left out. */
export async function fetchChargeTerminals(
  outletId: string,
): Promise<ChargeTerminal[]> {
  if (API_MOCK) return MOCK_TERMINALS;
  const terminals = await readWithin(
    () => fetchEdcTerminals(outletId),
    PRECHECK_DEADLINE_MS,
  );
  return terminals
    .filter((item) => !item.modes || item.modes.includes("card"))
    .map((item) => ({
      id: item.id,
      label: item.label,
      detail: item.assignedTo,
    }));
}

export type ChargeApprover = { userId: string; name: string };

// Mock mode: a supervisor other than the mock cashier, so the settle can be
// shown end to end.
const MOCK_APPROVERS: ChargeApprover[] = [
  { userId: "00000000-0000-4000-8000-000000000611", name: "Supervisor 02" },
];

/** Who may approve a settle at this outlet (cash: void; card: EDC). */
export async function fetchChargeApprovers(
  outletId: string,
  action: "void" | "edc_standalone",
): Promise<ChargeApprover[]> {
  if (API_MOCK) return MOCK_APPROVERS;
  return readWithin(
    () => fetchResolveApprovers(outletId, action),
    PRECHECK_DEADLINE_MS,
  );
}
