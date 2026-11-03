// "Finalkan": the one irreversible step of a recap. The confirmation says the
// numbers lock; the API additionally refuses when the fiscal period is still
// open (contract transitionTaxReport → PERIOD_NOT_CLOSED). The refusal is shown
// on the report card, next to the action that caused it.
import type { TaxReport } from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { ConfirmDialog } from "@/features/ws07-accounting/components/confirm-dialog";
import { useFinalizeTaxReport } from "../hooks";
import { formatTaxPeriod, taxErrorMessageKey, taxTypeLabelKey } from "../lib";

export function FinalizeReportDialog({
  open,
  onOpenChange,
  legalEntityId,
  report,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  legalEntityId: string;
  report: TaxReport;
  onError: (message: string) => void;
}) {
  const t = useT();
  const toast = useToast();
  const mutation = useFinalizeTaxReport(legalEntityId);

  const confirm = () =>
    mutation.mutate(report.id, {
      onSuccess: () => {
        onOpenChange(false);
        toast({
          title: t("accounting.tax.toasts.finalized"),
          tone: "success",
        });
      },
      onError: (cause) => {
        onOpenChange(false);
        onError(
          t(
            taxErrorMessageKey(
              cause instanceof ApiError ? cause.code : undefined,
            ),
          ),
        );
      },
    });

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("accounting.tax.finalizeDialog.title", {
        type: t(taxTypeLabelKey(report.type)),
      })}
      description={t("accounting.tax.finalizeDialog.description", {
        period: formatTaxPeriod(report.period),
      })}
      confirmLabel={t("accounting.tax.finalizeDialog.confirm")}
      pending={mutation.isPending}
      onConfirm={confirm}
      destructive={false}
    />
  );
}
