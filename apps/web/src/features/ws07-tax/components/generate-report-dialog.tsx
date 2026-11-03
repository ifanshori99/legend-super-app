// "Buat rekap": confirms the type and period before the server builds the draft.
// The contract's generate input is type + period + legal entity only (no note
// field), so the dialog shows a read-only summary rather than an input that
// would be discarded.
import * as React from "react";
import { Plus } from "lucide-react";
import type { TaxReportType } from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import type { EntityRef } from "@/features/ws07-accounting/components/entity-picker";
import { useGenerateTaxReport } from "../hooks";
import { formatTaxPeriod, taxErrorMessageKey, taxTypeLabelKey } from "../lib";

export function GenerateReportDialog({
  open,
  onOpenChange,
  legalEntity,
  type,
  period,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  legalEntity: EntityRef;
  type: TaxReportType;
  period: string;
}) {
  const t = useT();
  const toast = useToast();
  const mutation = useGenerateTaxReport(legalEntity.id);
  const [error, setError] = React.useState<string | null>(null);

  const close = (next: boolean) => {
    if (mutation.isPending) return;
    if (!next) setError(null);
    onOpenChange(next);
  };

  const submit = () => {
    setError(null);
    mutation.mutate(
      { legalEntityId: legalEntity.id, type, period },
      {
        onSuccess: () => {
          onOpenChange(false);
          toast({
            title: t("accounting.tax.toasts.generated"),
            tone: "success",
          });
        },
        onError: (cause) =>
          setError(
            t(
              taxErrorMessageKey(
                cause instanceof ApiError ? cause.code : undefined,
              ),
            ),
          ),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("accounting.tax.generateDialog.title", {
              type: t(taxTypeLabelKey(type)),
            })}
          </DialogTitle>
          <DialogDescription>
            {t("accounting.tax.generateDialog.description", {
              period: formatTaxPeriod(period),
            })}
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">
            {t("accounting.tax.generateDialog.typeLabel")}
          </dt>
          <dd className="font-medium">{t(taxTypeLabelKey(type))}</dd>
          <dt className="text-muted-foreground">
            {t("accounting.tax.generateDialog.periodLabel")}
          </dt>
          <dd className="tabular">{formatTaxPeriod(period)}</dd>
          <dt className="text-muted-foreground">
            {t("accounting.tax.generateDialog.entityLabel")}
          </dt>
          <dd className="font-medium">{legalEntity.name}</dd>
        </dl>

        <p className="text-sm leading-5 text-muted-foreground">
          {t("accounting.tax.generateDialog.note")}
        </p>

        {error && (
          <p role="alert" className="text-sm leading-5 font-medium text-danger">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => close(false)}
            disabled={mutation.isPending}
          >
            {t("common.cancel")}
          </Button>
          <Button type="button" loading={mutation.isPending} onClick={submit}>
            <Plus aria-hidden="true" />
            {t("accounting.tax.generateDialog.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
