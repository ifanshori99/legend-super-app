import { useId, type ReactNode } from "react";
import { cn } from "cn";
import { ArrowLeft, Minus, Plus, Trash2 } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/money";
import { cartTotals, lineTotalIdr } from "@/features/ws04-pos-order/cart-logic";
import type { CartLine, OrderMeta } from "@/features/ws04-pos-order/types";
import {
  ChannelDetail,
  ChannelToggle,
  type ChannelDetailError,
} from "./channel-toggle";

/** What the cashier has chosen for the order itself, next to the lines. */
export type CartOrderMeta = OrderMeta;

export interface CartPaneProps {
  lines: CartLine[];
  meta: CartOrderMeta;
  onMetaChange: (patch: Partial<CartOrderMeta>) => void;
  fieldError: ChannelDetailError;
  /** Changes on every failed "Lanjutkan", so the same error focuses again. */
  fieldErrorToken: number;
  onSetQuantity: (lineId: string, quantity: number) => void;
  onToggleHold: (lineId: string) => void;
  onPark: () => void;
  onFireHeld: () => void;
  onContinue: () => void;
  onOpenParked: () => void;
  /** Phones only: the cart is its own view, so it needs a way back to the menu. */
  onBackToMenu?: () => void;
  /** Status and error notices, shown right above the totals. */
  feedback?: ReactNode;
  parking: boolean;
  submitting: boolean;
  className?: string;
}

// The cart: order type, table / call number / platform, the lines with quantity
// and hold controls, the subtotal and the three actions. State lives in the
// screen; this component only renders and reports.
export function CartPane({
  lines,
  meta,
  onMetaChange,
  fieldError,
  fieldErrorToken,
  onSetQuantity,
  onToggleHold,
  onPark,
  onFireHeld,
  onContinue,
  onOpenParked,
  onBackToMenu,
  feedback,
  parking,
  submitting,
  className,
}: CartPaneProps) {
  const t = useT();
  const id = useId();
  const emptyHintId = `${id}-empty`;
  const heldHintId = `${id}-held`;
  const totals = cartTotals(lines);
  const isEmpty = lines.length === 0;
  const noHeld = totals.heldCount === 0;
  const busy = parking || submitting;

  return (
    <section
      data-slot="cart-pane"
      aria-labelledby={`${id}-title`}
      className={cn(
        "flex min-h-0 flex-col gap-2 rounded-container border-(length:--border-w) border-border bg-card p-card",
        className,
      )}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          {onBackToMenu && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("posOrderCart.cart.backToMenu")}
              onClick={onBackToMenu}
              className="-ml-2 shrink-0"
            >
              <ArrowLeft aria-hidden="true" />
            </Button>
          )}
          <div className="min-w-0">
            <h2 id={`${id}-title`} className="type-title font-extrabold">
              {t("posOrderCart.cart.title")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("posOrderCart.cart.subtitle")}
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onOpenParked}
          className="shrink-0 font-bold"
        >
          {t("posOrderCart.cart.parked")}
        </Button>
      </header>

      <ChannelToggle
        value={meta.channel}
        onChange={(channel) => onMetaChange({ channel })}
      />
      <ChannelDetail
        channel={meta.channel}
        tableLabel={meta.tableLabel}
        onTableChange={({ label, sessionId }) =>
          onMetaChange({ tableLabel: label, tableSessionId: sessionId })
        }
        ojolPlatform={meta.ojolPlatform}
        onOjolPlatformChange={(ojolPlatform) => onMetaChange({ ojolPlatform })}
        ojolRef={meta.ojolRef}
        onOjolRefChange={(ojolRef) => onMetaChange({ ojolRef })}
        error={fieldError}
        focusToken={fieldErrorToken}
      />

      <div className="min-h-40 flex-1 overflow-y-auto max-[700px]:max-h-[50dvh]">
        {isEmpty ? (
          <div className="grid gap-1 px-2 py-6 text-center">
            <p className="text-lg leading-7 font-semibold">
              {t("posOrderCart.cart.emptyTitle")}
            </p>
            <p className="text-base text-muted-foreground">
              {t("posOrderCart.cart.emptyDescription")}
            </p>
          </div>
        ) : (
          <ul>
            {lines.map((line) => (
              <CartLineRow
                key={line.lineId}
                line={line}
                locked={busy}
                onSetQuantity={onSetQuantity}
                onToggleHold={onToggleHold}
              />
            ))}
          </ul>
        )}
      </div>

      {/* Always below the list: the list scrolls on its own, on a phone too. */}
      <div className="grid shrink-0 gap-2 border-t border-border bg-card pt-3">
        {feedback}
        {/* The one live region for the total; line rows announce nothing. */}
        <div
          role="status"
          className="flex items-baseline justify-between gap-3 text-xl font-semibold"
        >
          <span>
            {t("posOrderCart.cart.subtotal", { count: totals.itemCount })}
          </span>
          <Money amount={totals.subtotalIdr} size="lg" />
        </div>
        <span id={emptyHintId} className="sr-only">
          {t("posOrderCart.cart.hintEmpty")}
        </span>
        <span id={heldHintId} className="sr-only">
          {t("posOrderCart.cart.hintNoHeld")}
        </span>
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant="outline"
            size="lg"
            loading={parking}
            aria-disabled={isEmpty || busy ? true : undefined}
            aria-describedby={isEmpty ? emptyHintId : undefined}
            onClick={isEmpty || busy ? undefined : onPark}
            className="h-auto min-h-control px-3 font-bold whitespace-normal"
          >
            {t("posOrderCart.cart.park")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="lg"
            aria-disabled={noHeld || busy ? true : undefined}
            aria-describedby={noHeld ? heldHintId : undefined}
            onClick={noHeld || busy ? undefined : onFireHeld}
            className="h-auto min-h-control px-3 font-bold whitespace-normal"
          >
            {t("posOrderCart.cart.fireHeld")}
          </Button>
        </div>
        <Button
          type="button"
          size="lg"
          loading={submitting}
          aria-disabled={isEmpty || busy ? true : undefined}
          aria-describedby={isEmpty ? emptyHintId : undefined}
          onClick={isEmpty || busy ? undefined : onContinue}
          className="w-full font-bold"
        >
          {submitting
            ? t("posOrderCart.cart.submitting")
            : t("posOrderCart.cart.continue")}
        </Button>
      </div>
    </section>
  );
}

