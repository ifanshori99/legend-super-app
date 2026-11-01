// Renders a QR payload (QRIS) as inline SVG. Modules use the foreground token
// on a plate forced to the light theme, so the code stays dark-on-light in dark
// mode too: banking apps scan dark modules on a light ground.
import { useMemo } from "react";
import QRCode from "qrcode";
import { ThemeScope } from "@/components/theme-scope";

export function QrCodeImage({
  payload,
  label,
  className,
}: {
  payload: string;
  label: string;
  className?: string;
}) {
  const { size, path } = useMemo(() => {
    const { modules } = QRCode.create(payload, { errorCorrectionLevel: "M" });
    const size = modules.size;
    const parts: string[] = [];
    for (let y = 0; y < size; y += 1)
      for (let x = 0; x < size; x += 1)
        if (modules.get(x, y)) parts.push(`M${x} ${y}h1v1h-1z`);
    return { size, path: parts.join("") };
  }, [payload]);
  const quiet = 3;
  return (
    <ThemeScope
      mode="light"
      className={`rounded-xl border p-2 ${className ?? ""}`}
    >
      <svg
        role="img"
        aria-label={label}
        viewBox={`${-quiet} ${-quiet} ${size + quiet * 2} ${size + quiet * 2}`}
        shapeRendering="crispEdges"
        className="block size-full"
      >
        <path d={path} className="fill-foreground" />
      </svg>
    </ThemeScope>
  );
}
