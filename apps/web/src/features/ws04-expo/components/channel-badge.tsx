// Channel shown on an expo card and pickup tile (PRD §6 `orders.channel`).
// The platform names are the platforms' own; everything else is catalog text.
import {
  Bike,
  CalendarClock,
  ShoppingBag,
  UtensilsCrossed,
  type LucideIcon,
} from "lucide-react";
import type { MessageKey } from "@starter/shared/i18n";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/components/i18n";

type Channel =
  "dine_in" | "takeaway" | "gofood" | "grabfood" | "shopeefood" | "reservation";

const CHANNELS: Record<
  Channel,
  { labelKey: MessageKey; icon: LucideIcon; delivery: boolean }
> = {
  dine_in: {
    labelKey: "channel.dineIn",
    icon: UtensilsCrossed,
    delivery: false,
  },
  takeaway: {
    labelKey: "channel.takeaway",
    icon: ShoppingBag,
    delivery: false,
  },
  gofood: { labelKey: "channel.gofood", icon: Bike, delivery: true },
  grabfood: { labelKey: "channel.grabfood", icon: Bike, delivery: true },
  shopeefood: { labelKey: "channel.shopeefood", icon: Bike, delivery: true },
  reservation: {
    labelKey: "channel.reservation",
    icon: CalendarClock,
    delivery: false,
  },
};

/**
 * Channel badge: icon + text, never colour alone. Delivery channels carry the
 * `info` tone because the driver, not the waiter, collects the order.
 */
export function ChannelBadge({
  channel,
  className,
}: {
  channel: Channel;
  className?: string;
}) {
  const t = useT();
  const { labelKey, icon: Icon, delivery } = CHANNELS[channel];
  return (
    <Badge tone={delivery ? "info" : "neutral"} className={className}>
      <Icon aria-hidden="true" />
      {t(labelKey)}
    </Badge>
  );
}
