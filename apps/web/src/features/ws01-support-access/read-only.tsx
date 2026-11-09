// Shared read-only pattern for a support session (Super Admin impersonating a
// tenant user under a read_only grant; TEN-04). The API refuses every
// mutation (SUPPORT_ACCESS_READ_ONLY); this is the matching presentation:
//
//   <SupportReadOnlyProvider value={readOnly}>...</SupportReadOnlyProvider>
//
// - `useSupportReadOnly()`: true inside a read-only provider, false outside
//   (safe default, so shared components work anywhere). <Button type="submit">
//   reads it and renders disabled.
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

const SupportReadOnlyContext = React.createContext(false);

export function useSupportReadOnly(): boolean {
  return React.useContext(SupportReadOnlyContext);
}

export function SupportReadOnlyProvider({
  value,
  children,
}: {
  value: boolean;
  children: React.ReactNode;
}) {
  return (
    <SupportReadOnlyContext.Provider value={value}>
      {value ? <SubmitBlocker>{children}</SubmitBlocker> : children}
    </SupportReadOnlyContext.Provider>
  );
}

function SubmitBlocker({ children }: { children: React.ReactNode }) {
  const t = useT();
  const toast = useToast();
  return (
    // `contents` keeps this wrapper out of the layout.
    <div
      className="contents"
      onSubmitCapture={(event) => {
        const form = event.target instanceof Element ? event.target : null;
        if (form?.closest("form[data-support-readonly-allow]")) return;
        event.preventDefault();
        event.stopPropagation();
        toast({
          title: t("supportAccess.readOnlyMode.submitBlocked"),
          tone: "danger",
        });
      }}
    >
      {children}
    </div>
  );
}
