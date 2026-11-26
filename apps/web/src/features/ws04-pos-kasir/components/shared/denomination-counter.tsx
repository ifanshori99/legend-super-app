import { useId } from "react";
import { cn } from "cn";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Money } from "@/components/ui/money";
import { parseDigits } from "./keypad-logic";

const FIELD_CLASS =
  "h-16 w-full min-w-0 rounded-control border-(length:--border-w) border-input bg-background px-4 text-right text-2xl font-bold text-foreground tabular shadow-hairline focus-visible:border-primary focus-visible:shadow-focus focus-visible:outline-none";

const MAX_QUANTITY = 9999;

function Cell({
  label,
  value,
  onChange,
  footer,
}: {
  label: string;
  value: string;
  onChange: (text: string) => void;
  footer: React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="grid content-start gap-2 rounded-container border-(length:--border-w) border-border bg-surface-2 p-3">
      <label htmlFor={id} className="text-base leading-6 font-semibold tabular">
        {label}
      </label>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        className={FIELD_CLASS}
      />
      <div className="text-base text-muted-foreground tabular">{footer}</div>
    </div>
  );
}

// The blind count: one field per denomination (how many notes), a subtotal
// under each, and one field for the lump sum of other notes and coins. It
// never shows a system balance. Controlled; the parent owns the numbers.
export function DenominationCounter({
  denominations,
  quantities,
  onQuantityChange,
  otherIdr = 0,
  onOtherChange,
  className,
}: {
  /** Denominations in rupiah, highest first. */
  denominations: readonly number[];
  /** Count per denomination; a missing entry counts as 0. */
  quantities: Readonly<Record<number, number>>;
  onQuantityChange: (denominationIdr: number, quantity: number) => void;
  /** Lump sum of small notes and coins, whole rupiah. */
  otherIdr?: number;
  /** Omitted when every denomination is listed (the real count has no lump sum). */
  onOtherChange?: (amountIdr: number) => void;
  className?: string;
}) {
  const t = useT();
  return (
    <div
      data-slot="denomination-counter"
      className={cn("grid gap-3 sm:grid-cols-2 lg:grid-cols-3", className)}
    >
      {denominations.map((denomination) => {
        const quantity = quantities[denomination] ?? 0;
        return (
          <Cell
            key={denomination}
            label={formatRupiah(denomination)}
            value={String(quantity)}
            onChange={(text) =>
              onQuantityChange(denomination, parseDigits(text, MAX_QUANTITY))
            }
            footer={<Money amount={denomination * quantity} />}
          />
        );
      })}
      {onOtherChange && (
        <Cell
          label={t("posKasirCommon.denomination.other")}
          value={formatRupiah(otherIdr)}
          onChange={(text) => onOtherChange(parseDigits(text))}
          footer={t("posKasirCommon.denomination.otherHint")}
        />
      )}
    </div>
  );
}