function CartLineRow({
  line,
  locked,
  onSetQuantity,
  onToggleHold,
}: {
  line: CartLine;
  /** A submit is in flight: the lines must not change under it. */
  locked: boolean;
  onSetQuantity: (lineId: string, quantity: number) => void;
  onToggleHold: (lineId: string) => void;
}) {
  const t = useT();
  const details = [
    ...line.modifiers.map((modifier) => modifier.name),
    ...(line.note ? [t("posOrderCart.line.note", { note: line.note })] : []),
  ].join(" · ");
  // No details to show: the "send now" note rides on the controls row instead
  // of taking a line of its own.
  const sendNow = !details && !line.hold;
  const removing = line.quantity <= 1;

  return (
    <li
      data-line-id={line.lineId}
      className="border-t border-border py-2 first:border-t-0"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 font-bold break-words">{line.name}</p>
        <Money amount={lineTotalIdr(line)} className="font-bold" />
      </div>
      {details && (
        <p className="mt-0.5 text-sm break-words text-muted-foreground">
          {details}
        </p>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={t(
            removing
              ? "posOrderCart.line.remove"
              : "posOrderCart.line.decrease",
            { name: line.name },
          )}
          aria-disabled={locked ? true : undefined}
          data-line-focus={line.lineId}
          onClick={() =>
            locked ? undefined : onSetQuantity(line.lineId, line.quantity - 1)
          }
          className="size-12"
        >
          {removing ? (
            <Trash2 aria-hidden="true" />
          ) : (
            <Minus aria-hidden="true" />
          )}
        </Button>
        <span className="min-w-8 text-center text-lg font-semibold tabular">
          <span className="sr-only">{t("posOrderCart.line.quantity")} </span>
          {line.quantity}
        </span>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={t("posOrderCart.line.increase", { name: line.name })}
          aria-disabled={locked ? true : undefined}
          onClick={() =>
            locked ? undefined : onSetQuantity(line.lineId, line.quantity + 1)
          }
          className="size-12"
        >
          <Plus aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={line.hold}
          aria-label={t("posOrderCart.line.holdLabel", { name: line.name })}
          aria-disabled={locked ? true : undefined}
          onClick={() => (locked ? undefined : onToggleHold(line.lineId))}
          className={cn(
            "rounded-full font-bold",
            line.hold
              ? "bg-secondary px-3 text-foreground not-aria-disabled:hover:bg-secondary"
              : "px-3 text-muted-foreground",
          )}
        >
          {t("posOrderCart.line.hold")}
        </Button>
        {line.hold && (
          <span className="min-w-0 text-sm font-semibold break-words text-muted-foreground">
            {line.course.label}
          </span>
        )}
        {sendNow && (
          <span className="min-w-0 text-sm text-muted-foreground">
            {t("posOrderCart.line.sendNow")}
          </span>
        )}
      </div>
    </li>
  );
}
