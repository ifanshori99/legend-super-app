// Detail panel of one audit row: who, what, when, where, why and the masked
// diff. Values come from `maskedChanges` and are redacted once more for
// display (lib.ts redactForDisplay); the viewer never prints a raw value.
import { ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { AuditEventView } from "../contract";
import { actionLabel, objectTypeLabel } from "../labels";
import {
  diffRows,
  formatDay,
  formatWhen,
  ipTrace,
  retainedUntil,
} from "../lib";
import { ActorBadge } from "./actor-badge";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 py-2.5 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm leading-5 break-words">{children}</dd>
    </div>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs break-all">{children}</span>;
}

export function AuditDetail({
  view,
  onClose,
}: {
  view: AuditEventView | null;
  onClose: () => void;
}) {
  return (
    <Sheet open={view !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="sm:w-[min(32rem,calc(100%-3rem))] sm:max-w-none"
      >
        {view && <DetailBody view={view} />}
      </SheetContent>
    </Sheet>
  );
}

function DetailBody({ view }: { view: AuditEventView }) {
  const t = useT();
  const { event } = view;
  const zone = view.outletTimeZone;
  const rows = diffRows(event.maskedChanges);
  const ip = ipTrace(event.ipHash);
  return (
    <>
      <SheetHeader>
        <SheetTitle>{t("auditSettings.audit.detail.title")}</SheetTitle>
        <SheetDescription>
          {t("auditSettings.audit.detail.description")}
        </SheetDescription>
      </SheetHeader>
      <dl className="divide-y divide-border">
        <Row label={t("auditSettings.audit.detail.who")}>
          <span className="flex flex-wrap items-center gap-2">
            <ActorBadge type={event.actorType} />
            <span className="font-medium">
              {view.actorName ?? t("auditSettings.audit.actor.unknownName")}
            </span>
          </span>
          {event.actorId && (
            <span className="mt-1 block">
              <Mono>{event.actorId}</Mono>
            </span>
          )}
        </Row>
        <Row label={t("auditSettings.audit.detail.what")}>
          <span className="font-medium">{actionLabel(t, event.action)}</span>
          <span className="mt-0.5 block">
            <Mono>{event.action}</Mono>
          </span>
        </Row>
        <Row label={t("auditSettings.audit.detail.object")}>
          {objectTypeLabel(t, event.objectType)}
          {event.objectId && (
            <span className="mt-0.5 block">
              <Mono>{event.objectId}</Mono>
            </span>
          )}
        </Row>
        <Row label={t("auditSettings.audit.detail.when")}>
          <span className="tabular">{formatWhen(event.createdAt, zone)}</span>
        </Row>
        <Row label={t("auditSettings.audit.detail.outlet")}>
          {view.outletName ?? t("auditSettings.audit.noOutlet")}
        </Row>
        <Row label={t("auditSettings.audit.detail.device")}>
          {view.deviceName ?? t("auditSettings.audit.noDevice")}
          {event.deviceId && (
            <span className="mt-0.5 block">
              <Mono>{event.deviceId}</Mono>
            </span>
          )}
        </Row>
        <Row label={t("auditSettings.audit.detail.ip")}>
          {ip === null ? (
            t("auditSettings.audit.detail.ipNone")
          ) : (
            <>
              <Mono>
                {t("auditSettings.audit.detail.ipValue", { hash: ip })}
              </Mono>
              <span className="mt-0.5 block text-muted-foreground">
                {t("auditSettings.audit.detail.ipHint")}
              </span>
            </>
          )}
        </Row>
        <Row label={t("auditSettings.audit.detail.reason")}>
          {event.reason ?? (
            <span className="text-muted-foreground">
              {t("auditSettings.audit.detail.reasonNone")}
            </span>
          )}
        </Row>
        <Row label={t("auditSettings.audit.detail.sensitiveAccess")}>
          {event.sensitiveAccess ? (
            <Badge tone="warning">
              <ShieldAlert aria-hidden="true" />
              {t("auditSettings.audit.detail.sensitiveYes")}
            </Badge>
          ) : (
            t("auditSettings.audit.detail.sensitiveNo")
          )}
        </Row>
        <Row label={t("auditSettings.audit.detail.retention")}>
          <span className="tabular">
            {formatDay(retainedUntil(event.createdAt), zone)}
          </span>
        </Row>
        <Row label={t("auditSettings.audit.detail.eventId")}>
          <Mono>{event.id}</Mono>
        </Row>
      </dl>
      <section aria-labelledby="audit-changes-title" className="grid gap-2">
        <h3 id="audit-changes-title" className="type-title">
          {t("auditSettings.audit.detail.changes")}
        </h3>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("auditSettings.audit.detail.noChanges")}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-container border-(length:--border-w)">
            <table className="w-full min-w-[22rem] text-left text-sm">
              <thead className="bg-surface-2 text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {t("auditSettings.audit.detail.changes")}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {t("auditSettings.audit.detail.before")}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {t("auditSettings.audit.detail.after")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => (
                  <tr key={row.field}>
                    <th
                      scope="row"
                      className="px-3 py-2 align-top font-mono text-xs font-medium"
                    >
                      {row.field}
                    </th>
                    <DiffCell value={row.before} redacted={row.redacted} />
                    <DiffCell value={row.after} redacted={row.redacted} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function DiffCell({
  value,
  redacted,
}: {
  value: string | null;
  redacted: boolean;
}) {
  const t = useT();
  return (
    <td className="px-3 py-2 align-top break-words tabular">
      {value === null ? (
        <span className="text-muted-foreground">
          {t("auditSettings.audit.detail.empty")}
        </span>
      ) : redacted && value === "[REDACTED]" ? (
        <Badge tone="neutral">{t("auditSettings.audit.detail.redacted")}</Badge>
      ) : (
        value
      )}
    </td>
  );
}
