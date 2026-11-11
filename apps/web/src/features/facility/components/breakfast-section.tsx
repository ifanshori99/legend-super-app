// Breakfast from the ticket (PRD §3 F22 "Sarapan Siap Saat Keluar Shower",
// alur Z, FAC-10). The guest picks dishes and where to receive them, pays the
// order (founder Q43: never sent to the kitchen unpaid), and the paid order is
// fired `fireOffsetMinutes` before the session ends. The 5-minute
// end-of-session reminder is the session timer's job (session-timer.tsx); web
// push is WS-06 and is not built here.
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Check, CircleAlert, Minus, Plus } from "lucide-react";
import { RadioGroup } from "radix-ui";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { newIdempotencyKey } from "@/lib/idempotency.ts";
import { cn } from "cn";
import type { BreakfastMenu, BreakfastOrder } from "@starter/shared/facility";
import {
  breakfastChosenLines,
  breakfastDraftErrors,
  breakfastFireAt,
  breakfastOrderBody,
  breakfastSubtotalIdr,
  formatClock,
  INITIAL_BREAKFAST_DRAFT,
  setBreakfastQuantity,
  type BreakfastDraft,
} from "../flow";
import { useBreakfastMenu, useOrderBreakfast, usePayBreakfast } from "../hooks";
import { ApiFailure } from "./shared";

const TABLE_FIELD_ID = "breakfast-table";

/** Kitchen fire time for the summary; null (row hidden) when the data is bad. */
function safeFireTime(
  slotEndsAt: string,
  fireOffsetMinutes: number,
): string | null {
  try {
    return formatClock(breakfastFireAt(slotEndsAt, fireOffsetMinutes));
  } catch {
    return null;
  }
}

export function BreakfastSection({
  ticketId,
  slotEndsAt,
}: {
  ticketId: string;
  /** `ticket.slot.endsAt`: the order fires relative to it. */
  slotEndsAt: string;
}) {
  const t = useT();
  const menu = useBreakfastMenu(ticketId);
  // True only after this visit placed the order: the success card then takes
  // focus; an order that already existed on load does not steal it.
  const [justOrdered, setJustOrdered] = useState(false);

  return (
    <section
      aria-labelledby="breakfast-title"
      className="grid gap-3"
      data-testid="breakfast-section"
    >
      <div className="grid gap-1">
        <h2 id="breakfast-title" className="font-brand type-title">
          {t("facilityBreakfast.title")}
        </h2>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("facilityBreakfast.hint")}
        </p>
      </div>
      {/* Stays mounted so the screen reader announces the result. */}
      <p role="status" className="sr-only">
        {justOrdered ? t("facilityBreakfast.awaitingTitle") : ""}
      </p>
      {menu.isPending ? (
        <BreakfastSkeleton />
      ) : menu.isError ? (
        <Card data-testid="breakfast-error">
          <ErrorState
            title={t("facilityBreakfast.errorTitle")}
            description={t("facilityBreakfast.errorHint")}
            error={menu.error}
            onRetry={() => menu.refetch()}
          />
        </Card>
      ) : menu.data.order && menu.data.order.status !== "cancelled" ? (
        <BreakfastHeld
          ticketId={ticketId}
          order={menu.data.order}
          tables={menu.data.tables}
          focusOnMount={justOrdered}
        />
      ) : menu.data.items.length === 0 ? (
        <Card data-testid="breakfast-empty">
          <EmptyState
            title={t("facilityBreakfast.emptyTitle")}
            description={t("facilityBreakfast.emptyHint")}
            action={
              <Button variant="outline" onClick={() => menu.refetch()}>
                {t("facilityBreakfast.reload")}
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          {menu.data.order?.status === "cancelled" && (
            <p
              className="text-sm leading-5 text-muted-foreground"
              data-testid="breakfast-cancelled"
            >
              {t("facilityBreakfast.cancelledNote")}
            </p>
          )}
          <BreakfastForm
            key={ticketId}
            ticketId={ticketId}
            slotEndsAt={slotEndsAt}
            menu={menu.data}
            onOrdered={() => setJustOrdered(true)}
          />
        </>
      )}
    </section>
  );
}

