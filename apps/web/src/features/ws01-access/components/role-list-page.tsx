// Roles list (PRD v1.7 §3 F7 "Template Role" + "Custom Role"): search, kind
// filter, and a row per tenant role. A template row opens read-only; a custom
// row opens the editor.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Plus, Users } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import type { AreaAccess } from "@/lib/areas/access";
import { holdsAny } from "@/lib/areas/guard";
import { useAssignments, useNow, useRoles } from "../hooks";
import {
  activeHolderCounts,
  filterRoles,
  roleKind,
  SCOPE_LABEL_KEY,
  type RoleKind,
} from "../lib";
import { AccessPage } from "./access-shell";

const ALL = "all";

export function RoleListPage({ access }: { access: AreaAccess }) {
  const t = useT();
  const [search, setSearch] = React.useState("");
  const [kind, setKind] = React.useState<string>(ALL);
  const now = useNow();
  const roles = useRoles();
  const assignments = useAssignments({ limit: 100 });

  const canManage = holdsAny(access, ["access.role.manage"]);
  const loading = roles.isPending || assignments.isPending;
  const failed = roles.isError || assignments.isError;

  const rows = React.useMemo(() => {
    const all = roles.data?.data ?? [];
    return filterRoles(all, {
      search,
      kind: kind === ALL ? undefined : (kind as RoleKind),
    });
  }, [roles.data, search, kind]);

  const holders = React.useMemo(
    () => activeHolderCounts(assignments.data?.data ?? [], now),
    [assignments.data, now],
  );

  const state = loading
    ? "loading"
    : failed
      ? "error"
      : (roles.data?.data.length ?? 0) === 0
        ? "empty"
        : "ready";

  return (
    <AccessPage
      active="roles"
      actions={
        canManage && (
          <Button asChild>
            <Link to="/kelola/akses/baru">
              <Plus aria-hidden="true" />
              {t("access.roles.create")}
            </Link>
          </Button>
        )
      }
    >
      <DataTableShell
        title={t("access.roles.title")}
        description={t("access.roles.description")}
        state={state}
        search={{
          value: search,
          onChange: setSearch,
          label: t("access.roles.searchPlaceholder"),
        }}
        actions={
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger
              className="h-control-sm sm:w-44"
              aria-label={t("access.roles.columnType")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("access.roles.filterAll")}</SelectItem>
              <SelectItem value="template">
                {t("access.roles.filterTemplate")}
              </SelectItem>
              <SelectItem value="custom">
                {t("access.roles.filterCustom")}
              </SelectItem>
            </SelectContent>
          </Select>
        }
        noResults={state === "ready" && rows.length === 0}
        onRetry={() => {
          void roles.refetch();
          void assignments.refetch();
        }}
        empty={{
          title: t("access.roles.emptyTitle"),
          description: t("access.roles.emptyHint"),
        }}
        rowCount={rows.length}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("access.roles.columnName")}</TableHead>
              <TableHead className="hidden sm:table-cell">
                {t("access.roles.columnType")}
              </TableHead>
              <TableHead className="hidden md:table-cell">
                {t("access.roles.columnScope")}
              </TableHead>
              <TableHead numeric>
                {t("access.roles.columnPermissions")}
              </TableHead>
              <TableHead className="hidden sm:table-cell">
                {t("access.roles.columnMfa")}
              </TableHead>
              <TableHead numeric className="hidden sm:table-cell">
                {t("access.roles.columnHolders")}
              </TableHead>
              <TableHead className="w-12">
                <span className="sr-only">{t("access.roles.open")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((role) => (
              <TableRow key={role.id}>
                <TableCell>
                  <Link
                    to="/kelola/akses/role/$roleId"
                    params={{ roleId: role.id }}
                    className="grid gap-0.5 font-semibold hover:underline"
                  >
                    <span>{role.name}</span>
                    <span className="text-xs font-normal text-muted-foreground sm:hidden">
                      {t(
                        roleKind(role) === "template"
                          ? "access.roles.kindTemplate"
                          : "access.roles.kindCustom",
                      )}
                    </span>
                  </Link>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <Badge
                    tone={role.isTemplate ? "neutral" : "brand"}
                    className="whitespace-nowrap"
                  >
                    {t(
                      role.isTemplate
                        ? "access.roles.kindTemplate"
                        : "access.roles.kindCustom",
                    )}
                  </Badge>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <span className="text-sm text-muted-foreground">
                    {role.allowedScopeTypes
                      .map((type) => t(SCOPE_LABEL_KEY[type]))
                      .join(" · ")}
                  </span>
                </TableCell>
                <TableCell numeric>
                  {t("access.roles.permissionCount", {
                    count: role.permissions.length,
                  })}
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <Badge
                    tone={role.mfaRequired ? "success" : "neutral"}
                    className="whitespace-nowrap"
                  >
                    {t(
                      role.mfaRequired
                        ? "access.roles.mfaRequired"
                        : "access.roles.mfaOptional",
                    )}
                  </Badge>
                </TableCell>
                <TableCell numeric className="hidden sm:table-cell">
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <Users className="size-3.5" aria-hidden="true" />
                    {holders.get(role.id) ?? 0}
                  </span>
                </TableCell>
                <TableCell>
                  <Button
                    asChild
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("access.roles.open")}
                  >
                    <Link
                      to="/kelola/akses/role/$roleId"
                      params={{ roleId: role.id }}
                    >
                      <ChevronRight aria-hidden="true" />
                    </Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataTableShell>
    </AccessPage>
  );
}
