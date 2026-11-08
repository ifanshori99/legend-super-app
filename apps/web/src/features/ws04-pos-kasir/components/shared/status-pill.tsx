import type { ReactNode } from "react";
import { cn } from "cn";
import {
  CircleAlert,
  CircleCheck,
  CircleDot,
  Clock,
  Info,
  type LucideIcon,
} from "lucide-react";
import { badgeVariants } from "@/components/ui/badge";

export type StatusPillTone =
  "neutral" | "warning" | "success" | "danger" | "info";

const ICONS: Record<StatusPillTone, LucideIcon> = {
  neutral: CircleDot,
  warning: Clock,
  success: CircleCheck,
  danger: CircleAlert,
  info: Info,
};

// A status pill for POS cards: always an icon plus text, never color alone
// (WCAG 1.4.1). `icon` overrides the tone's default glyph.
export function StatusPill({
  tone,
  icon,
  children,
  className,
}: {
  tone: StatusPillTone;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  const Icon = icon ?? ICONS[tone];
  return (
    <span
      data-slot="pos-status-pill"
      data-tone={tone}
      className={cn(
        badgeVariants({ tone }),
        "rounded-full px-3 text-sm",
        className,
      )}
    >
      <Icon aria-hidden="true" />
      {children}
    </span>
  );
}
