// Status label for the guest page: always text, never colour alone. Neutral is
// the card with a warm border; success and warning are a tint plus a border
// mixed from the same token, so the pair keeps its contrast.
import * as React from "react";
import { cn } from "cn";

type Tone = "success" | "warning" | "neutral";

const TONE: Record<Tone, string> = {
  neutral: "border-border bg-card text-foreground",
  success:
    "border-[color-mix(in_srgb,var(--success)_30%,var(--success-subtle))] bg-success-subtle text-success",
  warning:
    "border-[color-mix(in_srgb,var(--warning)_35%,var(--warning-subtle))] bg-warning-subtle text-warning",
};

export function StatusPill({
  tone,
  children,
}: {
  tone: Tone;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-2 rounded-full border px-3 py-[5px] text-sm leading-5 font-bold [&_svg]:size-4 [&_svg]:shrink-0",
        TONE[tone],
      )}
    >
      {children}
    </span>
  );
}
