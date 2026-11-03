// High-contrast 6-digit PIN pad (PRD v1.7 §3 F6 "PIN Perangkat"): 56-64px
// targets, keyboard and touch, masked dots, shake on a wrong PIN. It owns only
// the digits; the parent verifies and bumps `clearSignal` / `shakeSignal`.
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "cn";
import { Delete } from "lucide-react";
import { STAFF_PIN_LENGTH } from "@starter/shared/identity";
import { useT } from "@/components/i18n";
import { appendDigit, removeLastDigit } from "../logic.ts";

const KEY_CLASS =
  "grid h-14 w-full place-items-center rounded-control border-(length:--border-w) border-border bg-card text-2xl font-semibold text-foreground shadow-hairline tabular pressable select-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 sm:h-16";

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

export type PinPadProps = {
  onComplete: (pin: string) => void;
  /** Blocks input (locked, or verifying). */
  disabled?: boolean;
  /** Listen to the physical keyboard while true. */
  active?: boolean;
  /** Bump to empty the dots. */
  clearSignal?: number;
  /** Bump to play the shake. */
  shakeSignal?: number;
  error?: string | null;
  status?: string | null;
  label?: string;
  className?: string;
};

export function PinPad({
  onComplete,
  disabled = false,
  active = true,
  clearSignal = 0,
  shakeSignal = 0,
  error,
  status,
  label,
  className,
}: PinPadProps) {
  const t = useT();
  const [pin, setPin] = useState("");
  const [seenClear, setSeenClear] = useState(clearSignal);
  const dotsRef = useRef<HTMLDivElement>(null);
  const completeRef = useRef(onComplete);
  useEffect(() => {
    completeRef.current = onComplete;
  });

  // Empty the dots when the parent bumps clearSignal (adjust during render).
  if (seenClear !== clearSignal) {
    setSeenClear(clearSignal);
    setPin("");
  }

  useEffect(() => {
    if (pin.length === STAFF_PIN_LENGTH) completeRef.current(pin);
  }, [pin]);

  useEffect(() => {
    if (shakeSignal === 0) return;
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduce) return;
    dotsRef.current?.animate(
      [
        { transform: "translateX(0)" },
        { transform: "translateX(-10px)" },
        { transform: "translateX(10px)" },
        { transform: "translateX(-6px)" },
        { transform: "translateX(6px)" },
        { transform: "translateX(0)" },
      ],
      { duration: 360, easing: "ease-in-out" },
    );
  }, [shakeSignal]);

  const press = useCallback(
    (digit: string) => {
      if (!disabled)
        setPin((current) => appendDigit(current, digit, STAFF_PIN_LENGTH));
    },
    [disabled],
  );
  const back = useCallback(() => {
    if (!disabled) setPin((current) => removeLastDigit(current));
  }, [disabled]);

  useEffect(() => {
    if (!active) return;
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      )
        return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (/^\d$/.test(event.key)) {
        event.preventDefault();
        press(event.key);
      } else if (event.key === "Backspace") {
        event.preventDefault();
        back();
      } else if (event.key === "Escape") setPin("");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, press, back]);

  return (
    <div
      data-slot="pin-pad"
      className={cn("mx-auto grid w-full max-w-xs gap-5", className)}
    >
      <div className="grid gap-2 text-center">
        {label && <p className="text-base font-semibold">{label}</p>}
        <div
          ref={dotsRef}
          role="img"
          aria-label={`${t("devicePin.pad.label")}. ${t("devicePin.pad.dots", {
            filled: pin.length,
            total: STAFF_PIN_LENGTH,
          })}`}
          data-testid="pin-dots"
          className="flex justify-center gap-3"
        >
          {Array.from({ length: STAFF_PIN_LENGTH }, (_, index) => (
            <span
              key={index}
              data-filled={index < pin.length || undefined}
              className={cn(
                "size-4 rounded-full border-2 border-foreground transition-colors",
                index < pin.length && "bg-foreground",
                error && "border-danger",
                error && index < pin.length && "bg-danger",
              )}
            />
          ))}
        </div>
        <p
          role={error ? "alert" : "status"}
          className={cn(
            "min-h-6 text-sm leading-6",
            error ? "font-semibold text-danger" : "text-muted-foreground",
          )}
        >
          {error ?? status ?? t("devicePin.pad.hint")}
        </p>
        {error && status && (
          <p role="status" className="text-sm leading-6 text-muted-foreground">
            {status}
          </p>
        )}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {DIGITS.map((digit) => (
          <button
            key={digit}
            type="button"
            className={KEY_CLASS}
            disabled={disabled}
            aria-label={t("devicePin.pad.digit", { digit })}
            onClick={() => press(digit)}
          >
            {digit}
          </button>
        ))}
        <button
          type="button"
          className={cn(KEY_CLASS, "text-base")}
          disabled={disabled || pin.length === 0}
          onClick={() => setPin("")}
        >
          {t("devicePin.pad.clear")}
        </button>
        <button
          type="button"
          className={KEY_CLASS}
          disabled={disabled}
          aria-label={t("devicePin.pad.digit", { digit: "0" })}
          onClick={() => press("0")}
        >
          0
        </button>
        <button
          type="button"
          className={KEY_CLASS}
          disabled={disabled || pin.length === 0}
          aria-label={t("devicePin.pad.backspace")}
          onClick={back}
        >
          <Delete className="size-6" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
