// "Ringkasan penyelesaian akhir" (PRD v1.7 §3 D26 "Offboarding": perhitungan
// hak akhir).
//
// There is no final-settlement endpoint and no formula in the contracts, so the
// card shows what the payroll fixtures already record for this employee — the
// last payslip's net, the outstanding kasbon and the unpaid reimbursement —
// each line labelled with its source. It never adds them up and never computes
// pesangon or leave payout: that calculation belongs to the API.
import { ReceiptText } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { finalSettlementPreview, formatBusinessDate } from "../lib.ts";

function Line({
  label,
  source,
  amountIdr,
}: {
  label: string;
  source: string;
  amountIdr: number | null;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b py-3 last:border-b-0">
      <div className="grid min-w-0 gap-0.5">
        <dt className="text-(length:--density-text) font-medium">{label}</dt>
        <dd className="text-sm leading-5 text-muted-foreground">{source}</dd>
      </div>
      <div className="text-right">
        {amountIdr === null ? (
          <span className="text-sm text-muted-foreground">
            {t("lifecycle.settlement.noRecord")}
          </span>
        ) : (
          <Money amount={amountIdr} size="lg" />
        )}
      </div>
    </div>
  );
}

export function FinalSettlementCard({ employeeId }: { employeeId: string }) {
  const t = useT();
  const preview = finalSettlementPreview(employeeId);
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="grid gap-1">
            <CardTitle>{t("lifecycle.settlement.title")}</CardTitle>
            <CardDescription>
              {t("lifecycle.settlement.description")}
            </CardDescription>
          </div>
          <Badge tone="neutral">
            <ReceiptText aria-hidden="true" />
            {t("lifecycle.settlement.preview")}
          </Badge>
        </div>
      </CardHeader>
      <dl className="grid">
        <Line
          label={t("lifecycle.settlement.payslip")}
          source={
            preview.lastPayslip === null
              ? t("lifecycle.settlement.noRecord")
              : t("lifecycle.settlement.payslipSource", {
                  period: formatBusinessDate(preview.lastPayslip.periodEnd),
                })
          }
          amountIdr={preview.lastPayslip?.netIdr ?? null}
        />
        <Line
          label={t("lifecycle.settlement.loan")}
          source={
            preview.loanCount === 0
              ? t("lifecycle.settlement.noRecord")
              : t("lifecycle.settlement.loanSource", {
                  count: preview.loanCount,
                })
          }
          amountIdr={preview.loanOutstandingIdr}
        />
        <Line
          label={t("lifecycle.settlement.reimbursement")}
          source={
            preview.reimbursementCount === 0
              ? t("lifecycle.settlement.noRecord")
              : t("lifecycle.settlement.reimbursementSource", {
                  count: preview.reimbursementCount,
                })
          }
          amountIdr={preview.reimbursementOutstandingIdr}
        />
      </dl>
      <p className="text-sm leading-5 text-muted-foreground">
        {t("lifecycle.settlement.contractMissing")}
      </p>
    </Card>
  );
}
