// Approve a pending MCP client. The admin may narrow the scopes the client
// asked for (never widen: the API checks the subset again).
import * as React from "react";
import {
  MCP_SCOPE_LABELS_ID,
  type McpClient,
  type McpScope,
} from "@starter/shared/ai";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { useApproveClient } from "../hooks";
import { plain } from "./shared";

export function ApproveClientDialog({
  client,
  onClose,
}: {
  client: McpClient | null;
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
        {client !== null && <ApproveBody client={client} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function ApproveBody({
  client,
  onClose,
}: {
  client: McpClient;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const approve = useApproveClient();
  const [selected, setSelected] = React.useState<ReadonlySet<McpScope>>(
    () => new Set(client.allowedScopes),
  );
  const [touched, setTouched] = React.useState(false);
  const scopesError = touched && selected.size === 0;

  const toggle = (scope: McpScope, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(scope);
    else next.delete(scope);
    setSelected(next);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (selected.size === 0) return;
    const allowedScopes = client.allowedScopes.filter((scope) =>
      selected.has(scope),
    );
    approve.mutate(
      { clientId: client.id, body: { allowedScopes } },
      {
        onSuccess: () => {
          toast({ title: t("aiAdmin.approve.saved"), tone: "success" });
          onClose();
        },
      },
    );
  };

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <DialogHeader>
        <DialogTitle>
          {t("aiAdmin.approve.title", { client: plain(client.name) })}
        </DialogTitle>
        <DialogDescription>
          {t("aiAdmin.approve.description")}
        </DialogDescription>
      </DialogHeader>

      <fieldset className="grid gap-2" aria-describedby="approve-scopes-error">
        <legend className="mb-1 text-sm leading-5 font-semibold">
          {t("aiAdmin.approve.scopesLabel")}
        </legend>
        {client.allowedScopes.map((scope) => (
          <div key={scope} className="flex min-h-11 items-center gap-3">
            <Checkbox
              id={`approve-${scope}`}
              checked={selected.has(scope)}
              onCheckedChange={(value) => toggle(scope, value === true)}
            />
            <Label htmlFor={`approve-${scope}`} className="leading-5">
              {MCP_SCOPE_LABELS_ID[scope]}
            </Label>
          </div>
        ))}
        <div id="approve-scopes-error" aria-live="polite">
          {scopesError && (
            <p className="text-sm leading-5 font-medium text-danger">
              {t("aiAdmin.approve.scopesError")}
            </p>
          )}
        </div>
      </fieldset>

      <div className="grid gap-1 text-sm leading-5 text-muted-foreground">
        <span className="font-semibold text-foreground">
          {t("aiAdmin.approve.redirectLabel")}
        </span>
        {client.redirectUris.map((uri) => (
          <span key={uri} className="break-all">
            {uri}
          </span>
        ))}
      </div>

      {approve.isError && (
        <p role="alert" className="text-sm leading-5 font-medium text-danger">
          {t("aiAdmin.approve.error")}
        </p>
      )}

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={approve.isPending}
        >
          {t("aiAdmin.approve.cancel")}
        </Button>
        <Button type="submit" loading={approve.isPending}>
          {t("aiAdmin.approve.confirm")}
        </Button>
      </DialogFooter>
    </form>
  );
}
