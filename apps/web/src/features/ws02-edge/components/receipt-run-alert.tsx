// Warning for a restored or cloned edge database (legend-yd0h8, legend-s7szu):
// the cloud saw the receipt number run rotate again and again. Shown on the
// edge status screen with the restore procedure for the technical admin.
import { TriangleAlert } from "lucide-react";
import { useT } from "@/components/i18n";
import { formatAlertTime } from "../logic.ts";

export function ReceiptRunAlert({
  edgeNodeId,
  alertAt,
}: {
  edgeNodeId: string;
  alertAt: string | null;
}) {
  const t = useT();
  const recordedAt = formatAlertTime(alertAt);
  return (
    <section
      role="alert"
      className="rounded-container border-(length:--border-w) border-warning bg-warning-subtle p-4 text-foreground sm:p-5"
    >
      <div className="flex items-start gap-3">
        <TriangleAlert
          className="mt-0.5 size-5 shrink-0 text-warning"
          aria-hidden="true"
        />
        <div className="grid min-w-0 gap-1">
          <h2 className="type-title">{t("edge.receiptRun.title")}</h2>
          <p className="text-sm leading-5">
            {t("edge.receiptRun.description")}
          </p>
        </div>
      </div>
      <dl className="mt-4 grid gap-1.5 text-sm leading-5 sm:pl-8">
        <div className="flex flex-wrap gap-x-1.5">
          <dt className="font-semibold">{t("edge.receiptRun.node")}:</dt>
          <dd className="min-w-0 break-all tabular">{edgeNodeId}</dd>
        </div>
        <div className="flex flex-wrap gap-x-1.5">
          <dt className="font-semibold">{t("edge.receiptRun.recordedAt")}:</dt>
          <dd className="tabular">
            {recordedAt ?? t("edge.receiptRun.recordedAtUnknown")}
          </dd>
        </div>
      </dl>
      <details className="mt-4 border-t-(length:--border-w) border-warning pt-3 sm:ml-8">
        <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold">
          {t("edge.receiptRun.guideTitle")}
        </summary>
        <ol className="grid list-decimal gap-2 pl-5 text-sm leading-5">
          <li>{t("edge.receiptRun.stepIdentify")}</li>
          <li>
            {t("edge.receiptRun.stepResetBefore")}{" "}
            <code className="rounded-sm bg-surface-3 px-1 py-0.5 text-[0.9em] break-all">
              edge_nodes.instance_id
            </code>{" "}
            {t("edge.receiptRun.stepResetAfter")}
          </li>
          <li>{t("edge.receiptRun.stepVerify")}</li>
        </ol>
      </details>
    </section>
  );
}
