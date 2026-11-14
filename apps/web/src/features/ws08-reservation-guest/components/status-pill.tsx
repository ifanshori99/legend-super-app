// Status label for the guest page: always text, never colour alone.
import * as React from "react";
import { Badge } from "@/components/ui/badge";

type Tone = "success" | "warning" | "neutral";

export function StatusPill({
  tone,
  children,
}: {
  tone: Tone;
  children: React.ReactNode;
}) {
  return (
    <Badge tone={tone} className="w-fit px-3 py-1 text-sm">
      {children}
    </Badge>
  );
}
