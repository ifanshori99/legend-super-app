// Status of a stock-count session, always icon + text (DESIGN.md §2 status;
// WCAG 1.4.1). The pill colors follow the fixed status tokens, so a tenant
// theme can never change the meaning.
import {
  Ban,
  CircleCheck,
  ClipboardCheck,
  Clock,
  FilePen,
  Send,
  type LucideIcon,
} from "lucide-react";
import type { StockCountStatus } from "@starter/shared/inventory";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { statusLabelKey } from "../opname-lib";

const STATUS: Record<
  StockCountStatus,
  { tone: "neutral" | "warning" | "success" | "info"; icon: LucideIcon }
> = {
  draft: { tone: "neutral", icon: FilePen },
  counting: { tone: "info", icon: Clock },
  pending_approval: { tone: "warning", icon: Send },
  approved: { tone: "info", icon: ClipboardCheck },
  posted: { tone: "success", icon: CircleCheck },
  cancelled: { tone: "neutral", icon: Ban },
};

export function CountStatusBadge({ status }: { status: StockCountStatus }) {
  const t = useT();
  const { tone, icon: Icon } = STATUS[status];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" />
      {t(statusLabelKey(status))}
    </Badge>
  );
}
