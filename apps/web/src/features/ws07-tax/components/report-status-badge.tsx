// Report status of a tax recap: always icon + text (DESIGN.md / WCAG 1.4.1).
// Draft waits for finalisation (neutral), final locks the numbers and waits for
// the export (warning), exported is done (success).
import { CircleDashed, CloudUpload, Lock, type LucideIcon } from "lucide-react";
import type { TaxReportStatus } from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { taxStatusLabelKey } from "../lib";

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

const STATUS: Record<TaxReportStatus, { tone: Tone; icon: LucideIcon }> = {
  draft: { tone: "neutral", icon: CircleDashed },
  final: { tone: "warning", icon: Lock },
  exported: { tone: "success", icon: CloudUpload },
};

export function TaxStatusBadge({ status }: { status: TaxReportStatus }) {
  const t = useT();
  const { tone, icon: Icon } = STATUS[status];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" />
      {t(taxStatusLabelKey(status))}
    </Badge>
  );
}
