// Save-failed banner shared by the policy and THR dialogs (bead wpqs). It sits
// above the form, so it scrolls into view and takes focus when it appears: a
// failed save is never hidden above the fold of a scrolled dialog. The dialogs
// clear the error on every submit, so each failure mounts a fresh banner.
import * as React from "react";
import { TriangleAlert } from "lucide-react";

export function SaveErrorBanner({ message }: { message: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const reduceMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    node.scrollIntoView?.({
      block: "nearest",
      behavior: reduceMotion ? "auto" : "smooth",
    });
    node.focus({ preventScroll: true });
  }, []);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="flex items-start gap-2 rounded-container border border-danger/40 bg-danger-subtle p-card outline-none"
      role="alert"
      data-testid="payroll-save-error"
    >
      <TriangleAlert
        className="mt-0.5 size-4 shrink-0 text-danger"
        aria-hidden="true"
      />
      <p className="text-sm leading-5 font-medium text-danger">{message}</p>
    </div>
  );
}
