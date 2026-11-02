// State badge of the display: always icon + text, never color alone
// (DESIGN.md §4 Badge; WCAG 1.4.1).
import { CircleCheck, Clock, QrCode, type LucideIcon } from "lucide-react";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";

type DisplayState = "ordering" | "awaiting_payment" | "paid";

const STATE: Record<
  DisplayState,
  { tone: "info" | "warning" | "success"; icon: LucideIcon; label: MessageKey }
> = {
  ordering: {
    tone: "info",
    icon: Clock,
    label: "posDisplay.state.ordering",
  },
  awaiting_payment: {
    tone: "warning",
    icon: QrCode,
    label: "posDisplay.state.awaitingPayment",
  },
  paid: { tone: "success", icon: CircleCheck, label: "posDisplay.state.paid" },
};

export function DisplayStateBadge({ state }: { state: DisplayState }) {
  const t = useT();
  const { tone, icon: Icon, label } = STATE[state];
  return (
    <Badge
      tone={tone}
      className="rounded-full px-2.5 py-1 text-sm [&_svg]:size-4"
    >
      <Icon aria-hidden="true" />
      {t(label)}
    </Badge>
  );
}
