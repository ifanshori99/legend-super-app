import type { ReactNode } from "react";
import { cn } from "cn";
import {
  CircleAlert,
  Info,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

export type NoticeTone = "info" | "warning" | "danger";

const TONES: Record<NoticeTone, { box: string; icon: LucideIcon }> = {
  info: { box: "border-info bg-info-subtle text-info", icon: Info },
  warning: {
    box: "border-warning bg-warning-subtle text-warning",
    icon: TriangleAlert,
  },
  danger: {
    box: "border-danger bg-danger-subtle text-danger",
    icon: CircleAlert,
  },
};

// A message block with a thin tinted border: bold title, one sentence. The
// tone shows in the border, the tinted fill and the icon, never in color alone.
// Body text uses `foreground`: muted text is not contrast-checked on a tint.
export function Notice({
  tone,
  title,
  children,
  className,
  ...props
}: {
  tone: NoticeTone;
  title: string;
  children?: ReactNode;
  className?: string;
} & Omit<React.ComponentProps<"div">, "title" | "children">) {
  const { box, icon: Icon } = TONES[tone];
  return (
    <div
      data-slot="notice"
      data-tone={tone}
      role={tone === "danger" ? "alert" : undefined}
      className={cn(
        "rounded-control border-(length:--border-w) px-4 py-3",
        box,
        className,
      )}
      {...props}
    >
      <p className="flex items-center gap-2 text-(length:--density-text) leading-6 font-semibold">
        <Icon className="size-5 shrink-0" aria-hidden="true" />
        {title}
      </p>
      {children && (
        <div className="mt-1 text-base leading-6 text-foreground">
          {children}
        </div>
      )}
    </div>
  );
}
