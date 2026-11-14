// One incoming platform order in full (PRD v1.7 §3.23 "Injeksi Pesanan" and
// §4 Alur G): the platform lines with their menu mapping, the money the
// platform reported, the internal order it was injected into, and every
// fulfilment step the contract machine allows from the current status.
import * as React from "react";
import { CircleAlert, RefreshCw, TriangleAlert } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Money } from "@/components/ui/money";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useSupportReadOnly } from "@/features/ws01-support-access/read-only";
import type {
  DeliveryChannelOrder,
  DeliveryOrderStatus,
} from "@starter/shared/delivery";
import type { MessageKey } from "@starter/shared/i18n";
import {
  useDeliveryOrder,
  useMapOrderLines,
  useItemVariantsFor,
  useMenuItems,
  useResendOrderSync,
  useResolveOrderSync,
  useUpdateOrderStatus,
} from "../hooks";
import {
  businessDateOf,
  deliveryErrorKey,
  formatBusinessDate,
  formatClock,
  modifiersSummary,
  orderActions,
  orderCanEnterKitchen,
  orderHasPriceMismatch,
  lineNeedsMapping,
  orderHasUnmatchedLine,
  orderIsFinal,
  orderNeedsReview,
  orderNetIdr,
  platformKey,
  type DeliveryOrderAction,
} from "../lib";
import {
  MappingBadge,
  OrderStatusPill,
  PlatformSyncBadge,
  SourceBadge,
} from "./delivery-badges";

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="type-eyebrow text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm font-medium">{children}</dd>
    </div>
  );
}

function OrderSkeleton() {
  const t = useT();
  return (
    <div aria-busy="true" className="grid gap-3">
      <span className="sr-only" role="status">
        {t("common.loading")}
      </span>
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-24 w-full rounded-container" />
      <Skeleton className="h-40 w-full rounded-container" />
    </div>
  );
}

