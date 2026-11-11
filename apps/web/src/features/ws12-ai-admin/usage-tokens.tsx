// Tenant MCP token list with state badges and per-token revoke (MCP-02). Only
// the token prefix is ever shown. A revoked token stops working within one
// minute, and the dialog says so after it succeeds.
import * as React from "react";
import { CircleAlert, CircleCheck, Clock } from "lucide-react";
import type { McpTokenSummary } from "@starter/shared/ai";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTableShell } from "@/components/ui/data-table-shell";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { mcpTokenState } from "./logic.ts";
import {
  REVOCATION_MINUTES,
  formatMoment,
  scopeLabel,
  tokenStateKey,
  tokenStateTone,
  type TokenStateName,
} from "./usage-format";
import { useRevokeMcpToken, useTenantTokens } from "./usage-hooks";

const STATE_ICON = {
  active: CircleCheck,
  expired: Clock,
  revoked: CircleAlert,
} as const;

function StateBadge({ state }: { state: TokenStateName }) {
  const t = useT();
  const Icon = STATE_ICON[state];
  return (
    <Badge tone={tokenStateTone(state)}>
      <Icon aria-hidden="true" />
      {t(tokenStateKey(state))}
    </Badge>
  );
}

export function UsageTokens() {
  const t = useT();
  const tokens = useTenantTokens();
  const [revoking, setRevoking] = React.useState<McpTokenSummary | null>(null);
  const rows = tokens.data?.pages.flatMap((page) => page.data) ?? [];
  const now = new Date();
  const state = tokens.isPending
    ? "loading"
    : tokens.isError
      ? "error"
      : rows.length === 0
        ? "empty"
        : "ready";

  return (
    <>
      <DataTableShell
        title={t("aiAdminUsage.tokens.title")}
        description={t("aiAdminUsage.tokens.hint")}
        state={state}
        rowCount={rows.length}
        error={tokens.error}
        errorCopy={{
          title: t("aiAdminUsage.tokens.errorTitle"),
          description: t("aiAdminUsage.error.hint"),
        }}
        onRetry={() => void tokens.refetch()}
        empty={{
          title: t("aiAdminUsage.tokens.emptyTitle"),
          description: t("aiAdminUsage.tokens.emptyHint"),
        }}
      >
        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("aiAdminUsage.tokens.columns.client")}</TableHead>
                <TableHead>{t("aiAdminUsage.tokens.columns.user")}</TableHead>
                <TableHead>{t("aiAdminUsage.tokens.columns.scopes")}</TableHead>
                <TableHead>
                  {t("aiAdminUsage.tokens.columns.lastUsed")}
                </TableHead>
                <TableHead>{t("aiAdminUsage.tokens.columns.status")}</TableHead>
                <TableHead className="text-right">
                  {t("aiAdminUsage.tokens.columns.action")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((token) => {
                const tokenState = mcpTokenState(token, now);
                return (
                  <TableRow key={token.id}>
                    <TableCell>
                      <p className="font-semibold">
                        {token.clientName ??
                          t("aiAdminUsage.tokens.unknownClient")}
                      </p>
                      <p className="font-mono text-xs text-muted-foreground">
                        {token.tokenPrefix}
                      </p>
                    </TableCell>
                    <TableCell>
                      {token.userDisplayName ??
                        t("aiAdminUsage.tokens.unknownUser")}
                    </TableCell>
                    <TableCell>
                      <Scopes scopes={token.scopes} />
                    </TableCell>
                    <TableCell className="tabular">
                      {token.lastUsedAt
                        ? formatMoment(token.lastUsedAt)
                        : t("aiAdminUsage.tokens.neverUsed")}
                      <p className="text-xs text-muted-foreground">
                        {t("aiAdminUsage.tokens.columns.expires")}{" "}
                        {formatMoment(token.expiresAt)}
                      </p>
                    </TableCell>
                    <TableCell>
                      <StateBadge state={tokenState} />
                    </TableCell>
                    <TableCell className="text-right">
                      {tokenState === "active" && (
                        <RevokeButton
                          token={token}
                          onClick={() => setRevoking(token)}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        <ul className="divide-y divide-border md:hidden">
          {rows.map((token) => {
            const tokenState = mcpTokenState(token, now);
            return (
              <li key={token.id} className="grid gap-2 p-card">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold">
                      {token.clientName ??
                        t("aiAdminUsage.tokens.unknownClient")}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {token.userDisplayName ??
                        t("aiAdminUsage.tokens.unknownUser")}{" "}
                      · <span className="font-mono">{token.tokenPrefix}</span>
                    </p>
                  </div>
                  <StateBadge state={tokenState} />
                </div>
                <Scopes scopes={token.scopes} />
                <p className="text-sm text-muted-foreground tabular">
                  {t("aiAdminUsage.tokens.columns.lastUsed")}:{" "}
                  {token.lastUsedAt
                    ? formatMoment(token.lastUsedAt)
                    : t("aiAdminUsage.tokens.neverUsed")}
                  <br />
                  {t("aiAdminUsage.tokens.columns.expires")}:{" "}
                  {formatMoment(token.expiresAt)}
                </p>
                {tokenState === "active" && (
                  <RevokeButton
                    token={token}
                    onClick={() => setRevoking(token)}
                    className="w-full"
                  />
                )}
              </li>
            );
          })}
        </ul>

        {tokens.hasNextPage && (
          <div className="border-t p-card">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="max-sm:w-full"
              loading={tokens.isFetchingNextPage}
              onClick={() => void tokens.fetchNextPage()}
            >
              {t("aiAdminUsage.tokens.loadMore")}
            </Button>
          </div>
        )}
      </DataTableShell>

      {revoking && (
        <RevokeTokenDialog token={revoking} onClose={() => setRevoking(null)} />
      )}
    </>
  );
}

function Scopes({ scopes }: { scopes: readonly string[] }) {
  return (
    <ul className="flex flex-wrap gap-1">
      {scopes.map((scope) => (
        <li key={scope}>
          <Badge tone="neutral">{scopeLabel(scope)}</Badge>
        </li>
      ))}
    </ul>
  );
}

function RevokeButton({
  token,
  onClick,
  className,
}: {
  token: McpTokenSummary;
  onClick: () => void;
  className?: string;
}) {
  const t = useT();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={`max-sm:h-11 ${className ?? ""}`}
      aria-label={t("aiAdminUsage.tokens.revokeFor", {
        prefix: token.tokenPrefix,
      })}
      onClick={onClick}
    >
      {t("aiAdminUsage.tokens.revoke")}
    </Button>
  );
}

function RevokeTokenDialog({
  token,
  onClose,
}: {
  token: McpTokenSummary;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const revoke = useRevokeMcpToken();
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | undefined>();
  const [failed, setFailed] = React.useState(false);
  const [done, setDone] = React.useState(false);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = reason.trim();
    if (trimmed !== "" && trimmed.length < 3) {
      setError(t("aiAdminUsage.tokens.revokeDialog.reasonError"));
      return;
    }
    setError(undefined);
    setFailed(false);
    revoke.mutate(
      { tokenId: token.id, ...(trimmed === "" ? {} : { reason: trimmed }) },
      {
        onSuccess: () => {
          setDone(true);
          toast({
            title: t("aiAdminUsage.tokens.revokeDialog.doneTitle"),
            description: t("aiAdminUsage.tokens.revokeDialog.done", {
              prefix: token.tokenPrefix,
              minutes: REVOCATION_MINUTES,
            }),
            tone: "success",
          });
        },
        onError: () => setFailed(true),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {done
              ? t("aiAdminUsage.tokens.revokeDialog.doneTitle")
              : t("aiAdminUsage.tokens.revokeDialog.title")}
          </DialogTitle>
          <DialogDescription>
            {done
              ? t("aiAdminUsage.tokens.revokeDialog.done", {
                  prefix: token.tokenPrefix,
                  minutes: REVOCATION_MINUTES,
                })
              : t("aiAdminUsage.tokens.revokeDialog.body", {
                  prefix: token.tokenPrefix,
                  user:
                    token.userDisplayName ??
                    t("aiAdminUsage.tokens.unknownUser"),
                  client:
                    token.clientName ?? t("aiAdminUsage.tokens.unknownClient"),
                })}
          </DialogDescription>
        </DialogHeader>
        {done ? (
          <DialogFooter>
            <Button type="button" onClick={onClose}>
              {t("common.close")}
            </Button>
          </DialogFooter>
        ) : (
          <form className="grid gap-4" onSubmit={submit} noValidate>
            <FormField
              label={t("aiAdminUsage.tokens.revokeDialog.reasonLabel")}
              hint={t("aiAdminUsage.tokens.revokeDialog.reasonHint")}
              error={error}
            >
              <Textarea
                rows={2}
                value={reason}
                maxLength={500}
                onChange={(event) => setReason(event.target.value)}
              />
            </FormField>
            {failed && (
              <p
                role="alert"
                className="text-sm leading-5 font-medium text-danger"
              >
                {t("aiAdminUsage.tokens.revokeDialog.failed")}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                variant="destructive"
                loading={revoke.isPending}
              >
                {t("aiAdminUsage.tokens.revokeDialog.confirm")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
