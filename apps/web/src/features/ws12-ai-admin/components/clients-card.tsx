// MCP clients: a table on desktop that becomes stacked cards on a phone.
// Pending clients get "Setujui klien" (scopes dialog); approved clients get
// "Cabut semua token" (Q11 dialog). "Kelola klien" opens the full list with
// revoked clients too.
import * as React from "react";
import { Ban, CircleCheck, Clock } from "lucide-react";
import type { McpClient, McpTokenSummary } from "@starter/shared/ai";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { API_MOCK } from "@/lib/api/mock-flag";
import { capitalizeFirst, lastUsedParts } from "../format";
import { useMcpClients, useTenantTokens } from "../hooks";
import { clientLastUsedAt, clientRevokeImpact, scopeSummary } from "../logic";
import { ApproveClientDialog } from "./approve-client-dialog";
import { RevokeClientDialog } from "./revoke-client-dialog";
import { AdminCard, isOfflineError, plain } from "./shared";

const MAX_SCOPES_SHOWN = 4;

export function ClientsCard() {
  const t = useT();
  const clients = useMcpClients(true);
  const tokens = useTenantTokens(true);
  const [revokeTarget, setRevokeTarget] = React.useState<McpClient | null>(
    null,
  );
  const [approveTarget, setApproveTarget] = React.useState<McpClient | null>(
    null,
  );
  const [manageOpen, setManageOpen] = React.useState(false);
  const autoOpened = React.useRef(false);

  const list = clients.data?.data;

  // Mock mode only: ?state=revoke opens the revoke dialog (design review).
  React.useEffect(() => {
    if (
      !API_MOCK ||
      autoOpened.current ||
      list === undefined ||
      tokens.data === undefined
    )
      return;
    if (new URLSearchParams(window.location.search).get("state") !== "revoke")
      return;
    autoOpened.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mock-only design-review hook: the query string is browser-only and the clients load asynchronously, so opening once after both are ready is the point.
    setRevokeTarget(
      list.find((client) => client.status === "approved") ?? null,
    );
  }, [list, tokens.data]);

  const now = new Date();
  const tokenList = tokens.data;
  const impactFor = (client: McpClient | null) =>
    client === null || tokenList === undefined
      ? null
      : clientRevokeImpact(tokenList, client.id, now);

  const body = () => {
    if (clients.isPending) return <ClientsSkeleton />;
    if (clients.isError || list === undefined) {
      const offline = isOfflineError(clients.error);
      return (
        <ErrorState
          error={clients.error}
          title={t(
            offline
              ? "aiAdmin.error.offlineTitle"
              : "aiAdmin.clients.errorTitle",
          )}
          description={t(
            offline ? "aiAdmin.error.offlineHint" : "aiAdmin.clients.errorHint",
          )}
          onRetry={() => void clients.refetch()}
        />
      );
    }
    const visible = list.filter((client) => client.status !== "revoked");
    if (visible.length === 0)
      return (
        <EmptyState
          title={t("aiAdmin.clients.emptyTitle")}
          description={t("aiAdmin.clients.emptyHint")}
        />
      );
    return (
      <ClientList
        clients={visible}
        tokens={tokenList}
        tokensFailed={tokens.isError}
        now={now}
        onRevoke={setRevokeTarget}
        onApprove={setApproveTarget}
      />
    );
  };

  return (
    <AdminCard aria-labelledby="ai-clients-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h2 id="ai-clients-title" className="type-title">
            {t("aiAdmin.clients.title")}
          </h2>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("aiAdmin.clients.description")}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => setManageOpen(true)}
          disabled={list === undefined}
        >
          {t("aiAdmin.clients.manage")}
        </Button>
      </div>

      {body()}

      <p className="text-sm leading-5 text-muted-foreground">
        {API_MOCK && `${t("common.sampleData")} · `}
        {t("aiAdmin.clients.footnote")}
      </p>

      <Sheet open={manageOpen} onOpenChange={setManageOpen}>
        <SheetContent side="right" className="w-[min(36rem,calc(100%-1.5rem))]">
          <SheetHeader className="pr-10">
            <SheetTitle>{t("aiAdmin.clients.sheetTitle")}</SheetTitle>
            <SheetDescription>
              {t("aiAdmin.clients.sheetDescription")}
            </SheetDescription>
          </SheetHeader>
          {list !== undefined && (
            <ClientCards
              clients={list}
              tokens={tokenList}
              tokensFailed={tokens.isError}
              now={now}
              onRevoke={(client) => {
                setManageOpen(false);
                setRevokeTarget(client);
              }}
              onApprove={(client) => {
                setManageOpen(false);
                setApproveTarget(client);
              }}
            />
          )}
        </SheetContent>
      </Sheet>

      <RevokeClientDialog
        client={revokeTarget}
        impact={impactFor(revokeTarget)}
        onClose={() => setRevokeTarget(null)}
      />
      <ApproveClientDialog
        client={approveTarget}
        onClose={() => setApproveTarget(null)}
      />
    </AdminCard>
  );
}

type RowProps = {
  clients: McpClient[];
  tokens: McpTokenSummary[] | undefined;
  tokensFailed: boolean;
  now: Date;
  onRevoke: (client: McpClient) => void;
  onApprove: (client: McpClient) => void;
};

