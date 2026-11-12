// Tool-call audit (MCP-03): who called which tool, through which channel, and
// how it ended. Content never appears; params are already redacted by the
// server. Names come from the token list when it carries them.
import * as React from "react";
import {
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Clock,
  ShieldX,
} from "lucide-react";
import {
  AI_CHANNELS,
  AI_TOOL_CALL_OUTCOMES,
  AI_TOOL_CATALOG,
  type AiChannel,
  type AiToolCallOutcome,
  type AiToolCallRecord,
  type AiToolCode,
} from "@starter/shared/ai";
import { formatNumber } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTableShell } from "@/components/ui/data-table-shell";
import { FormField } from "@/components/ui/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  channelKey,
  formatMoment,
  outcomeKey,
  outcomeTone,
  paramPairs,
  toolTitle,
} from "./usage-format";
import { useTenantTokens, useToolCalls } from "./usage-hooks";

type ToolCall = AiToolCallRecord;

const ALL = "all";

const OUTCOME_ICON: Record<AiToolCallOutcome, typeof CircleCheck> = {
  ok: CircleCheck,
  denied: ShieldX,
  error: CircleAlert,
  rate_limited: Clock,
  disabled: CircleSlash,
};

function OutcomeBadge({ outcome }: { outcome: AiToolCallOutcome }) {
  const t = useT();
  const Icon = OUTCOME_ICON[outcome];
  return (
    <Badge tone={outcomeTone(outcome)}>
      <Icon aria-hidden="true" />
      {t(outcomeKey(outcome))}
    </Badge>
  );
}

