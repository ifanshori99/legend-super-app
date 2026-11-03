// Draft → final → exported with the timestamps the report already carries. It
// is the auditor's view of the record: a step without a timestamp says so, it
// does not guess one.
import { CircleDashed, CloudUpload, Lock, type LucideIcon } from "lucide-react";
import type { TaxReport } from "@starter/shared/accounting";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import type { MessageKey } from "@starter/shared/i18n";
import { formatTaxTimestamp } from "../lib";

type Step = {
  readonly key: string;
  readonly icon: LucideIcon;
  readonly labelKey: MessageKey;
  readonly at: string | null;
};

export function ReportStatusHistory({ report }: { report: TaxReport }) {
  const t = useT();
  const steps: readonly Step[] = [
    {
      key: "draft",
      icon: CircleDashed,
      labelKey: "accounting.tax.history.draft",
      at: report.generatedAt,
    },
    {
      key: "final",
      icon: Lock,
      labelKey: "accounting.tax.history.final",
      at: report.finalizedAt,
    },
    {
      key: "exported",
      icon: CloudUpload,
      labelKey: "accounting.tax.history.exported",
      at: report.exportedAt,
    },
  ];
  return (
    <section className="grid gap-2">
      <h3 className="type-eyebrow text-muted-foreground">
        {t("accounting.tax.history.title")}
      </h3>
      <ol className="grid gap-2 sm:grid-cols-3">
        {steps.map(({ key, icon: Icon, labelKey, at }) => (
          <li
            key={key}
            className={cn(
              "flex items-start gap-2 rounded-container border-(length:--border-w) p-2.5",
              at ? "bg-card" : "bg-surface-2",
            )}
          >
            <Icon
              className={cn(
                "mt-0.5 size-4 shrink-0",
                at ? "text-success" : "text-muted-foreground",
              )}
              aria-hidden="true"
            />
            <div className="grid min-w-0 gap-0.5">
              <span className="text-sm leading-5 font-medium">
                {t(labelKey)}
              </span>
              <span className="text-xs leading-4 text-muted-foreground tabular">
                {at === null
                  ? t("accounting.tax.history.notRecorded")
                  : formatTaxTimestamp(at)}
              </span>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