/** Loading shape of the form: dish row with stepper, then the summary card. */
function BreakfastSkeleton() {
  const t = useT();
  return (
    <div
      role="status"
      aria-busy="true"
      data-testid="breakfast-loading"
      className="@container"
    >
      <span className="sr-only">{t("facilityBreakfast.loading")}</span>
      <div className="grid gap-4 @3xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card>
          <div className="flex items-center justify-between gap-4">
            <div className="grid flex-1 gap-2">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-4 w-1/4" />
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="size-control rounded-full" />
              <Skeleton className="h-5 w-5" />
              <Skeleton className="size-control rounded-full" />
            </div>
          </div>
          <Skeleton className="h-12 w-full" />
        </Card>
        <Card>
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-control-lg w-full rounded-full" />
        </Card>
      </div>
    </div>
  );
}

/**
 * The order exists: unpaid (pay now), paid (waits for its fire time) or fired.
 * Only the payment page can make it paid; the button just opens that page.
 */
function BreakfastHeld({
  ticketId,
  order,
  tables,
  focusOnMount,
}: {
  ticketId: string;
  order: BreakfastOrder;
  tables: BreakfastMenu["tables"];
  focusOnMount: boolean;
}) {
  const t = useT();
  const titleRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (focusOnMount) titleRef.current?.focus();
  }, [focusOnMount]);
  const fired = order.status === "fired";
  const awaitingPayment = order.status === "awaiting_payment";
  const navigate = useNavigate();
  const pay = usePayBreakfast(ticketId);
  // One key per order: tapping "Bayar" again reuses the same payment link.
  const payKey = useRef<string | null>(null);

  async function handlePay() {
    payKey.current ??= newIdempotencyKey();
    try {
      const result = await pay.mutateAsync({
        orderId: order.id,
        idempotencyKey: payKey.current,
      });
      // null token: already paid elsewhere; the refetch shows the new status.
      if (result.paymentToken)
        await navigate({
          to: "/bayar/$token",
          params: { token: result.paymentToken },
        });
    } catch {
      // The failure is rendered next to the action by ApiFailure.
    }
  }
  const deliveryLabel = (delivery: BreakfastOrder["delivery"]) => {
    if (delivery.mode === "pickup") return t("facilityBreakfast.summaryPickup");
    const { tableId } = delivery;
    return (
      tables.find((table) => table.id === tableId)?.label ??
      t("facilityBreakfast.tableFallback")
    );
  };
  return (
    <Card data-testid="breakfast-success">
      <div className="grid gap-3">
        <div className="grid gap-1">
          <p ref={titleRef} tabIndex={-1} className="type-heading outline-none">
            {fired
              ? t("facilityBreakfast.firedTitle")
              : awaitingPayment
                ? t("facilityBreakfast.awaitingTitle")
                : t("facilityBreakfast.successTitle")}
          </p>
          <p className="text-sm leading-5 text-muted-foreground">
            {fired
              ? t("facilityBreakfast.firedBody")
              : awaitingPayment
                ? t("facilityBreakfast.awaitingBody")
                : t("facilityBreakfast.successBody", {
                    time: formatClock(order.fireAt),
                  })}
          </p>
        </div>
        <dl className="grid gap-2 text-sm leading-5">
          {order.lines.map((line) => (
            <div
              key={line.menuItemId}
              className="flex items-baseline justify-between gap-3"
            >
              <dt className="min-w-0">
                {t("facilityBreakfast.orderedLine", {
                  quantity: line.quantity,
                  name: line.name,
                })}
              </dt>
              <dd className="font-semibold tabular">
                {formatRupiah(line.unitPriceIdr * line.quantity)}
              </dd>
            </div>
          ))}
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">
              {t("facilityBreakfast.summaryPlace")}
            </dt>
            <dd className="font-semibold">{deliveryLabel(order.delivery)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3 border-t-(length:--border-w) pt-2 text-base">
            <dt className="font-semibold">
              {awaitingPayment
                ? t("facilityBreakfast.total")
                : order.paidAt
                  ? t("facilityBreakfast.totalPaid")
                  : t("facilityBreakfast.totalOrder")}
            </dt>
            <dd className="font-semibold tabular">
              {formatRupiah(order.totalIdr)}
            </dd>
          </div>
        </dl>
        {awaitingPayment && (
          <>
            <Button
              size="lg"
              loading={pay.isPending}
              onClick={handlePay}
              data-testid="breakfast-pay"
            >
              {t("facilityBreakfast.pay")}
            </Button>
            {pay.isError && <ApiFailure error={pay.error} />}
          </>
        )}
      </div>
    </Card>
  );
}

