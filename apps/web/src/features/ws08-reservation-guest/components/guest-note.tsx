// Callout with a title and a short text, for rules the guest must read before
// acting. The tone sets the left rule and the fill; the title carries the meaning.
import * as React from "react";
import { cn } from "cn";

type Tone = "info" | "warning" | "success";

// Info: card fill with the warm input edge (--input, #8b7765 in the QR theme).
const TONE: Record<Tone, string> = {
  info: "border-l-input bg-card",
  warning: "border-l-warning bg-warning-subtle",
  success: "border-l-success bg-success-subtle",
};

export function GuestNote({
  tone,
  title,
  children,
  className,
  ...props
}: {
  tone: Tone;
  title: string;
  children: React.ReactNode;
} & Omit<React.ComponentProps<"div">, "title">) {
  return (
    <div
      className={cn(
        "rounded-l-none rounded-r-[12px] border-l-[3px] px-5 py-4",
        TONE[tone],
        className,
      )}
      {...props}
    >
      <strong className="mb-1 block">{title}</strong>
      <div className="text-muted-foreground">{children}</div>
    </div>
  );
}
