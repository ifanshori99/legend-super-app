// Revoke confirmation (PRD v1.7 §3 F5 Registri Perangkat): typed device name
// plus a reason; the API audits both and needs device.registry.revoke.
import * as React from "react";
import type { Device } from "@starter/shared/edge";
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { deviceErrorMessage } from "../errors.ts";
import { useRevokeDevice } from "../hooks.ts";
import { revokeConfirmationMatches, revokeReasonValid } from "../logic.ts";

export function RevokeDialog({
  device,
  open,
  onOpenChange,
  onRevoked,
}: {
  device: Device | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRevoked?: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const revoke = useRevokeDevice();
  const [typed, setTyped] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);

  const reset = () => {
    setTyped("");
    setReason("");
    setTouched(false);
    setServerError(null);
  };
  const label = device?.label ?? "";
  const nameOk = revokeConfirmationMatches(typed, label) && label !== "";
  const reasonOk = revokeReasonValid(reason);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!device || !nameOk || !reasonOk) return;
    setServerError(null);
    revoke.mutate(
      { deviceId: device.id, reason: reason.trim() },
      {
        onSuccess: () => {
          toast({ title: t("deviceRegistry.revoke.done"), tone: "success" });
          reset();
          onOpenChange(false);
          onRevoked?.();
        },
        onError: (error) => setServerError(deviceErrorMessage(error, t)),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("deviceRegistry.revoke.title")}</DialogTitle>
          <DialogDescription>
            {t("deviceRegistry.revoke.description")}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm font-semibold">{label}</p>
        <p className="text-sm text-danger">
          {t("deviceRegistry.revoke.warning")}
        </p>
        <form className="grid gap-3" onSubmit={submit} noValidate>
          <FormField
            label={t("deviceRegistry.revoke.confirmLabel")}
            hint={t("deviceRegistry.revoke.confirmHint", { name: label })}
            error={
              touched && !nameOk
                ? t("deviceRegistry.revoke.confirmMismatch")
                : undefined
            }
            required
          >
            <Input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </FormField>
          <FormField
            label={t("deviceRegistry.revoke.reasonLabel")}
            hint={t("deviceRegistry.revoke.reasonHint")}
            error={
              touched && !reasonOk
                ? t("deviceRegistry.revoke.reasonError")
                : undefined
            }
            required
          >
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={500}
              rows={3}
            />
          </FormField>
          {serverError && (
            <p role="alert" className="text-sm text-danger">
              {serverError}
            </p>
          )}
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
              variant="destructive"
              loading={revoke.isPending}
              disabled={!nameOk || !reasonOk}
            >
              {t("deviceRegistry.revoke.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
