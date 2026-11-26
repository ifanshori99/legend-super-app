// The supervisor close of one shift as a retry-safe flow (1268 W3, review K 1).
// Once a supervisor's PIN is accepted, the exact body of the close is frozen:
// a retry after a lost answer sends that stored body again (same approval,
// same supervisor, same note, same key) and never asks for a PIN. Whatever the
// dialog holds on a retry is ignored; the PIN itself is never stored. A
// definite refusal (4xx) or success ends it; only a lost or 5xx answer keeps it.
import { ApiError } from "@/lib/api/errors";
import { closeShiftWithApproval } from "./shift-api";
import type { CloseShiftWithApprovalInput } from "./types";

type Frozen = {
  overrideId: string;
  key: string;
  /** The input of the approved try, PIN blanked. */
  input: CloseShiftWithApprovalInput;
};

export type CloseFlow = {
  run(input: CloseShiftWithApprovalInput): Promise<void>;
  /** The approved close whose answer is unknown: a retry repeats exactly this. */
  pending(): CloseShiftWithApprovalInput | null;
  reset(): void;
};

const isDefinite = (error: unknown) =>
  error instanceof ApiError && error.status >= 400 && error.status < 500;

export function createCloseFlow(outletId: string): CloseFlow {
  let frozen: Frozen | null = null;
  return {
    pending: () => (frozen ? { ...frozen.input } : null),
    reset: () => {
      frozen = null;
    },
    async run(input) {
      const retry =
        frozen !== null &&
        frozen.input.shiftId === input.shiftId &&
        frozen.input.countId === input.countId
          ? frozen
          : null;
      if (!retry) frozen = null;
      const sent = retry ? retry.input : input;
      const key = retry?.key ?? `shift-close:${globalThis.crypto.randomUUID()}`;
      try {
        await closeShiftWithApproval(
          outletId,
          sent,
          retry ? { overrideId: retry.overrideId } : null,
          key,
          (overrideId) => {
            frozen = { overrideId, key, input: { ...sent, pin: "" } };
          },
        );
        frozen = null;
      } catch (error) {
        // A refusal is final for this count; only a lost answer may repeat.
        if (isDefinite(error)) frozen = null;
        throw error;
      }
    },
  };
}