export function UsageToolCalls() {
  const t = useT();
  const [channel, setChannel] = React.useState<AiChannel | typeof ALL>(ALL);
  const [outcome, setOutcome] = React.useState<AiToolCallOutcome | typeof ALL>(
    ALL,
  );
  const [tool, setTool] = React.useState<AiToolCode | typeof ALL>(ALL);
  const filtered = channel !== ALL || outcome !== ALL || tool !== ALL;
  const calls = useToolCalls({
    ...(channel === ALL ? {} : { channel }),
    ...(outcome === ALL ? {} : { outcome }),
    ...(tool === ALL ? {} : { toolCode: tool }),
  });
  // Names are a convenience: a failed token list only drops them.
  const tokens = useTenantTokens();
  const clientNames = new Map<string, string>();
  const userNames = new Map<string, string>();
  for (const token of tokens.data?.pages.flatMap((page) => page.data) ?? []) {
    if (token.clientName) clientNames.set(token.clientId, token.clientName);
    if (token.userDisplayName)
      userNames.set(token.userId, token.userDisplayName);
  }
  const rows = calls.data?.pages.flatMap((page) => page.data) ?? [];
  const state = calls.isPending
    ? "loading"
    : calls.isError
      ? "error"
      : rows.length === 0 && !filtered
        ? "empty"
        : "ready";

  const clientOf = (row: ToolCall) =>
    row.mcpClientId ? (clientNames.get(row.mcpClientId) ?? "–") : "–";
  const userOf = (row: ToolCall) => userNames.get(row.userId) ?? "–";

  return (
    <DataTableShell
      title={t("aiAdminUsage.calls.title")}
      description={t("aiAdminUsage.calls.hint")}
      state={state}
      rowCount={rows.length}
      noResults={filtered && rows.length === 0}
      error={calls.error}
      errorCopy={{
        title: t("aiAdminUsage.calls.errorTitle"),
        description: t("aiAdminUsage.error.hint"),
      }}
      onRetry={() => void calls.refetch()}
      empty={{
        title: t("aiAdminUsage.calls.emptyTitle"),
        description: t("aiAdminUsage.calls.emptyHint"),
      }}
      actions={
        <div className="grid gap-2 sm:grid-cols-3">
          <FormField label={t("aiAdminUsage.calls.filters.channel")} required>
            <Select
              value={channel}
              onValueChange={(value) =>
                setChannel(value as AiChannel | typeof ALL)
              }
            >
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>
                  {t("aiAdminUsage.calls.filters.allChannels")}
                </SelectItem>
                {AI_CHANNELS.map((entry) => (
                  <SelectItem key={entry} value={entry}>
                    {t(channelKey(entry))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label={t("aiAdminUsage.calls.filters.outcome")} required>
            <Select
              value={outcome}
              onValueChange={(value) =>
                setOutcome(value as AiToolCallOutcome | typeof ALL)
              }
            >
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>
                  {t("aiAdminUsage.calls.filters.allOutcomes")}
                </SelectItem>
                {AI_TOOL_CALL_OUTCOMES.map((entry) => (
                  <SelectItem key={entry} value={entry}>
                    {t(outcomeKey(entry))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label={t("aiAdminUsage.calls.filters.tool")} required>
            <Select
              value={tool}
              onValueChange={(value) =>
                setTool(value as AiToolCode | typeof ALL)
              }
            >
              <SelectTrigger className="w-full sm:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>
                  {t("aiAdminUsage.calls.filters.allTools")}
                </SelectItem>
                {AI_TOOL_CATALOG.map((entry) => (
                  <SelectItem key={entry.code} value={entry.code}>
                    {entry.titleId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </div>
      }
    >
      <div className="hidden lg:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("aiAdminUsage.calls.columns.time")}</TableHead>
              <TableHead>{t("aiAdminUsage.calls.columns.tool")}</TableHead>
              <TableHead>{t("aiAdminUsage.calls.columns.channel")}</TableHead>
              <TableHead>{t("aiAdminUsage.calls.columns.user")}</TableHead>
              <TableHead>{t("aiAdminUsage.calls.columns.outcome")}</TableHead>
              <TableHead className="text-right">
                {t("aiAdminUsage.calls.columns.rows")}
              </TableHead>
              <TableHead>{t("aiAdminUsage.calls.columns.params")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="tabular whitespace-nowrap">
                  {formatMoment(row.occurredAt)}
                </TableCell>
                <TableCell>
                  <p className="font-semibold">{toolTitle(row.toolCode)}</p>
                  <p className="text-xs text-muted-foreground">
                    {row.toolCode}
                  </p>
                </TableCell>
                <TableCell>
                  {t(channelKey(row.channel))}
                  {row.channel === "mcp" && (
                    <p className="text-xs text-muted-foreground">
                      {clientOf(row)}
                    </p>
                  )}
                </TableCell>
                <TableCell>{userOf(row)}</TableCell>
                <TableCell>
                  <OutcomeBadge outcome={row.outcome} />
                  <p className="mt-0.5 text-xs text-muted-foreground tabular">
                    {t("aiAdminUsage.calls.duration", {
                      ms: formatNumber(row.durationMs),
                    })}
                  </p>
                </TableCell>
                <TableCell className="text-right tabular">
                  {formatNumber(row.rowCount)}
                </TableCell>
                <TableCell className="max-w-64">
                  <Params params={row.redactedParams} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ul className="divide-y divide-border lg:hidden">
        {rows.map((row) => (
          <li key={row.id} className="grid gap-2 p-card">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold">{toolTitle(row.toolCode)}</p>
                <p className="text-sm text-muted-foreground tabular">
                  {formatMoment(row.occurredAt)} · {t(channelKey(row.channel))}
                  {row.channel === "mcp" ? ` · ${clientOf(row)}` : ""}
                </p>
              </div>
              <OutcomeBadge outcome={row.outcome} />
            </div>
            <p className="text-sm text-muted-foreground tabular">
              {userOf(row)} ·{" "}
              {t("aiAdminUsage.calls.rows", {
                count: formatNumber(row.rowCount),
              })}{" "}
              ·{" "}
              {t("aiAdminUsage.calls.duration", {
                ms: formatNumber(row.durationMs),
              })}
            </p>
            <Params params={row.redactedParams} />
          </li>
        ))}
      </ul>

      {calls.hasNextPage && (
        <div className="border-t p-card">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="max-sm:h-11 max-sm:w-full"
            loading={calls.isFetchingNextPage}
            onClick={() => void calls.fetchNextPage()}
          >
            {t("aiAdminUsage.calls.loadMore")}
          </Button>
        </div>
      )}
    </DataTableShell>
  );
}

function Params({ params }: { params: ToolCall["redactedParams"] }) {
  const t = useT();
  const pairs = paramPairs(params);
  if (pairs.length === 0)
    return (
      <p className="text-xs text-muted-foreground">
        {t("aiAdminUsage.calls.noParams")}
      </p>
    );
  return (
    <dl className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
      {pairs.map((pair) => (
        <div key={pair.key} className="flex min-w-0 gap-1">
          <dt className="text-muted-foreground">{pair.key}:</dt>
          <dd className="min-w-0 break-all">{pair.value}</dd>
        </div>
      ))}
    </dl>
  );
}
