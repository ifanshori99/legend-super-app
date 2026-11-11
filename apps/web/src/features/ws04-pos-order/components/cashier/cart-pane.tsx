import { useId, type ReactNode } from "react";
import { cn } from "cn";
import { ArrowLeft, Minus, Plus, Trash2 } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/money";
import { cartTotals, lineTotalIdr } from "@/features/ws04-pos-order/cart-logic";
import type {
  CartLine,
  OjolPlatform,
  SaleChannel,
} from "@/features/ws04-pos-order/types";
import {
  ChannelDetail,
  ChannelToggle,
  type ChannelDetailError,
} from "./channel-toggle";

/** What the cashier has chosen for the order itself, next to the lines. */
export interface CartOrderMeta {
  channel: SaleChannel;
  tableLabel: string | null;
  ojolPlatform: OjolPlatform | null;
  ojolRef: string;
}

export interface CartPaneProps {
  lines: CartLine[];
  meta: CartOrderMeta;
  onMetaChange: (patch: Partial<CartOrderMeta>) => void;
  fieldError: ChannelDetailError;
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
      {onBackToMenu && (
        <Button
          type="button"
          variant="ghost"
          onClick={onBackToMenu}
          className="-ml-2 self-start"
        >
          <ArrowLeft aria-hidden="true" />
          {t("posOrderCart.cart.backToMenu")}
        </Button>
      )}
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id={`${id}-title`} className="type-title">
            {t("posOrderCart.cart.title")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("posOrderCart.cart.subtitle")}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onOpenParked}
          className="shrink-0"
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
        onTableChange={(tableLabel) => onMetaChange({ tableLabel })}
        ojolPlatform={meta.ojolPlatform}
        onOjolPlatformChange={(ojolPlatform) => onMetaChange({ ojolPlatform })}
        ojolRef={meta.ojolRef}
        onOjolRefChange={(ojolRef) => onMetaChange({ ojolRef })}
        error={fieldError}
      />

      <div className="min-h-32 flex-1 overflow-y-auto">
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
                onSetQuantity={onSetQuantity}
                onToggleHold={onToggleHold}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="grid gap-2 border-t border-border pt-3">
        {feedback}
        <div className="flex items-baseline justify-between gap-3 text-xl font-semibold">
          <span>
            {t("posOrderCart.cart.subtotal", { count: totals.itemCount })}
          </span>
          <Money amount={totals.subtotalIdr} size="lg" />
        </div>
        <p className="text-sm text-muted-foreground">
          {t("posOrderCart.cart.review")}
        </p>
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
            className="h-auto min-h-control-lg whitespace-normal"
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
            className="h-auto min-h-control-lg whitespace-normal"
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
          className="w-full"
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
  onSetQuantity,
  onToggleHold,
}: {
  line: CartLine;
  onSetQuantity: (lineId: string, quantity: number) => void;
  onToggleHold: (lineId: string) => void;
}) {
  const t = useT();
  const details = [
    ...line.modifiers.map((modifier) => modifier.name),
    ...(line.note ? [t("posOrderCart.line.note", { note: line.note })] : []),
  ].join(" · ");
  const detailText =
    details || (line.hold ? "" : t("posOrderCart.line.sendNow"));
  const removing = line.quantity <= 1;

  return (
    <li className="border-t border-border py-3 first:border-t-0">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 font-semibold break-words">{line.name}</p>
        <Money amount={lineTotalIdr(line)} className="font-semibold" />
      </div>
      {detailText && (
        <p className="mt-0.5 text-sm break-words text-muted-foreground">
          {detailText}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
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
          onClick={() => onSetQuantity(line.lineId, line.quantity - 1)}
        >
          {removing ? (
            <Trash2 aria-hidden="true" />
          ) : (
            <Minus aria-hidden="true" />
          )}
        </Button>
        <span
          role="status"
          aria-label={t("posOrderCart.line.quantity")}
          className="min-w-8 text-center text-lg font-semibold tabular"
        >
          {line.quantity}
        </span>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={t("posOrderCart.line.increase", { name: line.name })}
          onClick={() => onSetQuantity(line.lineId, line.quantity + 1)}
        >
          <Plus aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant={line.hold ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={line.hold}
          aria-label={t(
            line.hold
              ? "posOrderCart.line.heldLabel"
              : "posOrderCart.line.holdLabel",
            { name: line.name },
          )}
          onClick={() => onToggleHold(line.lineId)}
          className="rounded-full"
        >
          {line.hold
            ? t("posOrderCart.line.held", { course: line.course.label })
            : t("posOrderCart.line.hold")}
        </Button>
      </div>
    </li>
  );
}
