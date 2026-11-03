// Term dictionary editor (PRD v1.7 §3 F4 "Teks & Kamus Istilah", §6
// `text_overrides`). Super Admin only. A tenant renames the terms its staff and
// guests see (table, "Zona WFC", "Shower Room", stations, loyalty tiers)
// without a deploy; an empty box restores the platform default.
import * as React from "react";
import { Save } from "lucide-react";
import type { TextLocale } from "@starter/shared/text";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import type { AreaAccess } from "@/lib/areas/access";
import { settingsErrorMessage } from "../errors";
import { useApplyTermChanges, useTextOverrides } from "../hooks";
import {
  TERM_VALUE_MAX,
  buildTermRows,
  groupTermRows,
  termChanges,
} from "../terms-lib";
import { QueryFailure } from "./query-states";
import { SettingsPage } from "./settings-shell";

export function TermsPage({ access }: { access: AreaAccess }) {
  const t = useT();
  const toast = useToast();
  const overrides = useTextOverrides();
  const [locale, setLocale] = React.useState<TextLocale>("id");
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [serverError, setServerError] = React.useState<string | null>(null);
  const apply = useApplyTermChanges(locale);

  const rows = React.useMemo(
    () => buildTermRows(overrides.data?.data ?? [], locale),
    [overrides.data, locale],
  );
  const { changes, invalid } = termChanges(rows, drafts);
  const changedCount = overrides.data
    ? rows.filter((row) => row.override).length
    : 0;
  const canSave =
    changes.length > 0 && Object.keys(invalid).length === 0 && !apply.isPending;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    setServerError(null);
    apply.mutate(changes, {
      onSuccess: () => {
        setDrafts({});
        toast({
          tone: "success",
          title: t("tenantSettings.terms.saved", { count: changes.length }),
        });
      },
      onError: (failure) => setServerError(settingsErrorMessage(failure, t)),
    });
  };

  return (
    <SettingsPage active="terms" access={access}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid max-w-prose gap-1">
          <h2 className="type-heading">{t("tenantSettings.terms.title")}</h2>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("tenantSettings.terms.description")}
          </p>
        </div>
        <SegmentedControl<TextLocale>
          label={t("tenantSettings.terms.localeLabel")}
          value={locale}
          onValueChange={(next) => {
            setLocale(next);
            setDrafts({});
            setServerError(null);
          }}
          options={[
            { value: "id", label: t("tenantSettings.terms.localeId") },
            { value: "en", label: t("tenantSettings.terms.localeEn") },
          ]}
        />
      </div>

      {overrides.isPending ? (
        <div role="status" aria-busy="true" className="grid gap-4">
          <span className="sr-only">{t("common.loading")}</span>
          <Skeleton className="h-48 rounded-container" />
          <Skeleton className="h-48 rounded-container" />
        </div>
      ) : overrides.isError ? (
        <QueryFailure
          error={overrides.error}
          onRetry={() => void overrides.refetch()}
        />
      ) : (
        <form className="grid gap-4" onSubmit={submit} noValidate>
          <p className="text-sm leading-5 text-muted-foreground">
            {changedCount === 0
              ? t("tenantSettings.terms.noneChanged")
              : t("tenantSettings.terms.changedCount", {
                  count: changedCount,
                })}
            {locale === "en" && ` ${t("tenantSettings.terms.enNote")}`}
          </p>
          {groupTermRows(rows).map(({ group, rows: groupRows }) => (
            <Card key={group} role="group" aria-labelledby={`terms-${group}`}>
              <CardHeader>
                <CardTitle id={`terms-${group}`}>
                  {t(`tenantSettings.terms.groups.${group}`)}
                </CardTitle>
                <CardDescription>
                  {t(`tenantSettings.terms.groupHints.${group}`)}
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                {groupRows.map((row) => {
                  const id = `term-${locale}-${row.key}`;
                  const value = drafts[row.key] ?? row.override?.value ?? "";
                  const issue = invalid[row.key];
                  return (
                    <div key={row.key} className="grid gap-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Label htmlFor={id}>{row.fallback}</Label>
                        {row.override && (
                          <Badge tone="brand">
                            {t("tenantSettings.terms.customized")}
                          </Badge>
                        )}
                      </div>
                      <Input
                        id={id}
                        value={value}
                        placeholder={row.fallback}
                        maxLength={TERM_VALUE_MAX + 1}
                        autoComplete="off"
                        aria-invalid={issue ? true : undefined}
                        aria-describedby={`${id}-hint`}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [row.key]: event.target.value,
                          }))
                        }
                      />
                      <p
                        id={`${id}-hint`}
                        className={
                          issue
                            ? "text-sm leading-5 font-medium text-danger"
                            : "font-mono text-xs leading-4 text-muted-foreground"
                        }
                      >
                        {issue
                          ? t(`tenantSettings.terms.issues.${issue}`)
                          : row.key}
                      </p>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          ))}
          {serverError && (
            <p
              role="alert"
              className="text-sm leading-5 font-medium text-danger"
            >
              {serverError}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={!canSave} loading={apply.isPending}>
              <Save aria-hidden="true" />
              {changes.length > 0
                ? t("tenantSettings.terms.saveCount", {
                    count: changes.length,
                  })
                : t("common.save")}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={Object.keys(drafts).length === 0 || apply.isPending}
              onClick={() => setDrafts({})}
            >
              {t("tenantSettings.terms.discard")}
            </Button>
          </div>
        </form>
      )}
    </SettingsPage>
  );
}
