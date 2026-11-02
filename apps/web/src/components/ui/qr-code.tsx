// The one QR renderer for the web app (bead legend-9fmm). A code is a
// machine-readable artifact, so it always sits on an always-light plate with
// dark modules, in both color modes: scanners cannot rely on inverted codes
// (DESIGN §2, "color carries meaning"; no raw colors — `ThemeScope` supplies
// the light tokens). `uqr` encodes, the modules become one SVG path.
import { useMemo } from "react";
import { cn } from "cn";
import type { Density } from "@starter/shared/theme";
import { ThemeScope } from "@/components/theme-scope";
import { qrModulePath, type QrLevel } from "@/lib/qr";

export function QrCode({
  value,
  label,
  size = 160,
  margin = 2,
  level = "M",
  density,
  className,
  svgClassName,
}: {
  /** What the code encodes: a QRIS payload, a signed table URL, a ticket token. */
  value: string;
  /** Accessible name, rendered as the SVG `<title>`. */
  label: string;
  /** Width and height in px; a CSS size class can still resize it. */
  size?: number;
  /** Quiet zone in modules. 2 is the minimum for a printed label. */
  margin?: number;
  /** Error correction level; M survives a smudged label or a phone glare. */
  level?: QrLevel;
  /** Density of the plate; defaults to the surrounding scope. */
  density?: Density;
  /** Plate classes: padding, border, rounding, size. */
  className?: string;
  /** SVG classes for screens that size the code with a utility. */
  svgClassName?: string;
}) {
  const { size: modules, path } = useMemo(
    () => qrModulePath(value, { level, margin }),
    [value, level, margin],
  );
  return (
    <ThemeScope
      mode="light"
      density={density}
      className={cn("inline-block shrink-0 align-top", className)}
    >
      <svg
        role="img"
        width={size}
        height={size}
        viewBox={`0 0 ${modules} ${modules}`}
        shapeRendering="crispEdges"
        className={cn("block", svgClassName)}
      >
        <title>{label}</title>
        <path d={path} fill="currentColor" />
      </svg>
    </ThemeScope>
  );
}
