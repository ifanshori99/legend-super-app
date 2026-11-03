// Confirm-then-save flow shared by the platform editors: the dialog state,
// the mutation and the error text live in one place.
import * as React from "react";
import { useT } from "@/components/i18n";
import { useToast } from "@/components/ui/toast";
import type { SetTenantPackageBody } from "../api";
import { opsErrorMessage } from "../errors";
import { useSetTenantPackage } from "../hooks";

export function useConfirmedSave(tenantId: string, savedMessage: string) {
  const t = useT();
  const toast = useToast();
  const mutation = useSetTenantPackage(tenantId);
  const [confirming, setConfirming] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  return {
    confirming,
    error,
    pending: mutation.isPending,
    open: () => {
      setError(null);
      setConfirming(true);
    },
    setConfirming,
    run: (body: SetTenantPackageBody) => {
      setError(null);
      mutation.mutate(body, {
        onSuccess: () => {
          toast({ title: savedMessage, tone: "success" });
          setConfirming(false);
        },
        onError: (failure) => setError(opsErrorMessage(failure, t)),
      });
    },
  };
}
