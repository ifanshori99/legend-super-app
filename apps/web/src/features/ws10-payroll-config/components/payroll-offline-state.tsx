// Offline state for the payroll configuration lists: a network failure is its
// own message, not the generic error state, so the fix ("connect the device")
// is the first thing Finance reads (DESIGN.md §4 feedback states).
import { useT } from "@/components/i18n";
import { ErrorState } from "@/components/ui/feedback-state";

export function PayrollOfflineState({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  return (
    <ErrorState
      title={t("payrollConfig.errors.offlineTitle")}
      description={t("payrollConfig.errors.offlineHint")}
      onRetry={onRetry}
    />
  );
}
