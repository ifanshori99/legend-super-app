// Shared building blocks of the QR "final arah A + liquid glass" theme
// (legend-2re1, design/mockups/README.md, founder Q3–Q6). Glass is only for
// floating layers: the page nav (QrTopBar), the action footer (QrFooter) and
// the menu header / cart bar built from the same utilities. Content stays on
// solid paper (`qr-paper`). Max two blur regions per screen: one on top, one
// at the bottom. On desktop (lg) the frame header is the top glass, so the
// page nav turns into a plain page title.
import {
  useLayoutEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Minus, Plus } from "lucide-react";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { API_MOCK } from "@/lib/api/mock-flag";
import { QrFrameNotices } from "./qr-frame-notices";

/** Round 44px icon control on glass or paper (close, back, search, add). */
export const qrRoundIcon =
  "inline-grid size-11 shrink-0 place-items-center rounded-full bg-card text-foreground shadow-raised pressable hover:bg-qr-selection focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 [&_svg]:size-5";

/** Underlined text action (Ubah, Lihat pilihan, Ganti metode bayar). */
export const qrTextLink =
  "inline-flex min-h-6 items-center rounded-xs font-semibold underline decoration-1 underline-offset-4 hover:decoration-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * Page nav: a floating glass bar with a leading control (back / close), the
 * centered page title (the page's h1) and an optional trailing control. From
 * lg up it is a plain title row; the frame header carries the glass there.
 */
/**
 * "Contoh data" while the mock API serves fixtures (owner Q24): every screen
 * that shows sample data says so. The menu header and the desktop frame
 * header render their own; this one sits under the mobile page nav.
 */
export function QrSampleBadge({ className }: { className?: string }) {
  const t = useT();
  if (!API_MOCK) return null;
  return (
    <Badge tone="neutral" className={className}>
      {t("common.sampleData")}
    </Badge>
  );
}

export function QrTopBar({
  title,
  leading,
  trailing,
  className,
}: {
  title: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <>
      <div
        className={cn(
          "sticky top-3 z-30 -mx-1 grid min-h-14 grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-center gap-2 rounded-qr-float px-2 py-1.5",
          "max-lg:qr-glass",
          "lg:static lg:mx-0 lg:grid-cols-[auto_1fr_auto] lg:px-0 lg:pt-2",
          className,
        )}
      >
        {/* On the glass the back / close control is a bare icon with a 44px
            hit area (mockup), not a paper circle. */}
        <div className="flex justify-start max-lg:[&>*]:bg-transparent max-lg:[&>*]:shadow-none">
          {leading}
        </div>
        <h1 className="min-w-0 truncate text-center type-heading font-bold tracking-[-0.019em] lg:text-left lg:type-display-xl">
          {title}
        </h1>
        <div className="flex justify-end">{trailing}</div>
      </div>
      <QrSampleBadge className="justify-self-start lg:hidden" />
      <QrFrameNotices />
    </>
  );
}

/**
 * Lifts the app toasts (components/ui/toast.tsx reads --toast-inset-bottom
 * on <html>) above the floating bottom bars, so a "masuk keranjang" toast
 * never covers the cart bar or the pay button. Several bars can be mounted at
 * once (the page cart bar under an item sheet footer), so every bar registers
 * here and the inset follows the tallest visible one; it is removed only when
 * the last bar unmounts. A hidden bar (display:none on lg) counts as zero.
 */
const toastInsetBars = new Set<HTMLElement>();
let toastInsetObserver: ResizeObserver | null = null;

function applyToastInset() {
  const root = document.documentElement;
  let tallest = 0;
  for (const bar of toastInsetBars)
    if (bar.offsetParent !== null)
      tallest = Math.max(tallest, Math.ceil(bar.offsetHeight));
  // bottom-3 (12px) gap under the bar; the toast viewport adds its own.
  if (tallest > 0)
    root.style.setProperty("--toast-inset-bottom", `${tallest + 12}px`);
  else root.style.removeProperty("--toast-inset-bottom");
}

export function useQrToastInset() {
  const [element, setElement] = useState<HTMLElement | null>(null);
  // Layout effect: the inset is in place before a toast fired in the same
  // commit (first add mounts the cart bar and the toast together) paints.
  useLayoutEffect(() => {
    if (!element) return;
    toastInsetObserver ??= new ResizeObserver(applyToastInset);
    if (toastInsetBars.size === 0)
      window.addEventListener("resize", applyToastInset);
    toastInsetBars.add(element);
    toastInsetObserver.observe(element);
    applyToastInset();
    return () => {
      toastInsetBars.delete(element);
      toastInsetObserver?.unobserve(element);
      if (toastInsetBars.size === 0)
        window.removeEventListener("resize", applyToastInset);
      applyToastInset();
    };
  }, [element]);
  return setElement;
}

/**
 * Action footer: a floating glass card that sticks to the bottom of the
 * viewport while its page is on screen (no spacer needed, it stays in flow).
 */
export function QrFooter({
  children,
  className,
  ...rest
}: ComponentProps<"div">) {
  const insetRef = useQrToastInset();
  return (
    <div
      {...rest}
      ref={insetRef}
      className={cn(
        "qr-glass sticky bottom-3 z-30 -mx-1 grid gap-3 rounded-qr-float p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Pill stepper with two 44px round buttons. `tone="paper"` sits on photos and
 * paper (menu card, footer); `tone="dark"` on the coffee nota (desktop cart).
 */
export function QrStepper({
  value,
  min = 0,
  max = 99,
  onChange,
  decreaseLabel,
  increaseLabel,
  valueLabel,
  disabled = false,
  busy = false,
  tone = "paper",
  className,
}: {
  value: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
  decreaseLabel: string;
  increaseLabel: string;
  /** Spoken value, e.g. "2 tamu"; defaults to the number. */
  valueLabel?: string;
  disabled?: boolean;
  busy?: boolean;
  tone?: "paper" | "outline" | "dark";
  className?: string;
}) {
  const button = cn(
    "inline-grid size-11 place-items-center rounded-full pressable disabled:opacity-40 aria-disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&_svg]:size-5",
    tone === "dark"
      ? "bg-qr-coffee-control text-qr-on-dark hover:bg-qr-coffee-panel"
      : "text-foreground hover:bg-qr-selection",
  );
  return (
    <div
      role="group"
      aria-busy={busy || undefined}
      className={cn(
        "inline-flex items-center gap-1 rounded-full",
        tone === "paper" && "bg-card p-0.5 shadow-raised",
        tone === "outline" && "border border-input bg-card p-0.5",
        className,
      )}
    >
      <button
        type="button"
        className={button}
        disabled={disabled || value <= min}
        aria-disabled={busy || undefined}
        onClick={() => {
          if (!busy) onChange(Math.max(min, value - 1));
        }}
      >
        <Minus aria-hidden="true" />
        <span className="sr-only">{decreaseLabel}</span>
      </button>
      <output
        aria-live="polite"
        aria-label={valueLabel}
        className="min-w-8 text-center text-lg font-semibold tabular"
      >
        {value}
      </output>
      <button
        type="button"
        className={button}
        disabled={disabled || value >= max}
        aria-disabled={busy || undefined}
        onClick={() => {
          if (!busy) onChange(Math.min(max, value + 1));
        }}
      >
        <Plus aria-hidden="true" />
        <span className="sr-only">{increaseLabel}</span>
      </button>
    </div>
  );
}

/**
 * The photo band behind the top glass: the material needs something real
 * behind it. It uses one of the outlet's own menu photos (no stock art); a
 * missing photo leaves the warm canvas. Decorative, hidden from assistive tech.
 */
export function QrPhotoBand({
  src,
  size = "menu",
  className,
}: {
  src: string | null | undefined;
  /** "menu" sits behind the tall menu header; "page" behind the slim nav. */
  size?: "menu" | "page";
  className?: string;
}) {
  if (!src) return null;
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-x-0 top-0 -z-10 overflow-hidden lg:h-28",
        size === "menu" ? "h-37" : "h-20",
        className,
      )}
    >
      <img
        src={src}
        alt=""
        decoding="async"
        fetchPriority="low"
        className="size-full object-cover"
      />
    </div>
  );
}
