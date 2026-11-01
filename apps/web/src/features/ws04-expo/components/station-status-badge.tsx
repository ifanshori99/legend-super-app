// One station's ticket status on the expo card (PRD §6 `kitchen_tickets.status`).
// Icon + text, never colour alone (WCAG 1.4.1). Cancelled station tickets stay
// visible: KDS-03 requires the expo to show a cancellation immediately.
import {
  Ban,
  CircleCheck,
  CircleDot,
  RotateCcw,
  Timer,
  type LucideIcon,
} from "lucide-react";
import type { KitchenTicketStatus } from "@starter/shared/kitchen";
import type { MessageKey } from "@starter/shared/i18n";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/components/i18n";

const STATUSES: Record<
  KitchenTicketStatus,
  {
    tone: "neutral" | "success" | "warning" | "danger" | "info";
    icon: LucideIcon;
    labelKey: MessageKey;
  }
> = {
  new: { tone: "info", icon: CircleDot, labelKey: "kitchenTicket.new" },
  in_progress: {
    tone: "warning",
    icon: Timer,
    labelKey: "kitchenTicket.inProgress",
  },
  done: { tone: "success", icon: CircleCheck, labelKey: "kitchenTicket.done" },
  recalled: {
    tone: "danger",
    icon: RotateCcw,
    labelKey: "kitchenTicket.recalled",
  },
  cancelled: {
    tone: "neutral",
    icon: Ban,
    labelKey: "kitchenTicket.cancelled",
  },
};

export function StationStatusBadge({
  status,
}: {
  status: KitchenTicketStatus;
}) {
  const t = useT();
  const { tone, icon: Icon, labelKey } = STATUSES[status];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" />
      {t(labelKey)}
    </Badge>
  );
}