function BreakfastForm({
  ticketId,
  slotEndsAt,
  menu,
  onOrdered,
}: {
  ticketId: string;
  slotEndsAt: string;
  menu: BreakfastMenu;
  onOrdered: () => void;
}) {
  const t = useT();
  const order = useOrderBreakfast(ticketId);
  // Starts empty on purpose: nothing is pre-selected, so no accidental order.
  const [draft, setDraft] = useState<BreakfastDraft>(INITIAL_BREAKFAST_DRAFT);
  const [submitted, setSubmitted] = useState(false);
  // One key per distinct order: a retry of the same draft is idempotent, an
  // edited draft is a new attempt.
  const attempt = useRef<{ signature: string; key: string } | null>(null);

  const errors = submitted ? breakfastDraftErrors(menu.items, draft) : {};
  const lines = breakfastChosenLines(menu.items, draft);
  const subtotal = breakfastSubtotalIdr(menu.items, draft);
  const tableLabel = menu.tables.find(
    (table) => table.id === draft.tableId,
  )?.label;
  const fireTime = safeFireTime(slotEndsAt, menu.fireOffsetMinutes);

  function update(next: BreakfastDraft) {
    setDraft(next);
    if (order.isError) order.reset();
  }

  async function handleSubmit() {
    setSubmitted(true);
    const found = breakfastDraftErrors(menu.items, draft);
    if (found.table) {
      document.getElementById(TABLE_FIELD_ID)?.focus();
      return;
    }
    if (found.items) return;
    const signature = JSON.stringify([
      draft.quantities,
      draft.mode,
      draft.tableId,
    ]);
    if (attempt.current?.signature !== signature)
      attempt.current = { signature, key: newIdempotencyKey() };
    const body = breakfastOrderBody(menu.items, draft, attempt.current.key);
    if (!body) return;
    try {
      await order.mutateAsync(body);
      onOrdered();
    } catch {
      // The failure is rendered next to the action by ApiFailure.
    }
  }

  return (
    <div className="@container">
      <div className="grid gap-4 @3xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] @3xl:items-start">
        <Card data-testid="breakfast-form">
          <ul className="grid divide-y-(length:--border-w)">
            {menu.items.map((item) => {
              const quantity = draft.quantities[item.id] ?? 0;
              return (
                <li
                  key={item.id}
                  className="flex items-center justify-between gap-4 py-3 first:pt-0"
                >
                  <div className="min-w-0">
                    <p className="type-heading">{item.name}</p>
                    <p className="text-sm leading-5 text-muted-foreground tabular">
                      {formatRupiah(item.priceIdr)}
                    </p>
                  </div>
                  <div
                    role="group"
                    aria-label={t("facilityBreakfast.quantityLabel", {
                      name: item.name,
                    })}
                    className="flex shrink-0 items-center gap-2"
                  >
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label={t("facilityBreakfast.decrease", {
                        name: item.name,
                      })}
                      disabled={quantity === 0}
                      onClick={() =>
                        update(
                          setBreakfastQuantity(draft, item.id, quantity - 1),
                        )
                      }
                    >
                      <Minus className="size-4" aria-hidden="true" />
                    </Button>
                    <output
                      aria-live="polite"
                      data-testid={`breakfast-qty-${item.id}`}
                      className="min-w-6 text-center font-semibold tabular"
                    >
                      {quantity}
                    </output>
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label={t("facilityBreakfast.increase", {
                        name: item.name,
                      })}
                      onClick={() =>
                        update(
                          setBreakfastQuantity(draft, item.id, quantity + 1),
                        )
                      }
                    >
                      <Plus className="size-4" aria-hidden="true" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
          {errors.items && (
            <p
              role="alert"
              data-testid="breakfast-items-error"
              className="flex items-start gap-1.5 text-sm leading-5 font-medium text-danger"
            >
              <CircleAlert
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              {t("facilityBreakfast.itemsError")}
            </p>
          )}

          <div className="grid gap-2">
            <h3 className="font-brand type-heading">
              {t("facilityBreakfast.deliveryTitle")}
            </h3>
            <RadioGroup.Root
              aria-label={t("facilityBreakfast.deliveryTitle")}
              value={draft.mode}
              onValueChange={(mode) =>
                update({ ...draft, mode: mode as BreakfastDraft["mode"] })
              }
              className="grid grid-cols-2 gap-3"
            >
              {(
                [
                  ["table", t("facilityBreakfast.deliveryToTable")],
                  ["pickup", t("facilityBreakfast.deliveryPickup")],
                ] as const
              ).map(([value, label]) => (
                <RadioGroup.Item
                  key={value}
                  value={value}
                  data-testid={`breakfast-mode-${value}`}
                  className={cn(
                    "flex min-h-12 min-w-0 items-center gap-2 rounded-field border-(length:--border-w) px-3 py-2 text-left text-sm leading-5 font-medium transition-colors duration-(--duration-fast) focus-visible:shadow-focus focus-visible:outline-none",
                    "data-[state=checked]:border-2 data-[state=checked]:border-primary data-[state=checked]:bg-primary/10 data-[state=checked]:font-semibold",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="grid size-4 shrink-0 place-items-center rounded-full border-(length:--border-w) border-input [[data-state=checked]_&]:border-primary [[data-state=checked]_&]:bg-primary [[data-state=checked]_&]:text-primary-foreground"
                  >
                    <Check className="size-3 opacity-0 [[data-state=checked]_&]:opacity-100" />
                  </span>
                  <span className="min-w-0">{label}</span>
                </RadioGroup.Item>
              ))}
            </RadioGroup.Root>
          </div>
          {draft.mode === "table" && (
            <FormField
              id={TABLE_FIELD_ID}
              label={t("facilityBreakfast.tableLabel")}
              required
              error={
                errors.table ? t("facilityBreakfast.tableError") : undefined
              }
            >
              <Select
                value={draft.tableId}
                onValueChange={(tableId) => update({ ...draft, tableId })}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={t("facilityBreakfast.tablePlaceholder")}
                  />
                </SelectTrigger>
                <SelectContent>
                  {menu.tables.map((table) => (
                    <SelectItem key={table.id} value={table.id}>
                      {table.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          )}
        </Card>

        <Card data-testid="breakfast-summary">
          <h3 className="font-brand type-title">
            {t("facilityBreakfast.summaryTitle")}
          </h3>
          {lines.length === 0 && (
            <p className="text-sm leading-5 text-muted-foreground">
              {t("facilityBreakfast.noItems")}
            </p>
          )}
          <dl className="grid gap-2 text-sm leading-5">
            {lines.map((line) => (
              <div
                key={line.item.id}
                className="flex items-baseline justify-between gap-3"
              >
                <dt className="min-w-0">
                  {t("facilityBreakfast.orderedLine", {
                    quantity: line.quantity,
                    name: line.item.name,
                  })}
                </dt>
                <dd className="font-semibold tabular">
                  {formatRupiah(line.item.priceIdr * line.quantity)}
                </dd>
              </div>
            ))}
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">
                {t("facilityBreakfast.summaryPlace")}
              </dt>
              <dd className="font-semibold">
                {draft.mode === "pickup"
                  ? t("facilityBreakfast.summaryPickup")
                  : (tableLabel ?? t("facilityBreakfast.tablePlaceholder"))}
              </dd>
            </div>
            {fireTime && (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">
                  {t("facilityBreakfast.summaryFireAt")}
                </dt>
                <dd className="font-semibold tabular">{fireTime}</dd>
              </div>
            )}
            <div className="flex items-baseline justify-between gap-3 border-t-(length:--border-w) pt-2 text-base">
              <dt className="font-semibold">
                {t("facilityBreakfast.subtotal")}
              </dt>
              <dd
                className="font-semibold tabular"
                data-testid="breakfast-subtotal"
              >
                {formatRupiah(subtotal)}
              </dd>
            </div>
          </dl>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("facilityBreakfast.subtotalNote")}
          </p>
          <Button
            size="lg"
            loading={order.isPending}
            onClick={handleSubmit}
            data-testid="breakfast-submit"
          >
            {t("facilityBreakfast.submit")}
          </Button>
          {order.isError && <ApiFailure error={order.error} />}
          <p className="text-sm leading-5 text-muted-foreground">
            {t("facilityBreakfast.payFirstNote")}
          </p>
        </Card>
      </div>
    </div>
  );
}
