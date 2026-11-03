// Activate / deactivate a tenant with a confirmation and a reason (PRD §3 F4
// "membuat dan menonaktifkan tenant"; the reason is audited by the API).
import * as React from "react";
import type { TenantStatus } from "@starter/shared/platform";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { useSetTenantStatus } from "../hooks";
import { validateReason } from "../logic";

const k = (key: string) => `platformTenants.statusDialog.${key}` as MessageKey;

export function StatusChangeDialog({
  tenantId,
  tenantName,
  target,
  open,
  onOpenChange,
}: {
  tenantId: string;
  tenantName: string;
  target: Extract<TenantStatus, "active" | "suspended">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const toast = useToast();
  const mutation = useSetTenantStatus(tenantId);
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const deactivate = target === "suspended";

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!validateReason(reason)) {
      setError(t(k("reasonError")));
      return;
    }
    setError(null);
    mutation.mutate(
      { status: target, reason: reason.trim() },
      {
        onSuccess: () => {
          toast({
            title: t(deactivate ? k("doneDeactivate") : k("doneActivate")),
          });
          setReason("");
          onOpenChange(false);
        },
        onError: (failure) =>
          setError(
            failure instanceof ApiError && failure.code === "INVALID_TRANSITION"
              ? t(k("invalidTransition"))
              : failure instanceof ApiError && failure.code === "NETWORK_ERROR"
                ? t(k("offline"))
                : t(k("failed")),
          ),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setReason("");
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <form onSubmit={submit} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>
              {t(deactivate ? k("titleDeactivate") : k("titleActivate"), {
                name: tenantName,
              })}
            </DialogTitle>
            <DialogDescription>
              {t(deactivate ? k("bodyDeactivate") : k("bodyActivate"))}
            </DialogDescription>
          </DialogHeader>
          <FormField
            label={t(k("reason"))}
            hint={t(k("reasonHint"))}
            error={error ?? undefined}
            required
          >
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              maxLength={500}
            />
          </FormField>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              variant={deactivate ? "destructive" : "default"}
              aria-busy={mutation.isPending || undefined}
              disabled={mutation.isPending}
            >
              {t(deactivate ? k("confirmDeactivate") : k("confirmActivate"))}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
