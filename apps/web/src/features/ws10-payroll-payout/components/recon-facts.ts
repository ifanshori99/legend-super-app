// What the recon screen joins onto a flag. The flag list carries no names or
// amounts (by design), so they come from the batch the flag belongs to, and
// the names from the employee list. A read that fails stays "not available":
// it never turns into a made-up name or Rp0.
import type { Translate } from "@starter/shared/i18n";
import type {
  PayrollDisbursementBatchDto,
  PayrollDisbursementItemDto,
} from "@starter/shared/types";
import { shortId } from "./recon-model";
import { useBatch, usePayoutEmployees, usePayoutUserNames } from "../hooks";

export type ReconFacts = {
  batchState: "loading" | "ready" | "unavailable";
  items: readonly PayrollDisbursementItemDto[] | undefined;
  channel: PayrollDisbursementBatchDto["channel"] | null;
  itemCount: number | null;
  /** Employee name of an item, or null when the employee list does not have it. */
  employeeName: (item: PayrollDisbursementItemDto) => string | null;
  /** "Anda", the person's name, or a distinguishable id when no name is available. */
  who: (userId: string | null, t: Translate) => string;
};

export function useReconFacts(
  batchId: string | undefined,
  currentUserId: string,
): ReconFacts {
  const batch = useBatch(batchId);
  const employees = usePayoutEmployees();
  const userNames = usePayoutUserNames();
  return {
    batchState: batch.isPending
      ? "loading"
      : batch.isError
        ? "unavailable"
        : "ready",
    items: batch.data?.items,
    channel: batch.data?.channel ?? null,
    itemCount: batch.data?.itemCount ?? null,
    employeeName: (item) => employees.get(item.employeeId)?.name ?? null,
    who: (userId, t) => {
      if (!userId) return t("payrollPayoutReview.recon.unknown");
      if (userId === currentUserId)
        return t("payrollPayoutReview.recon.who.you");
      return (
        userNames.get(userId) ??
        t("payrollPayoutReview.recon.who.unknown", { id: shortId(userId) })
      );
    },
  };
}
