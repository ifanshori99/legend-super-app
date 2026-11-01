// Quantity / guest-count stepper: two 44px buttons around a live value.
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

export function Stepper({
  value,
  min,
  max,
  onChange,
  decreaseLabel,
  increaseLabel,
  valueLabel,
  disabled = false,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  decreaseLabel: string;
  increaseLabel: string;
  /** Spoken value, e.g. "3 tamu"; defaults to the number. */
  valueLabel?: string;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex items-center gap-1" role="group">
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        disabled={disabled || value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
      >
        <Minus aria-hidden="true" />
        <span className="sr-only">{decreaseLabel}</span>
      </Button>
      <output
        aria-live="polite"
        aria-label={valueLabel}
        className="min-w-10 text-center text-lg font-semibold tabular"
      >
        {value}
      </output>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        disabled={disabled || value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        <Plus aria-hidden="true" />
        <span className="sr-only">{increaseLabel}</span>
      </Button>
    </div>
  );
}
