// StatusBand: the full-width header band an operations ticket carries its
// state in (DESIGN.md §5 Operations, owner Q25/Q26). The band *is* the status:
// "late" is the one solid fill, the other states are a status tint or the
// raised neutral, so a board of tickets never spends the accent budget.
//
// Text on a band uses the band's own role color or `foreground`; hint text
// (`muted-foreground`) is not contrast-checked on status tints, so do not use
// it there. The band sits at the top of a `rounded-container` card with
// `overflow-hidden`; its bottom hairline separates state from content.
import type { ReactNode } from "react";
import { cn } from "cn";
import type { LucideIcon } from "lucide-react";

export type StatusBandTone =
  "neutral" | "success" | "warning" | "danger" | "info";

const TONES: Record<StatusBandTone, string> = {
  neutral: "bg-surface-3 text-foreground",
  success: "bg-success-subtle text-success",
  warning: "bg-warning-subtle text-warning",
  danger: "bg-danger text-danger-foreground",
  info: "bg-info-subtle text-info",
};

function StatusBand({
  tone,
  icon: Icon,
  label,
  aside,
  children,
  className,
}: {
  tone: StatusBandTone;
  icon: LucideIcon;
  /** The state in words, always next to its icon (WCAG 1.4.1). */
  label: string;
  /** Optional context above the state, e.g. the order channel. */
  aside?: ReactNode;
  /** What the band identifies: the order code and elapsed time. */
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="status-band"
      data-tone={tone}
      className={cn(
        "flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b-(length:--border-w) px-4 py-3",
        TONES[tone],
        className,
      )}
    >
      <div className="min-w-0">{children}</div>
      <div className="flex flex-col items-end gap-1">
        {aside}
        <p className="inline-flex items-center gap-1.5 text-sm leading-5 font-semibold">
          <Icon className="size-4 shrink-0" aria-hidden="true" />
          {label}
        </p>
      </div>
    </div>
  );
}

export { StatusBand };
