import { useId } from "react";
import { cn } from "cn";
import { formatRupiah } from "@starter/shared/i18n";
import { Money } from "@/components/ui/money";
import { parseDigits } from "./keypad-logic";

const FIELD_CLASS =
  "h-12 w-full min-w-0 rounded-control border-(length:--border-w) border-input bg-background px-3 text-right text-xl font-bold text-foreground tabular shadow-hairline focus-visible:border-primary focus-visible:shadow-focus focus-visible:outline-none";

const MAX_QUANTITY = 9999;

function Cell({
  label,
  unit,
  value,
  onChange,
  footer,
}: {
  label: string;
  /** Sheet or piece, read as part of the field name ("Rp100 · keping"). */
  unit?: string;
  value: string;
  onChange: (text: string) => void;
  footer: React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="grid min-w-0 flex-[1_1_8rem] content-start gap-1.5 rounded-container border-(length:--border-w) border-border bg-surface-2 p-2.5">
      <label
        htmlFor={id}
        className="text-base leading-6 font-semibold whitespace-nowrap tabular"
      >
        {label}
        {unit && (
          // The group legend already says sheets or coins; keep the unit for
          // screen readers only so every label stays on one line.
          <span className="sr-only"> · {unit}</span>
        )}
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

// The blind count: one field per denomination (how many notes or coins) and a
// subtotal under each. The screen renders one group for notes and one for
// small coins. Cells wrap and stretch, so a group never ends on a half row
// with a hole. It never shows a system balance. Controlled; the parent owns
// the numbers.
export function DenominationCounter({
  denominations,
  quantities,
  onQuantityChange,
  unitLabel,
  className,
}: {
  /** Denominations in rupiah, highest first. */
  denominations: readonly number[];
  /** Count per denomination; a missing entry counts as 0. */
  quantities: Readonly<Record<number, number>>;
  onQuantityChange: (denominationIdr: number, quantity: number) => void;
  /** Unit word per denomination (sheet or piece), shown next to the amount. */
  unitLabel?: (denominationIdr: number) => string;
  className?: string;
}) {
  return (
    <div
      data-slot="denomination-counter"
      className={cn("flex flex-wrap gap-3", className)}
    >
      {denominations.map((denomination) => {
        const quantity = quantities[denomination] ?? 0;
        return (
          <Cell
            key={denomination}
            label={formatRupiah(denomination)}
            unit={unitLabel?.(denomination)}
            value={String(quantity)}
            onChange={(text) =>
              onQuantityChange(denomination, parseDigits(text, MAX_QUANTITY))
            }
            footer={<Money amount={denomination * quantity} />}
          />
        );
      })}
    </div>
  );
}
