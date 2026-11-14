// Stacked actions: the first child is the one primary action (48px, full
// width); the rest are quieter links or secondary buttons. From `sm` a
// secondary outline button hugs its text and sits on the left, as in the
// mockup. Buttons are weight 750 with a 12px radius; the link keeps its
// underline for accessibility.
import * as React from "react";

export function GuestActions({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2 grid gap-3 [&>*:first-child]:w-full [&>button]:rounded-[12px] [&>button]:font-[750] [&>button:not([data-variant=link])]:w-full sm:[&>button[data-variant=outline]:not(:first-child)]:max-w-full sm:[&>button[data-variant=outline]:not(:first-child)]:w-auto sm:[&>button[data-variant=outline]:not(:first-child)]:justify-self-start [&>button[data-variant=link]]:justify-self-center [&>button[data-variant=link]]:py-3 [&>button[data-variant=link]]:font-bold [&>button[data-variant=link]]:underline">
      {children}
    </div>
  );
}
