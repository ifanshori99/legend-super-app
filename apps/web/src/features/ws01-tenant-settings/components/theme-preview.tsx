// Live preview of the Tenant Theme being edited, inside a ThemeScope island so
// the draft's colors, font and corners apply to the real components without
// touching the page around it. The contrast panel beside it reports the TEN-10
// result for BOTH modes.
import * as React from "react";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { useT } from "@/components/i18n";
import { ThemeScope } from "@/components/theme-scope";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { MessageKey } from "@starter/shared/i18n";
import type { ColorMode } from "@starter/shared/theme";
import {
  headlinePairs,
  previewVars,
  type ThemeDraft,
  type ThemeEvaluation,
} from "../theme-lib";

export function tokenLabelKey(token: string): MessageKey {
  return `tenantSettings.theme.tokens.${token}` as MessageKey;
}

export function ThemePreview({
  draft,
  mode,
  brandName,
  logoUrl,
}: {
  draft: ThemeDraft;
  mode: ColorMode;
  brandName: string;
  logoUrl: string | null;
}) {
  const t = useT();
  const inputId = React.useId();
  return (
    <ThemeScope
      mode={mode}
      style={previewVars(draft, mode) as React.CSSProperties}
      className="grid gap-4 rounded-shell border-(length:--border-w) p-4 font-brand"
      aria-label={t("tenantSettings.theme.previewLabel")}
      role="group"
    >
      <div className="flex items-center gap-3">
        {logoUrl ? (
          <img src={logoUrl} alt="" className="size-10 object-contain" />
        ) : (
          <span
            aria-hidden="true"
            className="grid size-10 place-items-center rounded-md bg-brand text-lg font-bold text-brand-foreground"
          >
            {brandName.slice(0, 1).toUpperCase()}
          </span>
        )}
        <p className="type-heading">{brandName}</p>
      </div>
      <Card>
        <CardTitle>{t("tenantSettings.theme.previewHeading")}</CardTitle>
        <CardDescription>
          {t("tenantSettings.theme.previewBody")}
        </CardDescription>
        <div className="flex flex-wrap gap-2">
          <Button type="button" tabIndex={-1}>
            {t("tenantSettings.theme.previewPrimary")}
          </Button>
          <Button type="button" variant="outline" tabIndex={-1}>
            {t("tenantSettings.theme.previewSecondary")}
          </Button>
          <Button type="button" variant="secondary" tabIndex={-1}>
            {t("tenantSettings.theme.previewMuted")}
          </Button>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={inputId}>
            {t("tenantSettings.theme.previewField")}
          </Label>
          <Input
            id={inputId}
            readOnly
            tabIndex={-1}
            value={t("tenantSettings.theme.previewFieldValue")}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="brand">{t("tenantSettings.theme.previewBadge")}</Badge>
          <Badge tone="success">{t("status.success")}</Badge>
          <Badge tone="danger">{t("status.danger")}</Badge>
          <span className="text-sm font-semibold text-primary underline underline-offset-4">
            {t("tenantSettings.theme.previewLink")}
          </span>
        </div>
      </Card>
    </ThemeScope>
  );
}

const DISPLAY_RATIO = (ratio: number) => ratio.toFixed(2);

export function ContrastPanel({
  draft,
  evaluation,
}: {
  draft: ThemeDraft;
  evaluation: ThemeEvaluation;
}) {
  const t = useT();
  const pairs = headlinePairs(draft);
  const invalid = evaluation.invalid.length > 0;
  return (
    <section
      aria-labelledby="contrast-heading"
      className="grid gap-3 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline"
    >
      <h3 id="contrast-heading" className="type-heading">
        {t("tenantSettings.theme.contrastTitle")}
      </h3>
      <p
        role="status"
        className={
          evaluation.ok
            ? "flex items-start gap-2 rounded-control bg-success-subtle px-3 py-2 text-sm leading-5 font-semibold text-success"
            : "flex items-start gap-2 rounded-control bg-danger-subtle px-3 py-2 text-sm leading-5 font-semibold text-danger"
        }
      >
        {evaluation.ok ? (
          <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        ) : (
          <TriangleAlert
            className="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
        )}
        {evaluation.ok
          ? t("tenantSettings.theme.contrastPass")
          : invalid
            ? t("tenantSettings.theme.contrastInvalid", {
                count: evaluation.invalid.length,
              })
            : t("tenantSettings.theme.contrastFail", {
                count: evaluation.failures.length,
                light: evaluation.failuresByMode.light,
                dark: evaluation.failuresByMode.dark,
              })}
      </p>

      <table className="w-full text-sm leading-5">
        <caption className="sr-only">
          {t("tenantSettings.theme.pairsCaption")}
        </caption>
        <thead>
          <tr className="text-left text-muted-foreground">
            <th scope="col" className="py-1 pr-2 font-medium">
              {t("tenantSettings.theme.pairsUse")}
            </th>
            <th scope="col" className="px-2 py-1 font-medium">
              {t("tenantSettings.theme.modeLight")}
            </th>
            <th scope="col" className="py-1 pl-2 font-medium">
              {t("tenantSettings.theme.modeDark")}
            </th>
          </tr>
        </thead>
        <tbody>
          {(["primaryButton", "link", "brandFill", "brandTint"] as const).map(
            (id) => (
              <tr key={id} className="border-t-(length:--border-w)">
                <th scope="row" className="py-1.5 pr-2 text-left font-medium">
                  {t(`tenantSettings.theme.pairs.${id}`)}
                </th>
                {(["light", "dark"] as const).map((mode) => {
                  const pair = pairs.find(
                    (item) => item.id === id && item.mode === mode,
                  );
                  return (
                    <td key={mode} className="px-2 py-1.5">
                      <span
                        className={
                          pair?.pass
                            ? "font-semibold text-success"
                            : "font-semibold text-danger"
                        }
                      >
                        {pair?.ratio == null
                          ? "—"
                          : `${DISPLAY_RATIO(pair.ratio)}:1`}
                      </span>{" "}
                      <span className="text-muted-foreground">
                        {pair?.pass
                          ? t("tenantSettings.theme.pass")
                          : t("tenantSettings.theme.fail", {
                              min: pair?.min ?? 0,
                            })}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ),
          )}
        </tbody>
      </table>

      {invalid && (
        <ul className="grid gap-1 text-sm leading-5 text-danger">
          {evaluation.invalid.map((entry) => (
            <li key={entry} className="font-mono text-xs">
              {entry}
            </li>
          ))}
        </ul>
      )}
      {!invalid && evaluation.failures.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm leading-5 font-semibold text-primary">
            {t("tenantSettings.theme.failureDetails", {
              count: evaluation.failures.length,
            })}
          </summary>
          <ul className="mt-2 grid gap-1.5 text-sm leading-5">
            {evaluation.failures.map((failure) => (
              <li
                key={`${failure.mode}-${failure.fg}-${failure.bg}`}
                className="text-foreground"
              >
                {t("tenantSettings.theme.failureLine", {
                  mode: t(
                    failure.mode === "light"
                      ? "tenantSettings.theme.modeLight"
                      : "tenantSettings.theme.modeDark",
                  ),
                  fg: t(tokenLabelKey(failure.fg)),
                  bg: t(tokenLabelKey(failure.bg)),
                  ratio: DISPLAY_RATIO(failure.ratio),
                  min: failure.min,
                })}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
