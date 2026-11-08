// Re-issue a device token (POST /api/devices/:id/token, device.registry.manage).
// Confirmation first: the old token stops working at once. The new token is
// handed to the caller (shown once) and is not kept here.
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
import { newIdempotencyKey } from "@/lib/idempotency";
import { deviceErrorMessage } from "../errors.ts";
import { useIssueDeviceToken } from "../hooks.ts";
import type { IssuedToken } from "./device-token-dialog.tsx";

export function ReissueTokenDialog({
  device,
  onOpenChange,
  onIssued,
}: {
  device: Device | null;
  onOpenChange: (open: boolean) => void;
  onIssued: (issued: IssuedToken) => void;
}) {
  const t = useT();
  const issue = useIssueDeviceToken(({ device: issued, token }) =>
    onIssued({ token, deviceLabel: issued.label, kind: "reissued" }),
  );
  const [serverError, setServerError] = React.useState<string | null>(null);
  // One key per confirmation, so a retried request replays the first answer.
  const keyRef = React.useRef<string | null>(null);

  const pending = issue.isPending;
  const close = () => {
    // The one-time token is still on its way: closing now would lose it.
    if (pending) return;
    setServerError(null);
    keyRef.current = null;
    issue.reset();
    onOpenChange(false);
  };

  const confirm = () => {
    if (!device || issue.isPending) return;
    setServerError(null);
    const idempotencyKey = (keyRef.current ??= newIdempotencyKey());
    issue.mutate(
      { deviceId: device.id, idempotencyKey },
      {
        onSuccess: () => {
          setServerError(null);
          keyRef.current = null;
          issue.reset();
          onOpenChange(false);
        },
        onError: (error) => setServerError(deviceErrorMessage(error, t)),
      },
    );
  };

  return (
    <Dialog
      open={device !== null}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent
        hideClose={pending}
        onEscapeKeyDown={(event) => pending && event.preventDefault()}
        onInteractOutside={(event) => pending && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t("deviceRegistry.token.reissueTitle")}</DialogTitle>
          <DialogDescription>
            {t("deviceRegistry.token.reissueBody", {
              name: device?.label ?? "",
            })}
          </DialogDescription>
        </DialogHeader>
        {serverError && (
          <p role="alert" className="text-sm text-danger">
            {serverError}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline"
            disabled={pending}
            onClick={close}
          >
            {t("common.cancel")}
          </Button>
          <Button type="button" loading={pending} onClick={confirm}>
            {t("deviceRegistry.token.reissueConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
