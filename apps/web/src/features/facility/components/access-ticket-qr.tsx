// The QR half of the access ticket. Rendered on an always-light plate on
// purpose: a QR code is a machine-readable artifact, so it keeps dark modules
// on a white background in both color modes (a scanner cannot rely on inverted
// codes). The SVG comes from `uqr`, a pure string renderer, so it works during
// SSR and in the browser alike.
import { useMemo } from "react";
import { cn } from "cn";
import { renderSVG } from "uqr";
import { ThemeScope } from "@/components/theme-scope";

export function AccessTicketQr({
  value,
  label,
  className,
}: {
  /** The ticket's QR token (secret: shown only on the phone that bought it). */
  value: string;
  /** Accessible name of the code, e.g. "QR tiket bilik P1". */
  label: string;
  className?: string;
}) {
  const svg = useMemo(
    () =>
      renderSVG(value, {
        ecc: "M",
        border: 2,
        pixelSize: 4,
        blackColor: "currentColor",
        whiteColor: "transparent",
      }),
    [value],
  );
  return (
    <ThemeScope
      density="hangat"
      mode="light"
      className={cn(
        "grid place-items-center rounded-xl border-(length:--border-w) p-3",
        className,
      )}
    >
      <div
        role="img"
        aria-label={label}
        className="size-40 [&>svg]:size-full sm:size-48"
        // Our own generated SVG string, not user input.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </ThemeScope>
  );
}
