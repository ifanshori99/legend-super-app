// High-contrast 6-digit PIN pad (PRD v1.7 §3 F6 "PIN Perangkat"): 56-64px
// targets, keyboard and touch, masked dots, shake on a wrong PIN. It owns only
// the digits; the parent verifies and bumps `clearSignal` / `shakeSignal`.
//
// The pad hands a full PIN over and empties itself at once, so the PIN does
// not linger in component state. Keys stay enabled while the parent checks a
// PIN (`pending`): digits typed meanwhile start the next try and are only
// sent once the check is over (legend-6ew: typing straight after a wrong PIN
// used to drop the first digits, so the sixth digit never submitted). Keys are
// never `disabled`: a focused key that turns disabled throws focus to <body>,
// so a locked pad uses aria-disabled and keeps the focus where it was.
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "cn";
import { Delete } from "lucide-react";
import { STAFF_PIN_LENGTH } from "@starter/shared/identity";
import { useT } from "@/components/i18n";
import {
  appendDigit,
  pinPadDots,
  readyToHandOver,
  removeLastDigit,
} from "../logic.ts";

const KEY_CLASS =
  "grid h-14 w-full place-items-center rounded-control border-(length:--border-w) border-border bg-card text-2xl font-semibold text-foreground shadow-hairline tabular pressable select-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-card sm:h-16";

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

export type PinPadProps = {
  onComplete: (pin: string) => void;
  /** Blocks input and empties the dots (locked). */
  disabled?: boolean;
  /** The parent is checking a PIN; typing continues, sending waits. */
  pending?: boolean;
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

/** Keys typed into a field, a combobox or an open list belong to that control. */
function ownsKeys(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable ||
    target.closest('[role="combobox"],[role="listbox"],[role="menu"]') !== null
  );
}

export function PinPad({
  onComplete,
  disabled = false,
  pending = false,
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

  // Empty the dots when the parent bumps clearSignal or locks the pad
  // (adjust during render).
  if (seenClear !== clearSignal) {
    setSeenClear(clearSignal);
    setPin("");
  } else if (disabled && pin !== "") {
    setPin("");
  }

  // Hand a full PIN over once nothing else is being checked, then forget it.
  const busy = disabled || pending;
  useEffect(() => {
    if (!readyToHandOver(pin, busy, STAFF_PIN_LENGTH)) return;
    completeRef.current(pin);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the hand-over is the external call; emptying the pad must follow it
    setPin("");
  }, [pin, busy]);

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
  const clear = useCallback(() => setPin(""), []);

  useEffect(() => {
    if (!active) return;
    function onKey(event: KeyboardEvent) {
      if (ownsKeys(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (/^\d$/.test(event.key)) {
        event.preventDefault();
        press(event.key);
      } else if (event.key === "Backspace") {
        event.preventDefault();
        back();
      } else if (event.key === "Escape") clear();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, press, back, clear]);

  const filled = pinPadDots(pin.length, pending, STAFF_PIN_LENGTH);
  const empty = pin.length === 0;

  return (
    <div
      data-slot="pin-pad"
      data-pending={pending || undefined}
      className={cn("mx-auto grid w-full max-w-xs gap-5", className)}
    >
      <div className="grid gap-2 text-center">
        {label && <p className="text-base font-semibold">{label}</p>}
        <div
          ref={dotsRef}
          role="img"
          aria-label={`${t("devicePin.pad.label")}. ${t("devicePin.pad.dots", {
            filled,
            total: STAFF_PIN_LENGTH,
          })}`}
          data-testid="pin-dots"
          className="flex justify-center gap-3"
        >
          {Array.from({ length: STAFF_PIN_LENGTH }, (_, index) => (
            <span
              key={index}
              data-filled={index < filled || undefined}
              className={cn(
                "size-4 rounded-full border-2 border-foreground transition-colors motion-reduce:transition-none",
                index < filled && "bg-foreground",
                error && "border-danger",
                error && index < filled && "bg-danger",
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
            aria-disabled={disabled || undefined}
            aria-label={t("devicePin.pad.digit", { digit })}
            onClick={() => press(digit)}
          >
            {digit}
          </button>
        ))}
        <button
          type="button"
          className={cn(KEY_CLASS, "text-base")}
          aria-disabled={disabled || empty || undefined}
          onClick={clear}
        >
          {t("devicePin.pad.clear")}
        </button>
        <button
          type="button"
          className={KEY_CLASS}
          aria-disabled={disabled || undefined}
          aria-label={t("devicePin.pad.digit", { digit: "0" })}
          onClick={() => press("0")}
        >
          0
        </button>
        <button
          type="button"
          className={KEY_CLASS}
          aria-disabled={disabled || empty || undefined}
          aria-label={t("devicePin.pad.backspace")}
          onClick={back}
        >
          <Delete className="size-6" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
