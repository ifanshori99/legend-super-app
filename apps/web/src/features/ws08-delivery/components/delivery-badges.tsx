// Status pills and badges of the delivery ops screen (PRD §3.23, D12).
// Every tinted state carries an icon and the state in words (DESIGN.md:
// status is never color alone), and platform names stay in ink so no platform
// brand color enters the product UI.
import {
  Ban,
  Bike,
  ChefHat,
  CircleCheck,
  CircleHelp,
  CircleX,
  Inbox,
  PackageCheck,
  PackageX,
  PenLine,
  RefreshCw,
  TriangleAlert,
  Unplug,
  type LucideIcon,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge, StatusPill, type StatusKind } from "@/components/ui/badge";
import type {
  DeliveryMappingStatus,
  DeliveryOrderSource,
  DeliveryOrderStatus,
  DeliveryPlatformSync,
  DeliverySettlementStatus,
  DeliverySyncStatus,
} from "@starter/shared/delivery";
import {
  mappingStatusKey,
  orderStatusKey,
  platformSyncKey,
  settlementStatusKey,
  sourceKey,
  syncStatusKey,
} from "../lib";

const ORDER_PILL: Record<
  DeliveryOrderStatus,
  { status: StatusKind; icon: LucideIcon }
> = {
  received: { status: "info", icon: Inbox },
  accepted: { status: "info", icon: CircleCheck },
  preparing: { status: "warning", icon: ChefHat },
  ready: { status: "success", icon: PackageCheck },
  picked_up: { status: "info", icon: Bike },
  delivered: { status: "success", icon: CircleCheck },
  cancelled: { status: "danger", icon: CircleX },
  rejected: { status: "danger", icon: Ban },
};

export function OrderStatusPill({ status }: { status: DeliveryOrderStatus }) {
  const t = useT();
  const pill = ORDER_PILL[status];
  return (
    <StatusPill status={pill.status} icon={pill.icon}>
      {t(orderStatusKey(status))}
    </StatusPill>
  );
}

const SYNC_PILL: Record<
  DeliverySyncStatus,
  { status: StatusKind; icon: LucideIcon }
> = {
  ok: { status: "success", icon: CircleCheck },
  stale: { status: "warning", icon: TriangleAlert },
  error: { status: "danger", icon: CircleX },
};

export function SyncStatusPill({ status }: { status: DeliverySyncStatus }) {
  const t = useT();
  const pill = SYNC_PILL[status];
  return (
    <StatusPill status={pill.status} icon={pill.icon}>
      {t(syncStatusKey(status))}
    </StatusPill>
  );
}

const SETTLEMENT_PILL: Record<
  DeliverySettlementStatus,
  { status: StatusKind; icon: LucideIcon }
> = {
  matched: { status: "success", icon: CircleCheck },
  variance: { status: "warning", icon: TriangleAlert },
  unknown_order: { status: "danger", icon: CircleHelp },
};

export function SettlementStatusPill({
  status,
}: {
  status: DeliverySettlementStatus;
}) {
  const t = useT();
  const pill = SETTLEMENT_PILL[status];
  return (
    <StatusPill status={pill.status} icon={pill.icon}>
      {t(settlementStatusKey(status))}
    </StatusPill>
  );
}

const MAPPING_BADGE: Record<
  DeliveryMappingStatus,
  {
    tone: "neutral" | "warning" | "danger";
    icon: LucideIcon;
  }
> = {
  matched: { tone: "neutral", icon: CircleCheck },
  price_mismatch: { tone: "warning", icon: TriangleAlert },
  unmatched: { tone: "danger", icon: Unplug },
  sold_out: { tone: "warning", icon: PackageX },
};

export function MappingBadge({ status }: { status: DeliveryMappingStatus }) {
  const t = useT();
  const badge = MAPPING_BADGE[status];
  const Icon = badge.icon;
  return (
    <Badge tone={badge.tone}>
      <Icon aria-hidden="true" />
      {t(mappingStatusKey(status))}
    </Badge>
  );
}

export function SourceBadge({ source }: { source: DeliveryOrderSource }) {
  const t = useT();
  return (
    <Badge tone={source === "manual_pos" ? "brand" : "neutral"}>
      {t(sourceKey(source))}
    </Badge>
  );
}

/** D12 "Mode Manual": integration not active, the cashier records the order. */
export function ManualModeBadge() {
  const t = useT();
  return (
    <Badge tone="warning">
      <PenLine aria-hidden="true" />
      {t("deliveryOps.kanal.manualLabel")}
    </Badge>
  );
}

/**
 * Platform sync of an order's latest status step (legend-u37u3). `ok` renders
 * nothing; `retrying` is a neutral note (the system resends alone); `needs_action`
 * is a warning with the state in words, never color alone.
 */
export function PlatformSyncBadge({ sync }: { sync: DeliveryPlatformSync }) {
  const t = useT();
  if (sync === "ok") return null;
  const needsAction = sync === "needs_action";
  const Icon = needsAction ? TriangleAlert : RefreshCw;
  return (
    <Badge
      tone={needsAction ? "warning" : "neutral"}
      className="max-w-full rounded-xl text-left leading-4 whitespace-normal"
      data-slot="platform-sync-badge"
      data-sync={sync}
    >
      <Icon aria-hidden="true" />
      {t(platformSyncKey(sync))}
    </Badge>
  );
}
