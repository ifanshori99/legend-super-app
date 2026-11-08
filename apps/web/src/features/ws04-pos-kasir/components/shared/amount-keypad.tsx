import { useId } from "react";
import { cn } from "cn";
import { Delete } from "lucide-react";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  KEYPAD_MAX_IDR,
  parseDigits,
  pressKeypadKey,
  type KeypadKey,
} from "./keypad-logic";

const KEY_CLASS =
  "h-control w-full rounded-control border-(length:--border-w) border-border bg-card text-2xl font-semibold text-foreground shadow-hairline tabular pressable select-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const ROWS: readonly (readonly KeypadKey[])[] = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
  ["000", "0", "back"],
];

// A large amount field with a touch keypad under it (whole rupiah). The field
// is a real input (`inputmode="numeric"`) so a hardware keyboard works too;
// its label stays visible. Controlled: the parent owns the amount.
export function AmountKeypad({
  value,
  onChange,
  label,
  hint,
  quickAmounts,
  max = KEYPAD_MAX_IDR,
  className,
}: {
  /** Whole rupiah. */
  value: number;
  onChange: (value: number) => void;
  /** Visible label above the field. */
  label: string;
  /** Under the keypad, e.g. "Nominal yang dialokasikan ke tagihan." */
  hint?: string;
  /** Quick-pick buttons (exact, round-up), whole rupiah. */
  quickAmounts?: readonly number[];
  max?: number;
  className?: string;
}) {
  const t = useT();
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  return (
    <div data-slot="amount-keypad" className={cn("grid gap-3", className)}>
      <div className="grid gap-1.5">
        <label htmlFor={inputId} className="text-base leading-6 font-semibold">
          {label}
        </label>
        <input
          id={inputId}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={formatRupiah(value)}
          onChange={(event) => onChange(parseDigits(event.target.value, max))}
          onFocus={(event) => event.currentTarget.select()}
          aria-describedby={hint ? hintId : undefined}
          className="h-16 w-full min-w-0 rounded-control border-(length:--border-w) border-input bg-background px-4 text-3xl font-bold text-foreground tabular shadow-hairline focus-visible:border-primary focus-visible:shadow-focus focus-visible:outline-none"
        />
      </div>
      {quickAmounts && quickAmounts.length > 0 && (
        <div
          role="group"
          aria-label={t("posKasirCommon.keypad.quickAmounts")}
          className="flex flex-wrap gap-2"
        >
          {quickAmounts.map((amount) => (
            <Button
              key={amount}
              type="button"
              variant="outline"
              size="sm"
              className="tabular"
              onClick={() => onChange(Math.min(amount, max))}
            >
              {formatRupiah(amount)}
            </Button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-3 gap-2">
        {ROWS.flat().map((key) => (
          <button
            key={key}
            type="button"
            className={KEY_CLASS}
            aria-label={
              key === "back" ? t("posKasirCommon.keypad.backspace") : undefined
            }
            onClick={() => onChange(pressKeypadKey(value, key, max))}
          >
            {key === "back" ? (
              <Delete className="mx-auto size-6" aria-hidden="true" />
            ) : (
              key
            )}
          </button>
        ))}
      </div>
      {hint && (
        <p id={hintId} className="text-base text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}
