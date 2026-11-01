// An inline message that stays on the page (session waiting for the waiter,
// sold-out items removed, zone closed). Status is icon + text, never color
// alone (DESIGN.md §8). Not an error boundary: use ErrorState for failed loads.
import type { ReactNode } from "react";
import { cn } from "cn";
import { CircleAlert, Clock, Info, TriangleAlert } from "lucide-react";

const TONES = {
  info: { icon: Info, box: "bg-info-subtle", iconClass: "text-info" },
  warning: {
    icon: TriangleAlert,
    box: "bg-warning-subtle",
    iconClass: "text-warning",
  },
  danger: {
    icon: CircleAlert,
    box: "bg-danger-subtle",
    iconClass: "text-danger",
  },
  waiting: { icon: Clock, box: "bg-info-subtle", iconClass: "text-info" },
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
      role="status"
      className={cn("flex gap-3 rounded-xl p-3", box, className)}
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
