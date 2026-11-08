import { Delete } from "lucide-react";
import { useT } from "@/components/i18n";

const KEY_CLASS =
  "h-control w-full rounded-control border-(length:--border-w) border-border bg-card text-2xl font-semibold text-foreground shadow-hairline tabular pressable select-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

// Digit pad for the customer code. Pure presentation: the screen owns the
// text. The amount keypad is whole-rupiah, so the code gets its own pad.
export function CodeKeypad({
  onDigit,
  onBackspace,
  onClear,
}: {
  onDigit: (digit: string) => void;
  onBackspace: () => void;
  onClear: () => void;
}) {
  const t = useT();
  return (
    <div
      role="group"
      aria-label={t("posKasirCode.keypad.label")}
      className="grid grid-cols-3 gap-2"
    >
      {DIGITS.map((digit) => (
        <button
          key={digit}
          type="button"
          className={KEY_CLASS}
          onClick={() => onDigit(digit)}
        >
          {digit}
        </button>
      ))}
      <button
        type="button"
        className={`${KEY_CLASS} text-lg`}
        onClick={onClear}
      >
        {t("posKasirCode.keypad.clear")}
      </button>
      <button type="button" className={KEY_CLASS} onClick={() => onDigit("0")}>
        0
      </button>
      <button
        type="button"
        className={KEY_CLASS}
        aria-label={t("posKasirCode.keypad.backspace")}
        onClick={onBackspace}
      >
        <Delete className="mx-auto size-6" aria-hidden="true" />
      </button>
    </div>
  );
}