function LineList({ order }: { order: DeliveryChannelOrder }) {
  const t = useT();
  return (
    <ul className="grid gap-2">
      {order.lines.map((line) => (
        <li
          key={line.lineNo}
          className="grid gap-1 rounded-container border-(length:--border-w) bg-card p-3"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold">{line.externalItemName}</p>
              <p className="text-sm text-muted-foreground tabular">
                {t("deliveryOps.detail.lineQty")} {line.quantity}
                {" · "}
                <Money amount={line.unitPriceIdr} size="sm" />
              </p>
            </div>
            <Money amount={line.lineTotalIdr} size="sm" />
          </div>
          {line.modifiers.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {t("deliveryOps.detail.modifiers", {
                modifiers: modifiersSummary(line.modifiers),
              })}
            </p>
          )}
          {line.note && (
            <p className="text-sm text-muted-foreground">
              {t("deliveryOps.detail.lineNote", { note: line.note })}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <MappingBadge status={line.mapping} />
            {line.channelPriceIdr !== null &&
              line.channelPriceIdr !== line.unitPriceIdr && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  {t("deliveryOps.detail.channelPrice")}
                  <Money amount={line.channelPriceIdr} size="sm" />
                </span>
              )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function isStaleSync(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "DELIVERY_SYNC_NOT_PENDING"
  );
}

/**
 * Founder Q58: two recovery buttons on a `needs_action` order. Resend is one
 * request per press. Mark handled asks for an optional note first, because it
 * clears the mark without the platform confirming anything. Both go through
 * `mutateAsync`: a success clears the mark, the refetch unmounts this block,
 * and a `mutate` callback would be dropped with it.
 */
function PlatformSyncActions({
  outletId,
  order,
  platform,
  disabled,
  onBusyChange,
}: {
  outletId: string;
  order: DeliveryChannelOrder;
  platform: string;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const t = useT();
  const toast = useToast();
  const resend = useResendOrderSync();
  const resolve = useResolveOrderSync();
  const [confirming, setConfirming] = React.useState(false);
  const [note, setNote] = React.useState("");
  const busy = resend.isPending || resolve.isPending;
  const readOnly = useSupportReadOnly();
  const locked = disabled || readOnly;
  const resolveButton = React.useRef<HTMLButtonElement>(null);
  // The status buttons below lock while a sync write is in flight, so the two
  // never race on one order. Release on unmount: the mark clearing unmounts us.
  React.useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  const stillFailing =
    resend.isSuccess && resend.data.platformSync === "needs_action";
  const error = resend.error ?? resolve.error;

  const onResend = async () => {
    if (busy) return;
    resolve.reset();
    try {
      const next = await resend.mutateAsync({
        outletId,
        deliveryOrderId: order.id,
      });
      if (next.platformSync === "ok")
        toast({
          title: t("deliveryOps.platformSync.resendSuccess", { platform }),
          tone: "success",
        });
    } catch (caught) {
      // Another staff member got there first: the refetch removes this block,
      // so the inline error would never be seen. Say it in a toast instead.
      if (isStaleSync(caught))
        toast({ title: t(deliveryErrorKey(caught)), tone: "info" });
    }
  };

  const onResolve = async () => {
    if (busy) return;
    resend.reset();
    const reason = note.trim();
    try {
      await resolve.mutateAsync({
        outletId,
        deliveryOrderId: order.id,
        body: reason === "" ? {} : { reason },
      });
      toast({
        title: t("deliveryOps.platformSync.resolved"),
        tone: "success",
      });
      setConfirming(false);
      setNote("");
    } catch (caught) {
      if (isStaleSync(caught))
        toast({ title: t(deliveryErrorKey(caught)), tone: "info" });
    }
  };

  return (
    <div
      role="group"
      aria-label={t("deliveryOps.platformSync.actionsLabel")}
      className="grid gap-2 border-t border-warning/30 pt-3"
    >
      {confirming && (
        <div className="grid gap-2 rounded-container border-(length:--border-w) bg-card p-card">
          <FormField
            label={t("deliveryOps.platformSync.resolveNoteLabel")}
            hint={t("deliveryOps.platformSync.resolveNoteHint")}
          >
            <Textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={t("deliveryOps.platformSync.resolveNotePlaceholder")}
              rows={2}
              maxLength={300}
              autoFocus
            />
          </FormField>
          <div className="flex flex-wrap gap-2">
            <Button
              className="min-h-11"
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                setNote("");
                resolve.reset();
                // The confirm area unmounts this button: hand focus back.
                requestAnimationFrame(() => resolveButton.current?.focus());
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              className="min-h-11"
              type="button"
              variant="outline"
              loading={resolve.isPending}
              disabled={locked || busy}
              onClick={() => void onResolve()}
            >
              {t("deliveryOps.platformSync.resolveConfirm")}
            </Button>
          </div>
        </div>
      )}
      <p
        role="status"
        className="flex items-start gap-1.5 font-medium text-warning empty:hidden"
      >
        {stillFailing && (
          <>
            <TriangleAlert
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            {t("deliveryOps.platformSync.resendStillFailing", { platform })}
          </>
        )}
      </p>
      {error && (
        <p role="alert" className="font-medium text-danger">
          {t(deliveryErrorKey(error))}
        </p>
      )}
      {!confirming && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Button
            className="min-h-11"
            type="button"
            variant="outline"
            loading={resend.isPending}
            disabled={locked || busy}
            onClick={() => void onResend()}
          >
            {t("deliveryOps.platformSync.resend")}
          </Button>
          <Button
            className="min-h-11"
            ref={resolveButton}
            type="button"
            variant="outline"
            disabled={locked || busy}
            onClick={() => {
              resend.reset();
              setConfirming(true);
            }}
          >
            {t("deliveryOps.platformSync.resolve")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Staff guidance for a platform sync that is not `ok` (legend-u37u3). */
function PlatformSyncNote({
  order,
  outletId,
  canAct,
  online,
  onBusyChange,
}: {
  order: DeliveryChannelOrder;
  outletId: string;
  canAct: boolean;
  online: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const t = useT();
  if (order.platformSync === "ok") return null;
  const platform = t(platformKey(order.platform));
  if (order.platformSync === "retrying")
    return (
      <div
        role="note"
        className="flex items-start gap-2 rounded-container bg-surface-2 p-card text-sm"
      >
        <RefreshCw
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <p>{t("deliveryOps.platformSync.retryingHint", { platform })}</p>
      </div>
    );
  const final = orderIsFinal(order.status);
  return (
    <div
      role="note"
      className="grid gap-2 rounded-container bg-warning-subtle p-card text-sm"
    >
      <h3 className="flex items-start gap-2 text-sm font-semibold text-warning">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {t("deliveryOps.platformSync.needsActionTitle", { platform })}
      </h3>
      <p>{t("deliveryOps.platformSync.needsActionIntro")}</p>
      <ol
        aria-label={t("deliveryOps.platformSync.needsActionStepsLabel")}
        className="grid list-decimal gap-1 pl-5"
      >
        <li>
          {t("deliveryOps.platformSync.needsActionStep1", { platform })}{" "}
          <span translate="no" className="font-mono whitespace-nowrap">
            {order.externalOrderId}
          </span>
          .
        </li>
        <li>{t("deliveryOps.platformSync.needsActionStep2")}</li>
        {!final && (
          <li>
            {t("deliveryOps.platformSync.needsActionStep3", { platform })}
          </li>
        )}
      </ol>
      {final && (
        <p>{t("deliveryOps.platformSync.needsActionFinal", { platform })}</p>
      )}
      {canAct && (
        <PlatformSyncActions
          outletId={outletId}
          order={order}
          platform={platform}
          disabled={!online}
          onBusyChange={onBusyChange}
        />
      )}
    </div>
  );
}

/** The menu item (and variant, when it has some) staff chose for one line. */
type LinePick = { menuItemId: string; variantId: string | null };

/**
 * legend-5d76: staff map each unmatched (or sold-out) line of a needs_review
 * order to a menu item, plus a variant when that item has some, and send it to
 * the kitchen in one request. The platform price and total stay as received;
 * the server rejects an item that is missing, inactive, unpriced or sold out
 * (422 `DELIVERY_MAPPING_INCOMPLETE`). Uses `mutateAsync`: on success the
 * refetch unmounts this block.
 */
function MappingSection({
  outletId,
  order,
  platform,
  disabled,
  onBusyChange,
}: {
  outletId: string;
  order: DeliveryChannelOrder;
  platform: string;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const t = useT();
  const toast = useToast();
  const menu = useMenuItems();
  const map = useMapOrderLines();
  const readOnly = useSupportReadOnly();
  const idPrefix = React.useId();
  const [picked, setPicked] = React.useState<Record<number, LinePick>>({});
  const unmatchedLines = order.lines.filter(lineNeedsMapping);
  const menuItems = menu.data?.data ?? [];
  const variantQueries = useItemVariantsFor(
    unmatchedLines.map((line) => picked[line.lineNo]?.menuItemId ?? null),
  );
  // A line is done once its item is chosen and, if the item has variants, the
  // variant too. Variants still loading (or failed) keep the button off.
  const complete = unmatchedLines.every((line, index) => {
    const pick = picked[line.lineNo];
    const variants = variantQueries[index]?.data?.data;
    if (!pick || !variants) return false;
    return variants.length === 0 || pick.variantId !== null;
  });
  const busy = map.isPending;
  React.useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);

  const onSubmit = async () => {
    if (busy || !complete) return;
    try {
      await map.mutateAsync({
        outletId,
        deliveryOrderId: order.id,
        body: {
          mappings: unmatchedLines.map((line) => ({
            lineNo: line.lineNo,
            externalItemId: line.externalItemId,
            menuItemId: picked[line.lineNo].menuItemId,
            ...(picked[line.lineNo].variantId !== null && {
              variantId: picked[line.lineNo].variantId,
            }),
          })),
        },
      });
      toast({ title: t("deliveryOps.mapLines.success"), tone: "success" });
    } catch {
      // The error shows inline below; the order stays needs_review.
    }
  };

  return (
    <section
      aria-label={t("deliveryOps.mapLines.groupLabel")}
      className="grid gap-3 rounded-container bg-warning-subtle p-card text-sm"
    >
      <h3 className="flex items-start gap-2 text-sm font-semibold text-warning">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {t("deliveryOps.mapLines.title")}
      </h3>
      <p>{t("deliveryOps.mapLines.intro", { platform })}</p>
      <p className="text-muted-foreground">
        {t("deliveryOps.mapLines.priceHint")}
      </p>
      {menu.isError && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="font-medium text-danger">
            {t("deliveryOps.mapLines.menuError")}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void menu.refetch()}
          >
            {t("deliveryOps.mapLines.menuRetry")}
          </Button>
        </div>
      )}
      <ul className="grid gap-2">
        {unmatchedLines.map((line, index) => {
          const fieldId = `${idPrefix}-${line.lineNo}`;
          const variantQuery = variantQueries[index];
          const variants = variantQuery?.data?.data ?? [];
          return (
            <li
              key={line.lineNo}
              className="grid gap-2 rounded-container border-(length:--border-w) bg-card p-3"
            >
              <p className="font-semibold">
                {line.externalItemName}
                <span className="font-normal text-muted-foreground tabular">
                  {" · "}
                  {t("deliveryOps.detail.lineQty")} {line.quantity}
                </span>
              </p>
              <FormField
                id={fieldId}
                label={t("deliveryOps.mapLines.itemLabel", {
                  name: line.externalItemName,
                })}
              >
                <Select
                  value={picked[line.lineNo]?.menuItemId ?? ""}
                  onValueChange={(value) =>
                    setPicked((current) => ({
                      ...current,
                      [line.lineNo]: { menuItemId: value, variantId: null },
                    }))
                  }
                  disabled={busy || menu.isPending}
                >
                  <SelectTrigger id={fieldId}>
                    <SelectValue
                      placeholder={t("deliveryOps.mapLines.itemPlaceholder")}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {menuItems.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              {variantQuery?.isError && (
                <div className="flex flex-wrap items-center gap-2">
                  <p role="alert" className="font-medium text-danger">
                    {t("deliveryOps.mapLines.variantError")}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void variantQuery.refetch()}
                  >
                    {t("deliveryOps.mapLines.menuRetry")}
                  </Button>
                </div>
              )}
              {variants.length > 0 && (
                <FormField
                  id={`${fieldId}-variant`}
                  label={t("deliveryOps.mapLines.variantLabel", {
                    name: line.externalItemName,
                  })}
                >
                  <Select
                    value={picked[line.lineNo]?.variantId ?? ""}
                    onValueChange={(value) =>
                      setPicked((current) => ({
                        ...current,
                        [line.lineNo]: {
                          menuItemId: current[line.lineNo].menuItemId,
                          variantId: value,
                        },
                      }))
                    }
                    disabled={busy}
                  >
                    <SelectTrigger id={`${fieldId}-variant`}>
                      <SelectValue
                        placeholder={t(
                          "deliveryOps.mapLines.variantPlaceholder",
                        )}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {variants.map((variant) => (
                        <SelectItem key={variant.id} value={variant.id}>
                          {variant.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
              )}
            </li>
          );
        })}
      </ul>
      {map.error && (
        <p role="alert" className="font-medium text-danger">
          {t(deliveryErrorKey(map.error))}
        </p>
      )}
      <Button
        className="min-h-11"
        type="button"
        loading={busy}
        disabled={disabled || readOnly || busy || !complete}
        onClick={() => void onSubmit()}
      >
        {t("deliveryOps.mapLines.submit")}
      </Button>
    </section>
  );
}

function OrderDetailBody({
  outletId,
  timeZone,
  deliveryOrderId,
  canHandle,
  online,
}: {
  outletId: string;
  timeZone: string;
  deliveryOrderId: string;
  canHandle: boolean;
  online: boolean;
}) {
  const t = useT();
  const toast = useToast();
  const orderQuery = useDeliveryOrder(outletId, deliveryOrderId);
  const update = useUpdateOrderStatus();
  const [pending, setPending] = React.useState<DeliveryOrderAction | null>(
    null,
  );
  const [reason, setReason] = React.useState("");
  const [showError, setShowError] = React.useState(false);
  const [syncBusy, setSyncBusy] = React.useState(false);

  if (orderQuery.isPending) return <OrderSkeleton />;
  if (orderQuery.isError || !orderQuery.data)
    return (
      <ErrorState
        title={t("deliveryOps.detail.errorTitle")}
        description={t("deliveryOps.pesanan.errorHint")}
        onRetry={() => void orderQuery.refetch()}
      />
    );

  const order = orderQuery.data;
  const actions = orderActions(order.status);
  const injectable = orderCanEnterKitchen(order);
  const priceMismatch = orderHasPriceMismatch(order);
  const needsReview = orderNeedsReview(order);
  const unmatched = orderHasUnmatchedLine(order);
  const reasonMissing = reason.trim() === "";
  const reasonError =
    showError && reasonMissing
      ? t("deliveryOps.detail.reasonRequired")
      : undefined;
  const mutationError = update.error ? t(deliveryErrorKey(update.error)) : null;
  const disabled = !canHandle || !online || update.isPending || syncBusy;

  const moments: { labelKey: MessageKey; instant: string }[] = [
    { labelKey: "deliveryOps.detail.received", instant: order.receivedAt },
  ];
  if (order.acceptedAt)
    moments.push({
      labelKey: "deliveryOps.detail.accepted",
      instant: order.acceptedAt,
    });
  if (order.readyAt)
    moments.push({
      labelKey: "deliveryOps.detail.ready",
      instant: order.readyAt,
    });
  if (order.pickedUpAt)
    moments.push({
      labelKey: "deliveryOps.detail.pickedUp",
      instant: order.pickedUpAt,
    });
  if (order.deliveredAt)
    moments.push({
      labelKey: "deliveryOps.detail.delivered",
      instant: order.deliveredAt,
    });
  if (order.closedAt)
    moments.push({
      labelKey: "deliveryOps.detail.closed",
      instant: order.closedAt,
    });

  const submit = (to: DeliveryOrderStatus) => {
    const closing = to === "cancelled" || to === "rejected";
    if (closing && reasonMissing) {
      setShowError(true);
      return;
    }
    update.mutate(
      {
        outletId,
        deliveryOrderId: order.id,
        body: { status: to, ...(closing ? { reason: reason.trim() } : {}) },
      },
      {
        onSuccess: () => {
          toast({
            title: t("deliveryOps.pesanan.updated"),
            tone: "success",
          });
          setPending(null);
          setReason("");
          setShowError(false);
        },
      },
    );
  };

  return (
    <>
      <SheetHeader>
        <SheetTitle>
          {t("deliveryOps.detail.title", { id: order.externalOrderId })}
        </SheetTitle>
        <SheetDescription className="flex flex-wrap items-center gap-1">
          <OrderStatusPill status={order.status} />
          <SourceBadge source={order.source} />
          <Badge tone="neutral">{t(platformKey(order.platform))}</Badge>
          <PlatformSyncBadge sync={order.platformSync} />
        </SheetDescription>
      </SheetHeader>

      <div className="grid min-w-0 gap-4">
        <dl className="grid grid-cols-2 gap-3 rounded-container border-(length:--border-w) bg-card p-card">
          {moments.map((moment) => (
            <Fact key={moment.labelKey} label={t(moment.labelKey)}>
              <span className="tabular">
                {formatClock(moment.instant, timeZone)}
              </span>
              <span className="block text-xs font-normal text-muted-foreground tabular">
                {formatBusinessDate(businessDateOf(moment.instant, timeZone))}
              </span>
            </Fact>
          ))}
          <Fact label={t("deliveryOps.detail.internalOrder")}>
            {order.number ? (
              <span className="font-mono">{order.number}</span>
            ) : (
              <span className="text-sm font-normal text-muted-foreground">
                {t("deliveryOps.detail.internalOrderNone")}
              </span>
            )}
          </Fact>
          <Fact label={t("deliveryOps.detail.settlement")}>
            {order.settledNetIdr !== null ? (
              <Money amount={order.settledNetIdr} size="sm" />
            ) : (
              <span className="text-sm font-normal text-muted-foreground">
                {t("deliveryOps.detail.settlementNone")}
              </span>
            )}
          </Fact>
          {order.closeReason && (
            <Fact label={t("deliveryOps.detail.closeReason")}>
              {order.closeReason}
            </Fact>
          )}
        </dl>

        <PlatformSyncNote
          order={order}
          outletId={outletId}
          canAct={canHandle}
          online={online}
          onBusyChange={setSyncBusy}
        />

        {needsReview && canHandle && (
          <MappingSection
            outletId={outletId}
            order={order}
            platform={t(platformKey(order.platform))}
            disabled={!online}
            onBusyChange={setSyncBusy}
          />
        )}

        {order.customerNote && (
          <div className="grid gap-1 rounded-container bg-surface-2 p-card">
            <p className="type-eyebrow text-muted-foreground">
              {t("deliveryOps.detail.customerNote")}
            </p>
            <p className="text-sm">{order.customerNote}</p>
          </div>
        )}

        <section className="grid gap-2">
          <h3 className="type-heading">{t("deliveryOps.detail.lines")}</h3>
          <LineList order={order} />
        </section>

        <dl className="grid gap-1.5 rounded-container bg-surface-2 p-card text-sm">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground">
              {t("deliveryOps.detail.gross")}
            </dt>
            <dd>
              <Money amount={order.grossIdr} size="sm" />
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground">
              {t("deliveryOps.detail.commission")}
            </dt>
            <dd>
              <Money amount={order.commissionIdr} size="sm" />
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3 border-t pt-1.5 font-semibold">
            <dt>{t("deliveryOps.detail.net")}</dt>
            <dd>
              <Money amount={orderNetIdr(order)} size="sm" />
            </dd>
          </div>
        </dl>

        <section className="grid gap-2">
          {priceMismatch && (
            <p className="flex items-start gap-1.5 rounded-container bg-warning-subtle p-3 text-sm font-medium text-warning">
              <CircleAlert
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              {t("deliveryOps.detail.priceMismatchHint")}
            </p>
          )}
          {unmatched && !(needsReview && canHandle) && (
            <p className="flex items-start gap-1.5 rounded-container bg-danger-subtle p-3 text-sm font-medium text-danger">
              <CircleAlert
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              {t("deliveryOps.detail.notInjectable")}
            </p>
          )}

          {!canHandle && (
            <p className="text-sm text-muted-foreground">
              {t("deliveryOps.pesanan.handleOnly")}
            </p>
          )}

          {pending !== null && (
            <div className="grid gap-2 rounded-container border-(length:--border-w) bg-card p-card">
              <FormField
                label={t("deliveryOps.detail.reasonLabel")}
                hint={t("deliveryOps.detail.closeHint")}
                error={reasonError}
                required
              >
                <Textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder={t("deliveryOps.detail.reasonPlaceholder")}
                  rows={3}
                  maxLength={300}
                />
              </FormField>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setPending(null);
                    setReason("");
                    setShowError(false);
                  }}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  loading={update.isPending}
                  disabled={!canHandle || !online}
                  onClick={() => submit(pending.to)}
                >
                  {t(
                    pending.to === "rejected"
                      ? "deliveryOps.detail.confirmReject"
                      : "deliveryOps.detail.confirmCancel",
                  )}
                </Button>
              </div>
            </div>
          )}

          {mutationError && (
            <p role="alert" className="text-sm font-medium text-danger">
              {mutationError}
            </p>
          )}

          {actions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("deliveryOps.detail.noAction")}
            </p>
          ) : (
            <div className="grid gap-2">
              {actions.map((action) =>
                action.needsReason ? (
                  <Button
                    key={action.to}
                    type="button"
                    variant="outline"
                    disabled={disabled}
                    onClick={() => {
                      setPending(action);
                      setReason("");
                      setShowError(false);
                    }}
                  >
                    {t(action.labelKey)}
                  </Button>
                ) : (
                  <Button
                    key={action.to}
                    type="button"
                    variant={action.to === "accepted" ? "default" : "outline"}
                    loading={
                      update.isPending &&
                      update.variables?.body.status === action.to
                    }
                    disabled={
                      disabled || (action.to === "accepted" && !injectable)
                    }
                    onClick={() => submit(action.to)}
                  >
                    {t(action.labelKey)}
                  </Button>
                ),
              )}
            </div>
          )}
        </section>
      </div>
    </>
  );
}

export function OrderDetailSheet({
  open,
  onOpenChange,
  outletId,
  timeZone,
  deliveryOrderId,
  canHandle,
  online,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  outletId: string;
  timeZone: string;
  deliveryOrderId: string | null;
  canHandle: boolean;
  online: boolean;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[min(34rem,calc(100%-1.5rem))]">
        {deliveryOrderId !== null && (
          <OrderDetailBody
            outletId={outletId}
            timeZone={timeZone}
            deliveryOrderId={deliveryOrderId}
            canHandle={canHandle}
            online={online}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
