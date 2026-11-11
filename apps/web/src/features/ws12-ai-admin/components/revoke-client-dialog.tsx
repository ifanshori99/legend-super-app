// Revoke one MCP client (founder decision Q11): every token of the client
// ends, so every session of that app disconnects and each user must approve
// access again. The dialog names the client, counts active tokens and distinct
// users (clientRevokeImpact), asks for a reason (min 3 characters), and after
// success says the revoke applies within MCP_REVOCATION_MAX_SECONDS (MCP-02).
import * as React from "react";
import { CircleCheck } from "lucide-react";
import { MCP_REVOCATION_MAX_SECONDS, type McpClient } from "@starter/shared/ai";
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
import { useRevokeClient } from "../hooks";
import { isValidRevokeReason } from "../logic";
import { isOfflineError, plain, RichText } from "./shared";

export type RevokeImpact = { activeTokens: number; users: number };

export function RevokeClientDialog({
  client,
  impact,
  onClose,
}: {
  client: McpClient | null;
  /** Null when the token list could not be loaded: counts are then unknown. */
  impact: RevokeImpact | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={client !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        {client !== null && (
          <RevokeBody client={client} impact={impact} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function RevokeBody({
  client,
  impact,
  onClose,
}: {
  client: McpClient;
  impact: RevokeImpact | null;
  onClose: () => void;
}) {
  const t = useT();
  const revoke = useRevokeClient();
  const [reason, setReason] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  // The counts shown when the dialog opened stay on screen after success, even
  // though the token list refreshes underneath.
  const [shownImpact] = React.useState(impact);
  const name = plain(client.name);

  const reasonError =
    touched && !isValidRevokeReason(reason)
      ? t("aiAdmin.revoke.reasonError")
      : undefined;

  if (revoke.isSuccess) {
    return (
      <>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CircleCheck className="size-5 text-success" aria-hidden="true" />
            {t("aiAdmin.revoke.doneTitle")}
          </DialogTitle>
          <DialogDescription>
            <RichText
              text={t("aiAdmin.revoke.done", {
                minutes: Math.max(
                  1,
                  Math.ceil(MCP_REVOCATION_MAX_SECONDS / 60),
                ),
                client: name,
              })}
            />
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={onClose}>{t("aiAdmin.revoke.close")}</Button>
        </DialogFooter>
      </>
    );
  }

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!isValidRevokeReason(reason)) return;
    revoke.mutate({ clientId: client.id, body: { reason: reason.trim() } });
  };

  const tokens = shownImpact?.activeTokens ?? 0;
  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{t("aiAdmin.revoke.title")}</DialogTitle>
        <DialogDescription asChild>
          <div className="grid gap-2">
            <p>
              <RichText
                text={
                  shownImpact === null
                    ? t("aiAdmin.revoke.bodyUnknown", { client: name })
                    : tokens === 0
                      ? t("aiAdmin.revoke.bodyNoTokens", { client: name })
                      : t("aiAdmin.revoke.body", { tokens, client: name })
                }
              />
            </p>
            {(shownImpact === null || shownImpact.users > 0) && (
              <p>
                <RichText
                  text={t("aiAdmin.revoke.users", {
                    users: shownImpact?.users ?? 0,
                  })}
                />
              </p>
            )}
            <p>{t("aiAdmin.revoke.allSessions")}</p>
          </div>
        </DialogDescription>
      </DialogHeader>

      <FormField
        label={t("aiAdmin.revoke.reasonLabel")}
        hint={t("aiAdmin.revoke.reasonHint")}
        error={reasonError}
        required
      >
        <Textarea
          value={reason}
          maxLength={500}
          placeholder={t("aiAdmin.revoke.reasonPlaceholder")}
          onChange={(event) => setReason(event.target.value)}
          onBlur={() => setTouched(true)}
        />
      </FormField>

      {revoke.isError && (
        <p role="alert" className="text-sm leading-5 font-medium text-danger">
          {t(
            isOfflineError(revoke.error)
              ? "aiAdmin.revoke.errorOffline"
              : "aiAdmin.revoke.error",
          )}
        </p>
      )}

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={revoke.isPending}
        >
          {t("aiAdmin.revoke.cancel")}
        </Button>
        <Button type="submit" variant="destructive" loading={revoke.isPending}>
          {tokens > 0
            ? t("aiAdmin.revoke.confirm", { tokens })
            : t("aiAdmin.revoke.confirmNoTokens")}
        </Button>
      </DialogFooter>
    </form>
  );
}
