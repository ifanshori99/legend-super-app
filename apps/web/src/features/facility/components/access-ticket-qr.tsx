// The QR half of the access ticket, drawn by the shared `QrCode` renderer
// (bead legend-9fmm). It sits on an always-light plate on purpose: a QR code is
// a machine-readable artifact, so it keeps dark modules on a white background
// in both color modes (a scanner cannot rely on inverted codes). The shared
// renderer is pure, so the ticket renders during SSR and in the browser alike.
import { cn } from "cn";
import { QrCode } from "@/components/ui/qr-code";

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
  return (
    <QrCode
      value={value}
      label={label}
      density="hangat"
      svgClassName="size-40 sm:size-48"
      className={cn(
        "grid place-items-center rounded-xl border-(length:--border-w) p-3",
        className,
      )}
    />
  );
}
