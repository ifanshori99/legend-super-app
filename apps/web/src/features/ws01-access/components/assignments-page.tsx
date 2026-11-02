// Role assignments: who holds which role, at which scope and until when
// (PRD v1.7 §3 F7; TEN-03 outlet scope). Granting needs a fresh second factor;
// ending records a reason.
import * as React from "react";
import {
  CircleCheck,
  CircleSlash,
  Clock,
  Info,
  Plus,
  UserMinus,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTableShell } from "@/components/ui/data-table-shell";
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
import type { RoleAssignment } from "@starter/shared/access";
import type { AreaAccess } from "@/lib/areas/access";
import { holdsAny } from "@/lib/areas/guard";
import { useAssignments, useNow, useRoles, useScopeLookup } from "../hooks";
import { useAssignablePeople } from "../people";
import {
  assignmentStatus,
  ASSIGNMENT_STATUS_LABEL_KEY,
  filterAssignmentRows,
  formatInstant,
  SCOPE_LABEL_KEY,
  scopeName,
  type AssignmentRow,
  type AssignmentStatus,
} from "../lib";
import { AccessPage } from "./access-shell";
import { EndAssignmentDialog } from "./end-assignment-dialog";
import { GrantRoleDialog } from "./grant-role-dialog";

const ALL = "all";

const STATUS_ICON: Record<AssignmentStatus, typeof CircleCheck> = {
  active: CircleCheck,
  scheduled: Clock,
  expired: CircleSlash,
};

const STATUS_TONE: Record<AssignmentStatus, "success" | "warning" | "neutral"> =
  {
    active: "success",
    scheduled: "warning",
    expired: "neutral",
  };

