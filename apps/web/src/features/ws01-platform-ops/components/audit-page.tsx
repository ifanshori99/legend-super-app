// /platform/audit — cross-tenant audit list (PRD v1.7 §3 F4 Super Admin,
// §6 audit_log: immutable, masked, kept 2 years). Filters: tenant, actor
// kind, action, date range (Asia/Jakarta days). Cursor pagination appends
// pages; a row expands to its masked before/after, reason and ids.
import * as React from "react";
import { ChevronDown, ChevronRight, FileClock } from "lucide-react";
import type { AuditEvent } from "@starter/shared/audit";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTableShell } from "@/components/ui/data-table-shell";
import { EmptyState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
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
  useAuditEvents,
  useDebounced,
  useTenants,
  type AuditFilters,
} from "../hooks";
import { PLATFORM_AUDIT_AVAILABLE } from "../contract-gap";
import { changeRows, formatWhen, jakartaDayRange, shortId } from "../logic";
import { OpsPage, Section } from "./ops-shell";

const ALL = "all";
const ACTOR_TYPES = ["user", "ai", "mcp_client", "system", "device"] as const;

export function AuditPage() {
  const t = useT();
  // Contract gap (contract-gap.ts #1): say so instead of a generic error.
  if (!PLATFORM_AUDIT_AVAILABLE)
    return (
      <OpsPage>
        <Section title={t("platformOps.audit.title")}>
          <EmptyState
            icon={FileClock}
            title={t("platformOps.audit.unavailableTitle")}
            description={t("platformOps.audit.unavailableHint")}
          />
        </Section>
      </OpsPage>
    );
  return <AuditList />;
}

