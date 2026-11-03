// The audit rows: one tappable row per event (who / what / when / where). Rows
// are buttons so the detail opens by keyboard; their accessible name is the
// row's own text (when, who, what, where), not just the action. Wide screens
// lay the four facts side by side, phones stack them. The row whose detail is
// open is selected: primary tint + 2px start rule (DESIGN.md Q29).
import { cn } from "cn";
import { ChevronRight, Monitor, ShieldAlert, Store } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import type { AuditEventView } from "@starter/shared/audit";
import { actionLabel, objectTypeLabel } from "../labels";
import { formatWhen } from "../lib";
import { ActorBadge } from "./actor-badge";

export function AuditList({
  rows,
  selectedId = null,
  onOpen,
}: {
  rows: readonly AuditEventView[];
  selectedId?: string | null;
  onOpen: (view: AuditEventView) => void;
}) {
  const t = useT();
  return (
    <>
      {/* Column captions for the wide layout; the phone layout labels by content. */}
      <div
        aria-hidden="true"
        className="hidden border-b border-border bg-surface-2 px-4 py-2 text-xs font-medium text-muted-foreground lg:grid lg:grid-cols-[10rem_minmax(0,1.1fr)_minmax(0,1.4fr)_minmax(0,1.1fr)_1rem] lg:gap-4"
      >
        <span>{t("auditSettings.audit.columns.when")}</span>
        <span>{t("auditSettings.audit.columns.who")}</span>
        <span>{t("auditSettings.audit.columns.what")}</span>
        <span>{t("auditSettings.audit.columns.where")}</span>
        <span />
      </div>
      <ul
        aria-label={t("auditSettings.audit.listLabel")}
        className="divide-y divide-border"
      >
        {rows.map((view) => {
          const { event } = view;
          const action = actionLabel(t, event.action);
          const selected = event.id === selectedId;
          return (
            <li key={event.id}>
              <button
                type="button"
                onClick={() => onOpen(view)}
                aria-haspopup="dialog"
                aria-current={selected ? "true" : undefined}
                className={cn(
                  "grid w-full min-w-0 gap-1.5 px-4 py-3 text-left transition-colors duration-(--duration-fast) hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring lg:grid-cols-[10rem_minmax(0,1.1fr)_minmax(0,1.4fr)_minmax(0,1.1fr)_1rem] lg:items-center lg:gap-4",
                  selected &&
                    "bg-primary-tint shadow-[inset_2px_0_0_var(--primary)] hover:bg-primary-tint",
                )}
              >
                <span className="text-sm text-muted-foreground tabular">
                  {formatWhen(event.createdAt, view.outletTimeZone)}
                </span>
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <ActorBadge type={event.actorType} />
                  <span className="min-w-0 text-sm font-medium break-words">
                    {view.actorName ??
                      (event.actorType === "system"
                        ? null
                        : t("auditSettings.audit.actor.unknownName"))}
                  </span>
                </span>
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{action}</span>
                    {event.sensitiveAccess && (
                      <Badge tone="warning">
                        <ShieldAlert aria-hidden="true" />
                        {t("auditSettings.audit.sensitive")}
                      </Badge>
                    )}
                  </span>
                  <span className="block truncate text-sm text-muted-foreground">
                    {objectTypeLabel(t, event.objectType)} ·{" "}
                    <span className="font-mono text-xs">{event.action}</span>
                  </span>
                </span>
                <span className="grid min-w-0 gap-0.5 text-sm text-muted-foreground">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Store className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="truncate">
                      {view.outletName ?? t("auditSettings.audit.noOutlet")}
                    </span>
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Monitor className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="truncate">
                      {view.deviceName ?? t("auditSettings.audit.noDevice")}
                    </span>
                  </span>
                </span>
                <ChevronRight
                  className="hidden size-4 text-muted-foreground lg:block"
                  aria-hidden="true"
                />
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
