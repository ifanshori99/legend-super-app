// Status pills for the equipment registry and handover (DESIGN.md §4: a status
// is always icon + text, never color alone; the solid fill is reserved for the
// state that needs action now, Q25).
import { Archive, CircleAlert, Clock, Wrench } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import {
  EQUIPMENT_STATUS_KEYS,
  HANDOVER_STATUS_KEYS,
  TICKET_STATUS_KEYS,
  URGENCY_KEYS,
} from "../lib.ts";
import type {
  EquipmentStatus,
  MaintenanceTicketStatus,
  MaintenanceUrgency,
  ShiftHandoverStatus,
} from "@starter/shared/operations";

export function EquipmentStatusPill({ status }: { status: EquipmentStatus }) {
  const t = useT();
  if (status === "retired")
    return (
      <Badge tone="neutral">
        <Archive aria-hidden="true" />
        {t(EQUIPMENT_STATUS_KEYS[status])}
      </Badge>
    );
  const kind =
    status === "operational"
      ? "success"
      : status === "under_maintenance"
        ? "warning"
        : "danger";
  return (
    <StatusPill
      status={kind}
      icon={status === "under_maintenance" ? Wrench : undefined}
      solid={status === "broken"}
    >
      {t(EQUIPMENT_STATUS_KEYS[status])}
    </StatusPill>
  );
}

export function UrgencyPill({ urgency }: { urgency: MaintenanceUrgency }) {
  const t = useT();
  if (urgency === "critical")
    return (
      <StatusPill status="danger" solid icon={CircleAlert}>
        {t(URGENCY_KEYS[urgency])}
      </StatusPill>
    );
  const tone =
    urgency === "high"
      ? "danger"
      : urgency === "medium"
        ? "warning"
        : "neutral";
  return (
    <Badge tone={tone}>
      {urgency === "high" ? (
        <CircleAlert aria-hidden="true" />
      ) : (
        <Clock aria-hidden="true" />
      )}
      {t(URGENCY_KEYS[urgency])}
    </Badge>
  );
}

export function TicketStatusPill({
  status,
}: {
  status: MaintenanceTicketStatus;
}) {
  const t = useT();
  if (status === "cancelled")
    return <Badge tone="neutral">{t(TICKET_STATUS_KEYS[status])}</Badge>;
  const kind =
    status === "reported"
      ? "info"
      : status === "in_progress"
        ? "warning"
        : "success";
  return (
    <StatusPill
      status={kind}
      icon={status === "in_progress" ? Wrench : undefined}
    >
      {t(TICKET_STATUS_KEYS[status])}
    </StatusPill>
  );
}

export function HandoverStatusPill({
  status,
}: {
  status: ShiftHandoverStatus;
}) {
  const t = useT();
  return (
    <StatusPill
      status={status === "acknowledged" ? "success" : "warning"}
      icon={status === "submitted" ? Clock : undefined}
    >
      {t(HANDOVER_STATUS_KEYS[status])}
    </StatusPill>
  );
}