function AuditList() {
  const t = useT();
  const tenants = useTenants();
  const tenantRows = tenants.data?.data ?? [];
  const [tenantId, setTenantId] = React.useState(ALL);
  const [actorType, setActorType] = React.useState(ALL);
  const [action, setAction] = React.useState("");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [open, setOpen] = React.useState<string | null>(null);
  const debouncedAction = useDebounced(action.trim());

  const filters = React.useMemo<AuditFilters>(() => {
    const out: AuditFilters = {};
    if (tenantId !== ALL) out.tenantId = tenantId as AuditFilters["tenantId"];
    if (actorType !== ALL)
      out.actorType = actorType as AuditFilters["actorType"];
    if (debouncedAction) out.action = debouncedAction;
    return { ...out, ...jakartaDayRange(from, to) };
  }, [tenantId, actorType, debouncedAction, from, to]);
  const filtered = Object.keys(filters).length > 0;
  const rangeInvalid = from !== "" && to !== "" && from > to;

  const audit = useAuditEvents(filters);
  const events = audit.data?.pages.flatMap((page) => page.data) ?? [];
  const state = audit.isPending
    ? "loading"
    : audit.isError
      ? "error"
      : events.length === 0
        ? "empty"
        : "ready";
  const nameOf = (id: string) =>
    tenantRows.find((row) => row.id === id)?.name ?? shortId(id);

  const clear = () => {
    setTenantId(ALL);
    setActorType(ALL);
    setAction("");
    setFrom("");
    setTo("");
  };

  return (
    <OpsPage>
      <Section
        title={t("platformOps.audit.filterTitle")}
        actions={
          filtered ? (
            <Button variant="outline" size="sm" onClick={clear}>
              {t("platformOps.audit.clear")}
            </Button>
          ) : undefined
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <FormField label={t("platformOps.audit.filterTenant")}>
            <Select value={tenantId} onValueChange={setTenantId}>
              <SelectTrigger
                className="h-control-sm"
                aria-label={t("platformOps.audit.filterTenant")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>
                  {t("platformOps.audit.allTenants")}
                </SelectItem>
                {tenantRows.map((row) => (
                  <SelectItem key={row.id} value={row.id}>
                    {row.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label={t("platformOps.audit.filterActor")}>
            <Select value={actorType} onValueChange={setActorType}>
              <SelectTrigger
                className="h-control-sm"
                aria-label={t("platformOps.audit.filterActor")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>
                  {t("platformOps.audit.allActors")}
                </SelectItem>
                {ACTOR_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {t(`platformOps.audit.actors.${type}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label={t("platformOps.audit.filterAction")}>
            <Input
              type="search"
              value={action}
              onChange={(event) => setAction(event.target.value)}
              placeholder={t("platformOps.audit.actionPlaceholder")}
              className="h-control-sm"
              autoComplete="off"
            />
          </FormField>
          <FormField label={t("platformOps.audit.filterFrom")}>
            <Input
              type="date"
              value={from}
              max={to || undefined}
              onChange={(event) => setFrom(event.target.value)}
              className="h-control-sm"
            />
          </FormField>
          <FormField
            label={t("platformOps.audit.filterTo")}
            error={rangeInvalid ? t("platformOps.audit.rangeError") : undefined}
          >
            <Input
              type="date"
              value={to}
              min={from || undefined}
              onChange={(event) => setTo(event.target.value)}
              className="h-control-sm"
            />
          </FormField>
        </div>
      </Section>

      <DataTableShell
        title={t("platformOps.audit.title")}
        description={t("platformOps.audit.description")}
        state={state}
        onRetry={() => void audit.refetch()}
        empty={{
          title: t(
            filtered
              ? "platformOps.audit.emptyFilteredTitle"
              : "platformOps.audit.emptyTitle",
          ),
          description: t(
            filtered
              ? "platformOps.audit.emptyFilteredHint"
              : "platformOps.audit.emptyHint",
          ),
        }}
        rowCount={events.length}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">
                <span className="sr-only">{t("platformOps.audit.detail")}</span>
              </TableHead>
              <TableHead>{t("platformOps.audit.columnWhen")}</TableHead>
              <TableHead className="hidden md:table-cell">
                {t("platformOps.audit.columnTenant")}
              </TableHead>
              <TableHead className="hidden sm:table-cell">
                {t("platformOps.audit.columnActor")}
              </TableHead>
              <TableHead>{t("platformOps.audit.columnAction")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map((event) => (
              <AuditRows
                key={event.id}
                event={event}
                tenantName={nameOf(event.tenantId)}
                expanded={open === event.id}
                onToggle={() =>
                  setOpen((current) => (current === event.id ? null : event.id))
                }
              />
            ))}
          </TableBody>
        </Table>
        {audit.hasNextPage && (
          <div className="flex justify-center border-t p-3">
            <Button
              variant="outline"
              loading={audit.isFetchingNextPage}
              onClick={() => void audit.fetchNextPage()}
            >
              {t("platformOps.audit.loadMore")}
            </Button>
          </div>
        )}
      </DataTableShell>
    </OpsPage>
  );
}

function AuditRows({
  event,
  tenantName,
  expanded,
  onToggle,
}: {
  event: AuditEvent;
  tenantName: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const detailId = `audit-detail-${event.id}`;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <>
      <TableRow data-expanded={expanded || undefined}>
        <TableCell>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-expanded={expanded}
            aria-controls={detailId}
            aria-label={t(
              expanded
                ? "platformOps.audit.collapse"
                : "platformOps.audit.expand",
              { action: event.action },
            )}
            onClick={onToggle}
          >
            <Chevron aria-hidden="true" />
          </Button>
        </TableCell>
        <TableCell className="tabular whitespace-nowrap">
          {formatWhen(event.createdAt)}
        </TableCell>
        <TableCell className="hidden md:table-cell">{tenantName}</TableCell>
        <TableCell className="hidden sm:table-cell">
          <span className="font-medium">
            {t(`platformOps.audit.actors.${event.actorType}`)}
          </span>
          {event.actorId && (
            <span className="ml-1.5 text-xs text-muted-foreground">
              {shortId(event.actorId)}
            </span>
          )}
        </TableCell>
        <TableCell>
          <span className="font-semibold break-all">{event.action}</span>
          {event.sensitiveAccess && (
            <Badge tone="warning" className="ml-2">
              {t("platformOps.audit.sensitive")}
            </Badge>
          )}
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow id={detailId} className="bg-surface-2 hover:bg-surface-2">
          <TableCell colSpan={5}>
            <AuditDetail event={event} tenantName={tenantName} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function AuditDetail({
  event,
  tenantName,
}: {
  event: AuditEvent;
  tenantName: string;
}) {
  const t = useT();
  const changes = changeRows(event.maskedChanges);
  const facts: [string, string][] = [
    [t("platformOps.audit.columnTenant"), tenantName],
    [
      t("platformOps.audit.columnActor"),
      `${t(`platformOps.audit.actors.${event.actorType}`)}${event.actorId ? ` · ${event.actorId}` : ""}`,
    ],
    [
      t("platformOps.audit.object"),
      `${event.objectType}${event.objectId ? ` · ${event.objectId}` : ""}`,
    ],
    [
      t("platformOps.audit.reason"),
      event.reason ?? t("platformOps.audit.none"),
    ],
    [
      t("platformOps.audit.outlet"),
      event.outletId ?? t("platformOps.audit.none"),
    ],
    [
      t("platformOps.audit.ipHash"),
      event.ipHash ?? t("platformOps.audit.notRecorded"),
    ],
    [t("platformOps.audit.eventId"), event.id],
  ];
  return (
    <div className="grid gap-4 py-1">
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {facts.map(([term, value]) => (
          <div key={term} className="grid min-w-0 gap-0.5">
            <dt className="type-eyebrow text-muted-foreground">{term}</dt>
            <dd className="break-all">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="grid gap-1.5">
        <p className="type-eyebrow text-muted-foreground">
          {t("platformOps.audit.changes")}
        </p>
        {changes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("platformOps.audit.noChanges")}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-control border-(length:--border-w) bg-card">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th scope="col" className="px-3 py-1.5 font-medium">
                    {t("platformOps.audit.field")}
                  </th>
                  <th scope="col" className="px-3 py-1.5 font-medium">
                    {t("platformOps.audit.before")}
                  </th>
                  <th scope="col" className="px-3 py-1.5 font-medium">
                    {t("platformOps.audit.after")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {changes.map((row) => (
                  <tr key={row.field} className="border-b last:border-0">
                    <th scope="row" className="px-3 py-1.5 font-medium">
                      {row.field || t("platformOps.audit.value")}
                    </th>
                    <td className="px-3 py-1.5 break-all">
                      {row.before || t("platformOps.audit.none")}
                    </td>
                    <td className="px-3 py-1.5 break-all">
                      {row.after || t("platformOps.audit.none")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
