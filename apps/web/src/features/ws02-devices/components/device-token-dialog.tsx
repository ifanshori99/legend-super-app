// One-time device token (bead legend-2lp.9). The token arrives only in the
// answer to enroll / reissue and is never persisted: it lives in the caller's
// state, which clears it when this dialog closes. No query cache, no storage.
import * as React from "react";
import { Check, Copy, TriangleAlert } from "lucide-react";
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

export type IssuedToken = {
  token: string;
  deviceLabel: string;
  kind: "enrolled" | "reissued";
};

export function DeviceTokenDialog({
  issued,
  onClose,
}: {
  issued: IssuedToken | null;
  onClose: () => void;
}) {
  const t = useT();
  // Copy feedback is tied to the token it was made for, so a later token
  // never starts out showing "copied".
  const [result, setResult] = React.useState<{
    token: string;
    status: "copied" | "error";
  } | null>(null);
  const token = issued?.token ?? null;
  const copy = result?.token === token ? result.status : "idle";

  // Nothing about the token may outlive the dialog, copy feedback included.
  const close = () => {
    setResult(null);
    onClose();
  };
  // The parent can also drop the token without going through close(); clear
  // the stored copy while rendering (React's "adjust state on prop change").
  if (token === null && result !== null) setResult(null);

  const copyToken = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setResult({ token, status: "copied" });
    } catch {
      setResult({ token, status: "error" });
    }
  };

  return (
    <Dialog
      open={issued !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        hideClose
        // The token cannot be fetched again, so a stray click outside must not
        // dismiss it; Escape and the button still close it.
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {issued?.kind === "reissued"
              ? t("deviceRegistry.token.reissuedTitle")
              : t("deviceRegistry.token.enrolledTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("deviceRegistry.token.description", {
              name: issued?.deviceLabel ?? "",
            })}
          </DialogDescription>
        </DialogHeader>
        <div
          role="note"
          className="flex items-start gap-3 rounded-container border-(length:--border-w) bg-warning-subtle p-3 text-warning"
        >
          <TriangleAlert
            className="mt-0.5 size-5 shrink-0"
            aria-hidden="true"
          />
          <div className="grid gap-0.5">
            <p className="text-sm font-semibold">
              {t("deviceRegistry.token.warning")}
            </p>
            <p className="text-sm">
              {t("deviceRegistry.token.warningBody")}
              {issued?.kind === "reissued" &&
                ` ${t("deviceRegistry.token.reissueNote")}`}
            </p>
          </div>
        </div>
        <div className="grid gap-1">
          <p className="text-sm text-muted-foreground">
            {t("deviceRegistry.token.tokenLabel")}
          </p>
          <output
            aria-label={t("deviceRegistry.token.tokenLabel")}
            className="block rounded-control border-(length:--border-w) bg-shell p-3 font-mono text-xs leading-5 break-all select-all"
          >
            {issued?.token}
          </output>
        </div>
        {copy === "error" && (
          <p role="alert" className="text-sm text-danger">
            {t("deviceRegistry.token.copyFailed")}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={copyToken}>
            {copy === "copied" ? (
              <Check aria-hidden="true" />
            ) : (
              <Copy aria-hidden="true" />
            )}
            {copy === "copied"
              ? t("deviceRegistry.token.copied")
              : t("deviceRegistry.token.copy")}
          </Button>
          <Button type="button" onClick={close}>
            {t("deviceRegistry.token.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
