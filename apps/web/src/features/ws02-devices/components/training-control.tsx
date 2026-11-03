// Per-device training mode switch with the watermark explanation (PRD v1.7
// §3 F5 "Mode Latihan"). Enabling or disabling asks for confirmation because a
// training device keeps its sales out of reports (fraud-sensitive; the API
// needs device.registry.manage and audits each change).
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
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { deviceErrorMessage } from "../errors.ts";
import { useSetTrainingMode } from "../hooks.ts";

export function TrainingExplanation() {
  const t = useT();
  return (
    <div className="grid gap-2 rounded-container border-(length:--border-w) bg-shell p-3">
      <p className="text-sm font-semibold">
        {t("deviceRegistry.training.explainTitle")}
      </p>
      <p className="text-sm leading-5 text-muted-foreground">
        {t("deviceRegistry.training.explainBody")}
      </p>
      <ul className="list-disc pl-5 text-sm leading-5 text-muted-foreground">
        <li>{t("deviceRegistry.training.watermarkPoint")}</li>
        <li>{t("deviceRegistry.training.reportsPoint")}</li>
        <li>{t("deviceRegistry.training.auditPoint")}</li>
      </ul>
    </div>
  );
}

export function TrainingSwitch({
  device,
  canManage,
  online = true,
}: {
  device: Device;
  canManage: boolean;
  online?: boolean;
}) {
  const t = useT();
  const toast = useToast();
  const mutation = useSetTrainingMode();
  const [pending, setPending] = React.useState<boolean | null>(null);
  const revoked = device.status === "revoked";
  const disabled = !canManage || revoked || !online || mutation.isPending;
  const reason = revoked
    ? t("deviceRegistry.training.revokedLocked")
    : !canManage
      ? t("deviceRegistry.training.needsPermission")
      : null;

  const confirm = () => {
    if (pending === null) return;
    mutation.mutate(
      { deviceId: device.id, trainingMode: pending },
      {
        onSuccess: () => {
          toast({ title: t("deviceRegistry.training.saved"), tone: "success" });
          setPending(null);
        },
        onError: (error) => {
          toast({ title: deviceErrorMessage(error, t), tone: "danger" });
          setPending(null);
        },
      },
    );
  };

  return (
    <>
      <div className="flex min-h-11 items-center gap-2">
        <Switch
          aria-label={t("deviceRegistry.training.label", {
            name: device.label,
          })}
          checked={device.trainingMode}
          disabled={disabled}
          onCheckedChange={(checked) => setPending(checked)}
        />
        <span className="text-sm font-semibold">
          {device.trainingMode
            ? t("deviceRegistry.training.on")
            : t("deviceRegistry.training.off")}
        </span>
      </div>
      {reason && <p className="text-xs text-muted-foreground">{reason}</p>}
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pending
                ? t("deviceRegistry.training.enableTitle")
                : t("deviceRegistry.training.disableTitle")}
            </DialogTitle>
            <DialogDescription>
              {pending
                ? t("deviceRegistry.training.enableBody", {
                    name: device.label,
                  })
                : t("deviceRegistry.training.disableBody", {
                    name: device.label,
                  })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)}>
              {t("common.cancel")}
            </Button>
            <Button loading={mutation.isPending} onClick={confirm}>
              {pending
                ? t("deviceRegistry.training.enableConfirm")
                : t("deviceRegistry.training.disableConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
