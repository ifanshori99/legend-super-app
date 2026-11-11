// Multi-select for a rule's category or item targets (PRD §3.14 "per item or
// category"): a searchable checkbox group fed by the menu contract. Selected ids
// the loaded list does not contain (a long menu, a failed read) stay selected
// instead of being dropped silently.
import * as React from "react";
import { useT } from "@/components/i18n";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

export type TargetOption = { id: string; name: string };

/** Lists longer than this get a search field. */
const SEARCH_FROM = 8;

export function TargetPicker({
  label,
  hint,
  options,
  value,
  onChange,
  loading,
  unavailable,
  disabled,
}: {
  label: string;
  hint: string;
  options: readonly TargetOption[];
  value: readonly string[];
  onChange: (value: string[]) => void;
  loading: boolean;
  unavailable: boolean;
  disabled?: boolean;
}) {
  const t = useT();
  const [search, setSearch] = React.useState("");
  const hintId = React.useId();
  const known = new Set(options.map((option) => option.id));
  const unlisted = value.filter((id) => !known.has(id)).length;
  const needle = search.trim().toLocaleLowerCase("id-ID");
  const visible = needle
    ? options.filter((option) =>
        option.name.toLocaleLowerCase("id-ID").includes(needle),
      )
    : options;

  function toggle(id: string, checked: boolean) {
    onChange(
      checked
        ? value.includes(id)
          ? [...value]
          : [...value, id]
        : value.filter((current) => current !== id),
    );
  }

  return (
    <fieldset className="grid gap-2" aria-describedby={hintId}>
      <legend className="text-sm font-semibold">
        {label}{" "}
        <span className="font-normal text-muted-foreground">
          ({t("common.optional")})
        </span>
      </legend>
      <p id={hintId} className="text-sm leading-5 text-muted-foreground">
        {hint}
        {value.length > 0 && (
          <>
            {" · "}
            {t("tax.form.targetSelected", { count: value.length })}
          </>
        )}
      </p>
      {options.length > SEARCH_FROM && (
        <Input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label={t("tax.form.targetSearch", { label })}
          placeholder={t("tax.form.targetSearch", { label })}
          className="h-control-sm"
        />
      )}
      {loading ? (
        <div className="grid gap-1.5" aria-busy="true">
          <span className="sr-only">{t("tax.form.targetLoading")}</span>
          <Skeleton className="h-control-sm" />
          <Skeleton className="h-control-sm" />
        </div>
      ) : (
        <div className="max-h-44 overflow-y-auto rounded-container border-(length:--border-w) px-3 py-1">
          {unavailable ? (
            <p role="status" className="py-2 text-sm text-muted-foreground">
              {t("tax.form.targetUnavailable")}
            </p>
          ) : options.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              {t("tax.form.targetEmpty")}
            </p>
          ) : visible.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              {t("tax.form.targetNoMatch")}
            </p>
          ) : (
            visible.map((option) => (
              <label
                key={option.id}
                className="flex min-h-control-sm items-center gap-2"
              >
                <Checkbox
                  checked={value.includes(option.id)}
                  onCheckedChange={(checked) =>
                    toggle(option.id, checked === true)
                  }
                  disabled={disabled}
                />
                <span>{option.name}</span>
              </label>
            ))
          )}
        </div>
      )}
      {unlisted > 0 && !unavailable && (
        <p className="text-sm leading-5 text-muted-foreground">
          {t("tax.form.targetUnlisted", { count: unlisted })}
        </p>
      )}
    </fieldset>
  );
}
