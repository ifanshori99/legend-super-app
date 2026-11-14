// Callout with a title and a short text, for rules the guest must read before
// acting. The tone sets the left rule; the title carries the meaning.
import * as React from "react";
import { cn } from "cn";

type Tone = "info" | "warning" | "success";

const RULE: Record<Tone, string> = {
  info: "border-l-muted-foreground",
  warning: "border-l-warning",
  success: "border-l-success",
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
        "rounded-container border-l-4 bg-card px-5 py-4",
        RULE[tone],
        className,
      )}
      {...props}
    >
      <strong className="block">{title}</strong>
      <div className="mt-1 text-muted-foreground">{children}</div>
    </div>
  );
}
