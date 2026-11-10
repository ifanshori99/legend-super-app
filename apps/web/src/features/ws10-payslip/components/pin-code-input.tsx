// Six-box PIN field (bead legend-ilzrj). One real <input> sits invisibly over
// six decorative boxes, so assistive tech sees a single labelled field, paste
// and the numeric keypad work natively, and FormField can wire id / label /
// aria-describedby / aria-invalid onto it like any other control. The boxes are
// aria-hidden; digits show as dots (the PIN is never echoed on screen).
import * as React from "react";
import { cn } from "cn";
import { PAYSLIP_PIN_LENGTH, sanitizePinInput } from "../pin-state.ts";

type PinCodeInputProps = Omit<
  React.ComponentProps<"input">,
  "value" | "onChange" | "type" | "maxLength" | "inputMode"
> & {
  value: string;
  onChange: (value: string) => void;
  /** Fires once when the sixth digit is entered or pasted. */
  onComplete?: (value: string) => void;
};

function PinCodeInput({
  value,
  onChange,
  onComplete,
  disabled,
  className,
  onFocus,
  onBlur,
  autoComplete = "off",
  ...props
}: PinCodeInputProps) {
  const [focused, setFocused] = React.useState(false);
  const invalid =
    props["aria-invalid"] === true || props["aria-invalid"] === "true";
  const digits = sanitizePinInput(value);
  // The caret box: the next empty one, or the last once the PIN is full.
  const activeIndex = Math.min(digits.length, PAYSLIP_PIN_LENGTH - 1);

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const next = sanitizePinInput(event.target.value);
    onChange(next);
    if (next.length === PAYSLIP_PIN_LENGTH && digits.length !== next.length) {
      onComplete?.(next);
    }
  }

  return (
    <div
      data-slot="pin-code-input"
      className={cn("relative inline-flex gap-2", className)}
    >
      <input
        {...props}
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete={autoComplete}
        // No maxLength: a paste such as "123 456" must reach onChange whole and
        // be sanitized there instead of being cut mid-way by the browser.
        value={digits}
        disabled={disabled}
        onChange={handleChange}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
        className="absolute inset-0 z-10 size-full cursor-text opacity-0 disabled:cursor-not-allowed"
      />
      {Array.from({ length: PAYSLIP_PIN_LENGTH }, (_, index) => {
        const filled = index < digits.length;
        const active = focused && !disabled && index === activeIndex;
        return (
          <span
            key={index}
            aria-hidden="true"
            data-filled={filled || undefined}
            data-active={active || undefined}
            className={cn(
              "grid h-12 min-h-11 w-11 min-w-11 place-items-center rounded-field border-(length:--border-w) border-input bg-background text-xl font-bold text-foreground shadow-hairline transition-[border-color,box-shadow] duration-(--duration-fast)",
              active && "border-primary shadow-focus",
              invalid && "border-2 border-danger",
              disabled && "bg-muted opacity-60",
            )}
          >
            {filled ? "•" : ""}
          </span>
        );
      })}
    </div>
  );
}

export { PinCodeInput };
export type { PinCodeInputProps };