function ClientList(props: RowProps) {
  const t = useT();
  return (
    <>
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("aiAdmin.clients.columnClient")}</TableHead>
              <TableHead>{t("aiAdmin.clients.columnScopes")}</TableHead>
              <TableHead>{t("aiAdmin.clients.columnStatus")}</TableHead>
              <TableHead>{t("aiAdmin.clients.columnActions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.clients.map((client) => (
              <TableRow key={client.id}>
                <TableCell className="min-w-44 align-top">
                  <ClientName client={client} {...props} />
                </TableCell>
                <TableCell className="align-top">
                  <ScopesText client={client} />
                </TableCell>
                <TableCell className="align-top">
                  <StatusBadge client={client} />
                </TableCell>
                <TableCell className="align-top">
                  <ClientAction client={client} {...props} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="md:hidden">
        <ClientCards {...props} />
      </div>
    </>
  );
}

function ClientCards(props: RowProps) {
  return (
    <ul className="grid divide-y divide-border">
      {props.clients.map((client) => (
        <li key={client.id} className="grid gap-2 py-3 first:pt-0">
          <ClientName client={client} {...props} />
          <ScopesText client={client} />
          <StatusBadge client={client} />
          <ClientAction client={client} {...props} />
        </li>
      ))}
    </ul>
  );
}

function ClientName({
  client,
  tokens,
  tokensFailed,
  now,
}: { client: McpClient } & RowProps) {
  const t = useT();
  let detail: string;
  if (client.status === "pending") detail = t("aiAdmin.clients.neverUsed");
  else if (client.status === "revoked" && client.revokedAt)
    detail = t("aiAdmin.clients.revokedOn", {
      date: lastUsedParts(client.revokedAt, now).date,
    });
  else if (tokens === undefined)
    detail = tokensFailed ? t("aiAdmin.clients.tokensUnknown") : "…";
  else {
    const { activeTokens } = clientRevokeImpact(tokens, client.id, now);
    const last = clientLastUsedAt(tokens, client.id, now);
    const count =
      activeTokens === 0
        ? t("aiAdmin.clients.tokensNone")
        : t("aiAdmin.clients.tokensCount", { count: activeTokens });
    if (last === null) detail = `${count} · ${t("aiAdmin.clients.neverUsed")}`;
    else {
      const parts = lastUsedParts(last, now);
      const when =
        parts.day === "today"
          ? t("aiAdmin.clients.lastUsedToday", { time: parts.time })
          : parts.day === "yesterday"
            ? t("aiAdmin.clients.lastUsedYesterday", { time: parts.time })
            : t("aiAdmin.clients.lastUsedOn", { date: parts.date });
      detail = `${count} · ${when}`;
    }
  }
  return (
    <div className="grid gap-0.5">
      <span className="text-base leading-6 font-semibold break-words">
        {client.name}
      </span>
      <span className="text-sm leading-5 text-muted-foreground">{detail}</span>
    </div>
  );
}

function ScopesText({ client }: { client: McpClient }) {
  const t = useT();
  const items = scopeSummary(client.allowedScopes).map((item) => {
    const label = t(`aiAdmin.scopeDomain.${item.domain}` as MessageKey);
    return item.draft
      ? t("aiAdmin.clients.scopeDraft", { scope: label })
      : label;
  });
  const shown = items.slice(0, MAX_SCOPES_SHOWN);
  const more = items.length - shown.length;
  return (
    <span className="text-base leading-6">
      {capitalizeFirst(shown.join(", "))}
      {more > 0 && (
        <span className="text-muted-foreground">
          {" "}
          {t("aiAdmin.clients.scopeMore", { count: more })}
        </span>
      )}
    </span>
  );
}

function StatusBadge({ client }: { client: McpClient }) {
  const t = useT();
  if (client.status === "approved")
    return (
      <Badge tone="success">
        <CircleCheck aria-hidden="true" />
        {t("aiAdmin.clients.statusApproved")}
      </Badge>
    );
  if (client.status === "pending")
    return (
      <Badge tone="warning">
        <Clock aria-hidden="true" />
        {t("aiAdmin.clients.statusPending")}
      </Badge>
    );
  return (
    <Badge tone="neutral">
      <Ban aria-hidden="true" />
      {t("aiAdmin.clients.statusRevoked")}
    </Badge>
  );
}

function ClientAction({
  client,
  onRevoke,
  onApprove,
}: { client: McpClient } & RowProps) {
  const t = useT();
  if (client.status === "approved")
    return (
      <Button
        variant="ghost"
        className="-ml-2 justify-start text-danger md:ml-0"
        aria-label={t("aiAdmin.clients.revokeActionFor", {
          client: plain(client.name),
        })}
        onClick={() => onRevoke(client)}
      >
        {t("aiAdmin.clients.revokeAction")}
      </Button>
    );
  if (client.status === "pending")
    return (
      <Button
        variant="outline"
        aria-label={t("aiAdmin.clients.approveActionFor", {
          client: plain(client.name),
        })}
        onClick={() => onApprove(client)}
      >
        {t("aiAdmin.clients.approveAction")}
      </Button>
    );
  return null;
}

function ClientsSkeleton() {
  return (
    <div className="grid gap-3" aria-busy="true">
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}