function StatusBadge({ status }: { status: AssignmentStatus }) {
  const t = useT();
  const Icon = STATUS_ICON[status];
  return (
    <Badge tone={STATUS_TONE[status]} className="whitespace-nowrap">
      <Icon aria-hidden="true" />
      {t(ASSIGNMENT_STATUS_LABEL_KEY[status])}
    </Badge>
  );
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

export function AssignmentsPage({ access }: { access: AreaAccess }) {
  const t = useT();
  const now = useNow();
  const roles = useRoles();
  const assignments = useAssignments({ limit: 100 });
  const people = useAssignablePeople();
  const canAssign = holdsAny(access, ["access.role.assign"]);
  const { lookup } = useScopeLookup({
    org: holdsAny(access, ["org.structure.manage"]),
    menu: holdsAny(access, ["menu.item.view"]),
  });

  const [search, setSearch] = React.useState("");
  const [roleId, setRoleId] = React.useState(ALL);
  const [status, setStatus] = React.useState(ALL);
  const [grantOpen, setGrantOpen] = React.useState(false);
  const [ending, setEnding] = React.useState<AssignmentRow | null>(null);

  const roleById = React.useMemo(
    () => new Map((roles.data?.data ?? []).map((row) => [row.id, row])),
    [roles.data],
  );
  const peopleByName = React.useMemo(
    () => new Map((people.data?.people ?? []).map((row) => [row.id, row.name])),
    [people.data],
  );

  const rows = React.useMemo<AssignmentRow[]>(
    () =>
      (assignments.data?.data ?? []).map((assignment) => ({
        assignment,
        role: roleById.get(assignment.roleId),
        personName: peopleByName.get(assignment.userId),
        status: assignmentStatus(assignment, now),
      })),
    [assignments.data, roleById, peopleByName, now],
  );

  const filtered = React.useMemo(
    () =>
      filterAssignmentRows(rows, {
        search,
        roleId: roleId === ALL ? undefined : roleId,
        status: status === ALL ? undefined : (status as AssignmentStatus),
      }),
    [rows, search, roleId, status],
  );

  const loading = assignments.isPending || roles.isPending;
  const failed = assignments.isError || roles.isError;
  const state = loading
    ? "loading"
    : failed
      ? "error"
      : (assignments.data?.data.length ?? 0) === 0
        ? "empty"
        : "ready";

  const personLabel = (row: RoleAssignment) =>
    peopleByName.get(row.userId) ??
    t("access.assignments.unknownUser", { id: shortId(row.userId) });

  const scopeLabel = (row: RoleAssignment) => {
    if (row.scope.type === "tenant") return t("access.assignments.scopeTenant");
    const name = scopeName(row.scope, lookup);
    const typeLabel = t(SCOPE_LABEL_KEY[row.scope.type]);
    return name ?? `${typeLabel} ${shortId(row.scope.id)}`;
  };

  return (
    <AccessPage
      active="assignments"
      actions={
        canAssign && (
          <Button type="button" onClick={() => setGrantOpen(true)}>
            <Plus aria-hidden="true" />
            {t("access.assignments.grant")}
          </Button>
        )
      }
    >
      {people.data?.unavailable && (
        <Card className="flex-row items-start gap-3">
          <Info
            className="mt-0.5 size-icon shrink-0 text-info"
            aria-hidden="true"
          />
          <div className="grid gap-1">
            <p className="text-sm font-semibold">
              {t("access.assignments.directoryMissing")}
            </p>
            <p className="text-sm text-muted-foreground">
              {t("access.assignments.directoryMissingHint")}
            </p>
          </div>
        </Card>
      )}

      <DataTableShell
        title={t("access.assignments.title")}
        description={t("access.assignments.description")}
        state={state}
        search={{
          value: search,
          onChange: setSearch,
          label: t("access.assignments.search"),
        }}
        actions={
          <div className="flex shrink-0 gap-2">
            <Select value={roleId} onValueChange={setRoleId}>
              <SelectTrigger
                className="h-control-sm sm:w-[10rem]"
                aria-label={t("access.assignments.filterRole")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>
                  {t("access.assignments.filterRole")}
                </SelectItem>
                {(roles.data?.data ?? []).map((row) => (
                  <SelectItem key={row.id} value={row.id}>
                    {row.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger
                className="h-control-sm sm:w-[10rem]"
                aria-label={t("access.assignments.filterStatus")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>
                  {t("access.assignments.filterStatus")}
                </SelectItem>
                {(["active", "scheduled", "expired"] as AssignmentStatus[]).map(
                  (value) => (
                    <SelectItem key={value} value={value}>
                      {t(ASSIGNMENT_STATUS_LABEL_KEY[value])}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </div>
        }
        noResults={state === "ready" && filtered.length === 0}
        onRetry={() => {
          void assignments.refetch();
          void roles.refetch();
        }}
        empty={{
          title: t("access.assignments.emptyTitle"),
          description: t("access.assignments.emptyHint"),
          action: canAssign && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setGrantOpen(true)}
            >
              <Plus aria-hidden="true" />
              {t("access.assignments.grant")}
            </Button>
          ),
        }}
        rowCount={filtered.length}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("access.assignments.columnUser")}</TableHead>
              <TableHead>{t("access.assignments.columnRole")}</TableHead>
              <TableHead className="hidden md:table-cell">
                {t("access.assignments.columnScope")}
              </TableHead>
              <TableHead className="hidden lg:table-cell">
                {t("access.assignments.columnValidity")}
              </TableHead>
              <TableHead>{t("access.assignments.columnStatus")}</TableHead>
              <TableHead className="w-20">
                <span className="sr-only">
                  {t("access.assignments.columnActions")}
                </span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((row) => (
              <TableRow key={row.assignment.id}>
                <TableCell>
                  <span className="grid gap-0.5">
                    <span className="font-semibold">
                      {personLabel(row.assignment)}
                    </span>
                    <span className="text-xs text-muted-foreground md:hidden">
                      {scopeLabel(row.assignment)}
                    </span>
                  </span>
                </TableCell>
                <TableCell>{row.role?.name ?? "—"}</TableCell>
                <TableCell className="hidden md:table-cell">
                  <span className="text-sm text-muted-foreground">
                    {scopeLabel(row.assignment)}
                  </span>
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  <span className="grid gap-0.5 text-sm">
                    <span>{formatInstant(row.assignment.validFrom)}</span>
                    <span className="text-muted-foreground">
                      {row.assignment.validUntil
                        ? formatInstant(row.assignment.validUntil)
                        : t("access.assignments.noEnd")}
                    </span>
                  </span>
                </TableCell>
                <TableCell>
                  <StatusBadge status={row.status} />
                </TableCell>
                <TableCell>
                  {canAssign && row.status !== "expired" && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${t("access.assignments.end")} ${personLabel(row.assignment)} — ${row.role?.name ?? ""}`}
                      onClick={() => setEnding(row)}
                    >
                      <UserMinus aria-hidden="true" />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataTableShell>

      <GrantRoleDialog
        open={grantOpen}
        onOpenChange={setGrantOpen}
        roles={roles.data?.data ?? []}
        people={people.data?.people ?? []}
        lookup={lookup}
        onGranted={() => setEnding(null)}
      />

      <EndAssignmentDialog
        assignmentId={ending?.assignment.id ?? null}
        label={
          ending
            ? `${personLabel(ending.assignment)} · ${ending.role?.name ?? ""}`
            : ""
        }
        open={ending !== null}
        onOpenChange={(open) => {
          if (!open) setEnding(null);
        }}
      />
    </AccessPage>
  );
}
