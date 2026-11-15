// Side cards of the Pengaturan PT tab: the fee rule (salary stays whole, the
// PT carries the fee) and the Duitku readiness note.
import { useT } from "@/components/i18n";
import { Card } from "@/components/ui/card";
import { Money } from "@/components/ui/money";

export function SettingsAside({
  feeIdr,
  entityName,
}: {
  /** Fee per transfer as it stands in the form, or null while it is not a number. */
  feeIdr: number | null;
  entityName: string | null;
}) {
  const t = useT();
  return (
    <div className="grid content-start gap-4">
      <Card className="gap-3" data-testid="payout-rules">
        <div className="grid gap-1">
          <p className="type-eyebrow text-muted-foreground">
            {t("payrollPayoutSettings.rules.eyebrow")}
          </p>
          <h3 className="type-title">
            {t("payrollPayoutSettings.rules.title")}
          </h3>
        </div>
        <dl className="grid divide-y text-sm">
          <div className="flex items-center justify-between gap-3 py-2">
            <dt className="text-muted-foreground">
              {t("payrollPayoutSettings.rules.fee")}
            </dt>
            <dd className="font-semibold">
              {feeIdr === null ? "-" : <Money amount={feeIdr} size="sm" />}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3 py-2">
            <dt className="text-muted-foreground">
              {t("payrollPayoutSettings.rules.borne")}
            </dt>
            <dd className="text-right font-semibold">
              {entityName ?? t("payrollPayoutSettings.rules.borneEntity")}
            </dd>
          </div>
        </dl>
        <p className="text-sm text-muted-foreground">
          {t("payrollPayoutSettings.rules.note")}
        </p>
      </Card>
      <Card className="gap-3">
        <h3 className="type-title">
          {t("payrollPayoutSettings.activate.title")}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t("payrollPayoutSettings.activate.body")}
        </p>
        <p className="rounded-field bg-surface-2 p-3 text-sm">
          {t("payrollPayoutSettings.activate.now")}
        </p>
      </Card>
    </div>
  );
}
