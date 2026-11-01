// Item availability as icon + text (never colour alone, WCAG 1.4.1).
// PRD §8 "Ketersediaan": 86 is an operational state, not an error.
import { CircleCheck, CircleSlash, EyeOff } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import type { ItemStatus } from "../lib";

const CONFIG = {
  available: {
    tone: "success",
    icon: CircleCheck,
    labelKey: "menu.list.status.available",
  },
  sold_out: {
    tone: "warning",
    icon: CircleSlash,
    labelKey: "menu.list.status.sold_out",
  },
  inactive: {
    tone: "neutral",
    icon: EyeOff,
    labelKey: "menu.list.status.inactive",
  },
} as const;

export function ItemStatusBadge({ status }: { status: ItemStatus }) {
  const t = useT();
  const config = CONFIG[status];
  const Icon = config.icon;
  return (
    <Badge tone={config.tone}>
      <Icon aria-hidden="true" />
      {t(config.labelKey)}
    </Badge>
  );
}

/** 86 state for the availability table (available vs sold out only). */
export function AvailabilityBadge({
  status,
}: {
  status: "available" | "sold_out";
}) {
  const t = useT();
  const soldOut = status === "sold_out";
  const Icon = soldOut ? CircleSlash : CircleCheck;
  return (
    <Badge tone={soldOut ? "danger" : "success"}>
      <Icon aria-hidden="true" />
      {t(
        soldOut
          ? "menu.availability.status.sold_out"
          : "menu.availability.status.available",
      )}
    </Badge>
  );
}
