// Permission catalog UI for the role screens (PRD §3.7 "Custom Role — dari
// katalog izin"). One checklist for the editor, one read-only list for a
// template role; both group by module and show the machine code so an admin can
// cross-check it against the API and audit log.
import * as React from "react";
import { Check } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { PermissionCode } from "@starter/shared/access";
import {
  normalizeQuery,
  permissionGroups,
  permissionLabelKey,
} from "../lib";

export function PermissionChecklist({
  selected,
  onToggle,
}: {
  selected: readonly PermissionCode[];
  onToggle: (code: PermissionCode) => void;
}) {
  const t = useT();
  const [search, setSearch] = React.useState("");
  const groups = React.useMemo(() => permissionGroups(), []);
  const selectedSet = new Set(selected);
  const needle = normalizeQuery(search);

  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("access.role.searchPermissions")}
          aria-label={t("access.role.searchPermissions")}
          className="h-control-sm sm:max-w-xs"
        />
        <Badge tone="neutral" className="tabular">
          {t("access.role.selectedCount", { count: selected.length })}
        </Badge>
      </div>

      <div className="grid min-w-0 gap-4">
        {groups.map((group) => {
          const visible = group.permissions.filter(
            (permission) =>
              needle === "" ||
              normalizeQuery(permission.code).includes(needle) ||
              normalizeQuery(t(permission.labelKey)).includes(needle),
          );
          if (visible.length === 0) return null;
          const count = group.permissions.filter((permission) =>
            selectedSet.has(permission.code),
          ).length;
          return (
            <fieldset key={group.module} className="min-w-0">
              <legend className="mb-1 flex w-full items-center gap-2 text-sm font-semibold">
                {t(group.labelKey)}
                <span className="tabular text-xs font-normal text-muted-foreground">
                  {count}/{group.permissions.length}
                </span>
              </legend>
              <div className="grid min-w-0 gap-0.5 sm:grid-cols-2">
                {visible.map((permission) => {
                  const id = `perm-${permission.code.replaceAll(".", "-")}`;
                  return (
                    <label
                      key={permission.code}
                      htmlFor={id}
                      className="flex min-h-control-sm cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 transition-colors duration-(--duration-fast) hover:bg-accent"
                    >
                      <Checkbox
                        id={id}
                        className="mt-1"
                        checked={selectedSet.has(permission.code)}
                        onCheckedChange={() => onToggle(permission.code)}
                      />
                      <span className="grid min-w-0 gap-0.5">
                        <span className="text-(length:--density-text) leading-5">
                          {t(permission.labelKey)}
                        </span>
                        <code className="truncate font-mono text-xs text-muted-foreground">
                          {permission.code}
                        </code>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          );
        })}
      </div>
    </div>
  );
}

/** Template roles cannot be edited; this shows what the contract grants. */
export function PermissionReadOnlyList({
  codes,
}: {
  codes: readonly PermissionCode[];
}) {
  const t = useT();
  const groups = React.useMemo(() => permissionGroups(), []);
  const selected = new Set(codes);
  if (codes.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        {t("access.role.noMatches")}
      </p>
    );
  return (
    <div className="grid min-w-0 gap-4">
      {groups.map((group) => {
        const granted = group.permissions.filter((permission) =>
          selected.has(permission.code),
        );
        if (granted.length === 0) return null;
        return (
          <section key={group.module} className="grid gap-1">
            <h3 className="text-sm font-semibold">
              {t(group.labelKey)}{" "}
              <span className="tabular text-xs font-normal text-muted-foreground">
                {granted.length}/{group.permissions.length}
              </span>
            </h3>
            <ul className="grid gap-0.5 sm:grid-cols-2">
              {granted.map((permission) => (
                <li
                  key={permission.code}
                  className="flex items-start gap-2 rounded-md px-2 py-1.5"
                >
                  <Check
                    className="mt-0.5 size-icon shrink-0 text-success"
                    aria-hidden="true"
                  />
                  <span className="grid min-w-0 gap-0.5">
                    <span className="text-(length:--density-text) leading-5">
                      {t(permission.labelKey)}
                    </span>
                    <code className="truncate font-mono text-xs text-muted-foreground">
                      {permission.code}
                    </code>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** Small shared error line: every error says how to fix it (DESIGN.md §4). */
export function PermissionNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm leading-5 text-muted-foreground">{children}</p>
  );
}

export { permissionLabelKey };
