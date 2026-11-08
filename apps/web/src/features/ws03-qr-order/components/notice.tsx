// An inline message that stays on the page (session waiting for the waiter,
// sold-out items removed, zone closed). Q6 status pairs: subtle fill, ink
// text, an icon and, for warning and danger, a 3px left rule, so status is
// never color alone (DESIGN.md §8). Not an error boundary: use ErrorState for
// failed loads.
import type { ReactNode } from "react";
import { cn } from "cn";
import { CircleAlert, Clock, Info, TriangleAlert } from "lucide-react";

const TONES = {
  info: {
    icon: Info,
    box: "bg-surface-2",
    iconClass: "text-muted-foreground",
  },
  warning: {
    icon: TriangleAlert,
    box: "border-l-[3px] border-warning bg-warning-subtle",
    iconClass: "text-warning",
  },
  danger: {
    icon: CircleAlert,
    box: "border-l-[3px] border-danger bg-danger-subtle",
    iconClass: "text-danger",
  },
  waiting: {
    icon: Clock,
    box: "bg-surface-2",
    iconClass: "text-muted-foreground",
  },
} as const;

export function Notice({
  tone = "info",
  title,
  children,
  action,
  className,
}: {
  tone?: keyof typeof TONES;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const { icon: Icon, box, iconClass } = TONES[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "flex gap-3 rounded-qr-media p-3 text-foreground",
        box,
        className,
      )}
    >
      <Icon
        className={cn("mt-0.5 size-5 shrink-0", iconClass)}
        aria-hidden="true"
      />
      <div className="grid min-w-0 flex-1 gap-1">
        <p className="text-sm leading-5 font-semibold">{title}</p>
        {children && (
          <div className="text-sm leading-5 text-foreground">{children}</div>
        )}
        {action && <div className="mt-1">{action}</div>}
      </div>
    </div>
  );
}
