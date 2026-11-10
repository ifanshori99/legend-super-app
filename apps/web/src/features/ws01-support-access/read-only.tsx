// Shared read-only pattern for a support session (Super Admin impersonating a
// tenant user under a read_only grant; TEN-04). The API refuses every
// mutation (SUPPORT_ACCESS_READ_ONLY); this is the matching presentation:
//
//   <SupportReadOnlyProvider value={readOnly}>...</SupportReadOnlyProvider>
//
// - `useSupportReadOnly()`: true inside a read-only provider, false outside
//   (safe default, so shared components work anywhere). <Button type="submit">
//   reads it and renders aria-disabled (focusable, click blocked with the
//   same toast, lock icon, described by a hidden hint the provider renders
//   once).
// - The provider also blocks form submits that still get through (Enter key,
//   a plain <button> in a form). React events bubble through portals along the
//   React tree, so dialogs opened from inside the provider are covered too.
// - Opt-out for read-only forms (search, filter) that send no mutation:
//   `<form data-support-readonly-allow>` skips the submit blocker, and
//   `<Button type="submit" allowInReadOnly>` stays enabled. Use both together
//   on such a form. Never use them on a form that writes.
//
// Hiding or disabling UI is never the access check; the API is.
import * as React from "react";
import { useT } from "@/components/i18n";
import { useToast } from "@/components/ui/toast";

/** Id of the visually hidden hint a blocked submit Button points to. */
export const SUPPORT_READ_ONLY_HINT_ID = "support-readonly-hint";

// null outside a read-only provider; inside, the function that tells the
// person a save was blocked (one toast wording for every blocked path).
const SupportReadOnlyContext = React.createContext<(() => void) | null>(null);

export function useSupportReadOnly(): boolean {
  return React.useContext(SupportReadOnlyContext) !== null;
}

/** Shows the "cannot save" toast; a no-op outside a read-only provider. */
export function useNotifySupportReadOnlyBlocked(): () => void {
  return React.useContext(SupportReadOnlyContext) ?? noop;
}

function noop() {}

export function SupportReadOnlyProvider({
  value,
  children,
}: {
  value: boolean;
  children: React.ReactNode;
}) {
  return value ? <SubmitBlocker>{children}</SubmitBlocker> : children;
}

function SubmitBlocker({ children }: { children: React.ReactNode }) {
  const t = useT();
  const toast = useToast();
  const notify = React.useCallback(
    () =>
      toast({
        title: t("supportAccess.readOnlyMode.submitBlocked"),
        tone: "danger",
      }),
    [toast, t],
  );
  return (
    <SupportReadOnlyContext.Provider value={notify}>
      {/* `contents` keeps this wrapper out of the layout. */}
      <div
        className="contents"
        onSubmitCapture={(event) => {
          const form = event.target instanceof Element ? event.target : null;
          if (form?.closest("form[data-support-readonly-allow]")) return;
          event.preventDefault();
          event.stopPropagation();
          notify();
        }}
      >
        {children}
        <span id={SUPPORT_READ_ONLY_HINT_ID} className="sr-only">
          {t("supportAccess.readOnlyMode.submitDisabledHint")}
        </span>
      </div>
    </SupportReadOnlyContext.Provider>
  );
}
