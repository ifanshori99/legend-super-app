// Tab Kanal (PRD v1.7 §3.23 "Adapter per Platform", D12 "Mode Manual"): one
// card per platform with the store open/closed switch, the published menu and
// its sold-out count, the review hints the live orders raise (a platform price
// that differs from our channel price list, an unmapped line) and the menu
// sync status with its last run.
import * as React from "react";
import {
  Info,
  PackageX,
  RefreshCw,
  Store,
  CircleSlash,
  TriangleAlert,
  Unplug,
  type LucideIcon,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBand } from "@/components/ui/status-band";
import { StatusPill } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import type {
  DeliveryChannel,
  DeliveryChannelOrder,
} from "@starter/shared/delivery";
import {
  useChannels,
  useDeliveryOrders,
  useSetChannelState,
  useSyncChannelMenu,
} from "../hooks";
import {
  channelIsManual,
  deliveryErrorKey,
  formatDateTime,
  platformKey,
  reviewCounts,
} from "../lib";
import { ManualModeBadge, SyncStatusPill } from "./delivery-badges";

function ChannelSkeleton() {
  const t = useT();
  return (
    <div aria-busy="true" className="grid gap-4">
      <span className="sr-only" role="status">
        {t("common.loading")}
      </span>
      <Skeleton className="h-16 w-full rounded-container" />
      <div className="grid gap-4 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-80 w-full rounded-shell" />
        ))}
      </div>
    </div>
  );
}

/** D12: until a partner approves the integration the cashier records orders. */
function ManualModeNote() {
  const t = useT();
  return (
    <section className="overflow-hidden rounded-container border-(length:--border-w) bg-card shadow-hairline">
      <StatusBand
        tone="info"
        icon={Info}
        label={t("deliveryOps.kanal.manualNoteLabel")}
      >
        <p className="max-w-3xl text-sm leading-5">
          {t("deliveryOps.kanal.manualBody")}
        </p>
      </StatusBand>
    </section>
  );
}

function ReviewHint({
  icon: Icon,
  tone,
  children,
}: {
  icon: LucideIcon;
  tone: "warning" | "danger";
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-1.5">
      <Icon
        className={
          tone === "danger"
            ? "mt-0.5 size-4 shrink-0 text-danger"
            : "mt-0.5 size-4 shrink-0 text-warning"
        }
        aria-hidden="true"
      />
      <span>{children}</span>
    </li>
  );
}

