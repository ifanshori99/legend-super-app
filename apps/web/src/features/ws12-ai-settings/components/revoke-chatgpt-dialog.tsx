// Confirms revoking the ChatGPT connection. Lives apart from the panel so the
// in-flight revoke cannot be dismissed with Esc or an outside click: the owner
// must see whether it worked.
import * as React from "react";
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
import { isOfflineError } from "@/features/ws12-ai-admin/components/shared";
import { useRevokeChatgpt } from "../hooks";

export function RevokeChatgptDialog({
  open,
  onClose,
  onRevoked,
}: {
  open: boolean;
  onClose: () => void;
  /** Runs once the dialog has closed after a successful revoke. */
  onRevoked: () => void;
}) {
  const t = useT();
  const revoke = useRevokeChatgpt();
  const revoked = React.useRef(false);
  const close = () => {
    revoke.reset();
    onClose();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !revoke.isPending) close();
      }}
    >
      <DialogContent
        className="sm:max-w-[30rem]"
        onCloseAutoFocus={(event) => {
          // The revoke button is gone: put focus on the card title instead.
          if (!revoked.current) return;
          revoked.current = false;
          event.preventDefault();
          onRevoked();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("aiSettingsChatgpt.revoke.title")}</DialogTitle>
          <DialogDescription asChild>
            <div className="grid max-w-[27rem] gap-2 text-pretty">
              <p>{t("aiSettingsChatgpt.revoke.body")}</p>
              <p>{t("aiSettingsChatgpt.revoke.again")}</p>
            </div>
          </DialogDescription>
        </DialogHeader>
        {revoke.isError && (
          <p role="alert" className="text-sm leading-5 font-medium text-danger">
            {t(
              isOfflineError(revoke.error)
                ? "aiSettingsChatgpt.actionError.offline"
                : "aiSettingsChatgpt.actionError.generic",
            )}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={close}
            disabled={revoke.isPending}
          >
            {t("aiSettingsChatgpt.revoke.cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            loading={revoke.isPending}
            onClick={() =>
              revoke.mutate(undefined, {
                onSuccess: () => {
                  revoked.current = true;
                  close();
                },
              })
            }
          >
            {t("aiSettingsChatgpt.revoke.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
