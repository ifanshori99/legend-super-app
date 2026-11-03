// PPN masukan needs a PKP legal entity (PRD v1.7 §3 F19; contract
// assertTaxTypeApplicable). Instead of an empty recap table, the card explains
// why the type is unavailable and shows the entity's current PKP status. There
// is no action here: PKP status lives on the legal entity, not on a tax report.
import { ShieldAlert } from "lucide-react";
import { useT } from "@/components/i18n";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback-state";

export function PpnGate({ isPkp }: { isPkp: boolean }) {
  const t = useT();
  return (
    <CardShell>
      <CardShellBody>
        <header className="grid gap-1 border-b p-card">
          <h2 className="type-title">{t("accounting.tax.types.ppn")}</h2>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("accounting.tax.types.hints.ppn")}
          </p>
        </header>
        <EmptyState
          icon={ShieldAlert}
          title={t("accounting.tax.ppnGate.title")}
          description={t("accounting.tax.ppnGate.description")}
        />
        <p className="border-t px-card py-3 text-sm text-muted-foreground">
          {t("accounting.tax.ppnGate.currentStatus", {
            status: isPkp
              ? t("accounting.tax.ppnGate.pkpYes")
              : t("accounting.tax.ppnGate.pkpNo"),
          })}
        </p>
      </CardShellBody>
    </CardShell>
  );
}
