// Status pill that sits on a menu photo (DESIGN.md v2 §4 "Media"): the photo is
// busy, so the pill is an opaque card surface with a raised shadow instead of a
// tint, and it carries a word (never color alone). Used for sold out, a menu
// label, and "Paket".
import type { ReactNode } from "react";

export function PhotoBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-card px-2.5 py-1 text-xs leading-4 font-semibold text-foreground shadow-raised">
      {children}
    </span>
  );
}
