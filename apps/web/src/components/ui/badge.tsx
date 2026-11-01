import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import {
  CircleAlert,
  CircleCheck,
  CircleDot,
  Clock,
  Info,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { Slot } from "radix-ui";
import { useT } from "@/components/i18n";

// Badge: a short label or count the user acts on. Tinted fill, strong text
// (every pair is in the contrast check).
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-xs leading-5 font-semibold whitespace-nowrap tabular [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        neutral: "bg-muted text-foreground",
        brand: "bg-brand-subtle text-foreground",
        success: "bg-success-subtle text-success",
        warning: "bg-warning-subtle text-warning",
        danger: "bg-danger-subtle text-danger",
        info: "bg-info-subtle text-info",
        solid: "bg-primary text-primary-foreground",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

function Badge({
  className,
  tone,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";
  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ tone }), className)}
      {...props}
    />
  );
}

// StatusPill: a status always shown as icon + text, never color alone
// (WCAG 1.4.1). Order statuses follow PRD ORD "Status Pesanan"; timer
// statuses follow PRD "KDS per Stasiun" (warna timer berdasarkan target).
type Tone = "neutral" | "success" | "warning" | "danger" | "info";

const STATUS = {
  received: { tone: "info", icon: CircleDot, label: "orderStatus.received" },
  preparing: { tone: "warning", icon: Clock, label: "orderStatus.preparing" },
  ready: { tone: "success", icon: CircleCheck, label: "orderStatus.ready" },
  delivered: {
    tone: "neutral",
    icon: CircleCheck,
    label: "orderStatus.delivered",
  },
  onTrack: { tone: "success", icon: Clock, label: "timer.onTrack" },
  near: { tone: "warning", icon: TriangleAlert, label: "timer.near" },
  late: { tone: "danger", icon: CircleAlert, label: "timer.late" },
  success: { tone: "success", icon: CircleCheck, label: "status.success" },
  warning: { tone: "warning", icon: TriangleAlert, label: "status.warning" },
  danger: { tone: "danger", icon: CircleAlert, label: "status.danger" },
  info: { tone: "info", icon: Info, label: "status.info" },
} as const satisfies Record<
  string,
  { tone: Tone; icon: LucideIcon; label: `${string}.${string}` }
>;

export type StatusKind = keyof typeof STATUS;
export const ORDER_STATUSES = [
  "received",
  "preparing",
  "ready",
  "delivered",
] as const;
export const TIMER_STATUSES = ["onTrack", "near", "late"] as const;

function StatusPill({
  status,
  children,
  className,
}: {
  status: StatusKind;
  /** Overrides the catalog label, e.g. "Siap · 2 item". */
  children?: React.ReactNode;
  className?: string;
}) {
  const t = useT();
  const { tone, icon: Icon, label } = STATUS[status];
  return (
    <span
      data-slot="status-pill"
      data-status={status}
      className={cn(
        badgeVariants({ tone }),
        "rounded-full px-2.5 text-sm",
        className,
      )}
    >
      <Icon aria-hidden="true" />
      {children ?? t(label)}
    </span>
  );
}

export { Badge, badgeVariants, StatusPill };
