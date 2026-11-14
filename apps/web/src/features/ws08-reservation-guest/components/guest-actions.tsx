// Stacked actions: the first child is the one primary action (48px, full
// width); the rest are quieter links or secondary buttons.
import * as React from "react";

export function GuestActions({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2 grid gap-3 [&>*:first-child]:w-full [&>button:not([data-variant=link])]:w-full [&>button[data-variant=link]]:justify-self-center [&>button[data-variant=link]]:py-3">
      {children}
    </div>
  );
}
