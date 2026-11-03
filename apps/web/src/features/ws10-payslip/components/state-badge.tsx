// A status always reads as icon + text, never color alone (DESIGN.md §4;
// WCAG 1.4.1). StatusPill's built-in catalog covers order/timer states; the
// payslip statuses are domain values, so this wraps the same pill look with
// their own labels and tones.
import type { LucideIcon } from "lucide-react";
import {
  CircleAlert,
  CircleCheck,
  Clock,
  Info,
  MinusCircle,
} from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import type { StatusTone } from "../state.ts";

const TONE_ICONS: Record<StatusTone, LucideIcon> = {
  neutral: MinusCircle,
  success: CircleCheck,
  warning: Clock,
  danger: CircleAlert,
  info: Info,
};

export function StateBadge({
  tone,
  children,
}: {
  tone: StatusTone;
  children: ReactNode;
}) {
  const Icon = TONE_ICONS[tone];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" />
      {children}
    </Badge>
  );
}
