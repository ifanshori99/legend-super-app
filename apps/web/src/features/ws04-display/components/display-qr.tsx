// The QRIS plate of the customer display. Rendered on an always-light plate
// on purpose: a QR is a machine-readable artifact, so it keeps dark modules on
// a white ground in both color modes (a scanner cannot rely on inverted codes).
// `uqr` renders a pure SVG string, so this works during SSR and in the browser
// alike. Bead legend-9fmm (shared QrCode) replaces this call site at merge.
import { useMemo } from "react";
import { renderSVG } from "uqr";
import { ThemeScope } from "@/components/theme-scope";

export function DisplayQr({
  payload,
  label,
  className,
}: {
  /** EMVCo payload from the payment provider; never a secret. */
  payload: string;
  /** Accessible name, e.g. "Kode QRIS pembayaran Rp 120.100". */
  label: string;
  className?: string;
}) {
  const svg = useMemo(
    () =>
      renderSVG(payload, {
        ecc: "M",
        border: 2,
        pixelSize: 4,
        blackColor: "currentColor",
        whiteColor: "transparent",
      }),
    [payload],
  );
  return (
    <ThemeScope
      density="kontras"
      mode="light"
      className={`grid place-items-center rounded-xl border-(length:--border-w) bg-background p-3 ${className ?? ""}`}
    >
      <div
        role="img"
        aria-label={label}
        className="aspect-square w-full [&>svg]:size-full"
        // Our own generated SVG string, not user input.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </ThemeScope>
  );
}