function ChannelCard({
  outletId,
  timeZone,
  channel,
  canManage,
  online,
  liveOrders,
}: {
  outletId: string;
  timeZone: string;
  channel: DeliveryChannel;
  canManage: boolean;
  online: boolean;
  liveOrders: readonly DeliveryChannelOrder[];
}) {
  const t = useT();
  const toast = useToast();
  const setState = useSetChannelState();
  const sync = useSyncChannelMenu();
  const switchId = React.useId();
  const manual = channelIsManual(channel);
  const platform = t(platformKey(channel.platform));
  const review = reviewCounts(liveOrders, channel.platform);
  const closed = !channel.isOpen;
  const actionsDisabled = !canManage || !online;
  const stateError = setState.error
    ? t(deliveryErrorKey(setState.error))
    : null;
  const syncError = sync.error ? t(deliveryErrorKey(sync.error)) : null;
  const reviewClear =
    channel.soldOutItemCount === 0 &&
    review.priceMismatch === 0 &&
    review.unmatched === 0;

  const toggle = (checked: boolean) => {
    setState.mutate(
      {
        outletId,
        platform: channel.platform,
        body: { isOpen: checked },
      },
      {
        onSuccess: () =>
          toast({
            title: t(
              checked
                ? "deliveryOps.kanal.openedToast"
                : "deliveryOps.kanal.closedToast",
              { platform },
            ),
            tone: "success",
          }),
      },
    );
  };

  const runSync = () => {
    sync.mutate(
      { outletId, platform: channel.platform },
      {
        onSuccess: (result) =>
          toast({
            title: t("deliveryOps.kanal.syncSuccess", {
              pushed: result.pushedItemCount,
              soldOut: result.soldOutItemCount,
            }),
            tone: "success",
          }),
        onError: (error) =>
          toast({
            title: t("deliveryOps.kanal.syncErrorToast"),
            description: t(deliveryErrorKey(error)),
            tone: "danger",
          }),
      },
    );
  };

  return (
    <CardShell>
      <CardShellBody>
        <div className="flex min-w-0 flex-1 flex-col gap-4 p-card">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="grid gap-1.5">
              <h3 className="type-title">{platform}</h3>
              <StatusPill
                status={channel.isOpen ? "success" : "info"}
                icon={channel.isOpen ? Store : CircleSlash}
              >
                {t(
                  channel.isOpen
                    ? "deliveryOps.kanal.openState"
                    : "deliveryOps.kanal.closedState",
                )}
              </StatusPill>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <SyncStatusPill status={channel.syncStatus} />
              {manual && <ManualModeBadge />}
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-container bg-surface-2 p-3">
            <div className="grid min-w-0 gap-0.5">
              <Label htmlFor={switchId}>
                {t("deliveryOps.kanal.switchLabel", { platform })}
              </Label>
              <p className="text-xs leading-4 text-muted-foreground">
                {t("deliveryOps.kanal.switchHint")}
              </p>
            </div>
            <Switch
              id={switchId}
              aria-label={t("deliveryOps.kanal.switchLabel", { platform })}
              checked={channel.isOpen}
              disabled={actionsDisabled || setState.isPending}
              onCheckedChange={toggle}
            />
          </div>

          {closed && (
            <div className="grid gap-0.5 text-sm">
              {channel.closedReason && (
                <p>
                  {t("deliveryOps.kanal.closedReason", {
                    reason: channel.closedReason,
                  })}
                </p>
              )}
              <p className="text-muted-foreground">
                {channel.closedUntil
                  ? t("deliveryOps.kanal.reopenAt", {
                      time: formatDateTime(channel.closedUntil, timeZone),
                    })
                  : t("deliveryOps.kanal.closedNoReason")}
              </p>
            </div>
          )}

          <div className="grid gap-2 border-t pt-3">
            <p className="type-eyebrow text-muted-foreground">
              {t("deliveryOps.kanal.menuTitle")}
            </p>
            <p className="text-sm font-medium tabular">
              {t("deliveryOps.kanal.menuPublished", {
                count: channel.menuItemCount,
              })}
              {" · "}
              {t("deliveryOps.kanal.menuSoldOut", {
                count: channel.soldOutItemCount,
              })}
            </p>
            <p className="type-eyebrow text-muted-foreground">
              {t("deliveryOps.kanal.reviewTitle")}
            </p>
            <ul className="grid gap-1.5 text-sm">
              {channel.soldOutItemCount > 0 && (
                <ReviewHint icon={PackageX} tone="warning">
                  {t("deliveryOps.kanal.reviewSoldOut", {
                    count: channel.soldOutItemCount,
                  })}
                </ReviewHint>
              )}
              {review.priceMismatch > 0 && (
                <ReviewHint icon={TriangleAlert} tone="warning">
                  {t("deliveryOps.kanal.reviewPrice", {
                    count: review.priceMismatch,
                  })}
                </ReviewHint>
              )}
              {review.unmatched > 0 && (
                <ReviewHint icon={Unplug} tone="danger">
                  {t("deliveryOps.kanal.reviewUnmatched", {
                    count: review.unmatched,
                  })}
                </ReviewHint>
              )}
              {reviewClear && (
                <li className="text-muted-foreground">
                  {t("deliveryOps.kanal.reviewClean")}
                </li>
              )}
            </ul>
          </div>

          <div className="grid gap-2 border-t pt-3">
            <p className="type-eyebrow text-muted-foreground">
              {t("deliveryOps.kanal.syncTitle")}
            </p>
            <p className="text-sm text-muted-foreground tabular">
              {channel.lastSyncedAt
                ? t("deliveryOps.kanal.syncLast", {
                    time: formatDateTime(channel.lastSyncedAt, timeZone),
                  })
                : t("deliveryOps.kanal.syncNever")}
            </p>
            {channel.syncStatus === "error" && channel.syncError && (
              <p className="text-sm font-medium text-danger">
                {t("deliveryOps.kanal.syncErrorDetail", {
                  message: channel.syncError,
                })}
              </p>
            )}
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={sync.isPending}
                disabled={actionsDisabled || manual}
                onClick={runSync}
              >
                <RefreshCw aria-hidden="true" />
                {t("deliveryOps.kanal.syncButton")}
              </Button>
            </div>
            {stateError && (
              <p role="alert" className="text-sm font-medium text-danger">
                {stateError}
              </p>
            )}
            {syncError && (
              <p role="alert" className="text-sm font-medium text-danger">
                {syncError}
              </p>
            )}
            {!canManage && (
              <p className="text-xs leading-4 text-muted-foreground">
                {t("deliveryOps.kanal.manageOnly")}
              </p>
            )}
          </div>
        </div>
      </CardShellBody>
    </CardShell>
  );
}

export function ChannelsTab({
  outletId,
  timeZone,
  canManage,
  online,
}: {
  outletId: string;
  timeZone: string;
  canManage: boolean;
  online: boolean;
}) {
  const t = useT();
  const channels = useChannels(outletId);
  // One order page is enough for the review hints; the Pesanan tab owns the
  // filtered, paginated list.
  const orders = useDeliveryOrders(outletId, {});
  const liveOrders = orders.data?.pages[0]?.data ?? [];

  if (channels.isPending) return <ChannelSkeleton />;

  if (channels.isError)
    return (
      <CardShell>
        <CardShellBody>
          <ErrorState
            title={t("deliveryOps.kanal.errorTitle")}
            description={t("deliveryOps.kanal.errorHint")}
            onRetry={() => void channels.refetch()}
          />
        </CardShellBody>
      </CardShell>
    );

  const rows = channels.data ?? [];
  if (rows.length === 0)
    return (
      <CardShell>
        <CardShellBody>
          <EmptyState
            title={t("deliveryOps.kanal.emptyTitle")}
            description={t("deliveryOps.kanal.emptyHint")}
          />
        </CardShellBody>
      </CardShell>
    );

  return (
    <div className="grid gap-4">
      <ManualModeNote />
      <div className="grid gap-4 lg:grid-cols-3">
        {rows.map((channel) => (
          <ChannelCard
            key={channel.platform}
            outletId={outletId}
            timeZone={timeZone}
            channel={channel}
            canManage={canManage}
            online={online}
            liveOrders={liveOrders}
          />
        ))}
      </div>
    </div>
  );
}
