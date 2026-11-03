// Tenant Theme editor (PRD v1.7 §3 F4 "Whitelabel", Kelompok A Design System
// Platform; TEN-10). Logo, supporting colors, font from the list, corner style;
// the preview and the WCAG 2.2 AA check update on every change, and the save
// button stays disabled until BOTH modes pass. The API checks again on
// activation, so this gate is a convenience, not the authority.
import * as React from "react";
import { RotateCcw, Save } from "lucide-react";
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
import { holdsAny } from "@/lib/areas/guard";
import type { TenantTheme } from "@starter/shared/platform";
import { settingsErrorMessage } from "../errors";
import { useBrands, useSaveTheme, useThemes } from "../hooks";
import {
  BASE_THEME_DRAFT,
  BRAND_FONTS,
  CORNER_STYLES,
  TENANT_COLOR_TOKENS,
  canSaveTheme,
  draftFromTheme,
  effectiveColor,
  evaluateTheme,
  isOverridden,
  normalizeHex,
  setOverride,
  themeDirty,
  type ColorMode,
  type ThemeDraft,
} from "../theme-lib";
import { isHexColor } from "@starter/shared/theme";
import { LogoField, type LogoValue } from "./logo-field";
import { QueryFailure } from "./query-states";
import { SettingsPage } from "./settings-shell";
import { ContrastPanel, ThemePreview, tokenLabelKey } from "./theme-preview";

export function ThemePage({ access }: { access: AreaAccess }) {
  const t = useT();
  const brands = useBrands();
  const brand = brands.data?.data[0];
  const themes = useThemes(brand?.id);

  const failure = brands.isError ? brands : themes.isError ? themes : null;
  const pending = brands.isPending || (brand !== undefined && themes.isPending);

  return (
    <SettingsPage active="theme" access={access}>
      {failure ? (
        <QueryFailure
          error={failure.error}
          onRetry={() => void failure.refetch()}
        />
      ) : pending ? (
        <div
          role="status"
          aria-busy="true"
          className="grid gap-4 lg:grid-cols-2"
        >
          <span className="sr-only">{t("common.loading")}</span>
          <Skeleton className="h-96 rounded-container" />
          <Skeleton className="h-96 rounded-container" />
        </div>
      ) : !brand ? (
        <p className="rounded-container border-(length:--border-w) border-dashed px-4 py-3 text-sm leading-5 text-muted-foreground">
          {t("tenantSettings.theme.noBrand")}
        </p>
      ) : (
        <ThemeEditor
          brandId={brand.id}
          brandName={brand.name}
          themes={themes.data?.data ?? []}
          canManage={holdsAny(access, ["org.theme.manage"])}
        />
      )}
    </SettingsPage>
  );
}

function ThemeEditor({
  brandId,
  brandName,
  themes,
  canManage,
}: {
  brandId: string;
  brandName: string;
  themes: readonly TenantTheme[];
  canManage: boolean;
}) {
  const t = useT();
  const toast = useToast();
  const save = useSaveTheme(brandId);
  const active = themes.find((theme) => theme.status === "active") ?? null;
  const [saved, setSaved] = React.useState<ThemeDraft | null>(null);
  const baseline = saved ?? draftFromTheme(active);
  const [edited, setEdited] = React.useState<ThemeDraft | null>(null);
  const draft = edited ?? baseline;
  const [mode, setMode] = React.useState<ColorMode>("light");
  const [logoUrl, setLogoUrl] = React.useState<string | null>(null);
  const [serverError, setServerError] = React.useState<string | null>(null);

  const evaluation = evaluateTheme(draft);
  const dirty = themeDirty(draft, baseline);
  const allowed = canSaveTheme(evaluation, { dirty, saving: save.isPending });
  const blockedId = React.useId();
  const edit = (next: ThemeDraft) => {
    setServerError(null);
    setEdited(next);
  };

  const submit = () => {
    if (!allowed) return;
    setServerError(null);
    save.mutate(draft, {
      onSuccess: () => {
        setSaved(draft);
        setEdited(null);
        toast({
          tone: "success",
          title: t("tenantSettings.theme.saved"),
          description: t("tenantSettings.theme.savedHint"),
        });
      },
      onError: (error) => setServerError(settingsErrorMessage(error, t)),
    });
  };

  const logo: LogoValue | null = draft.logoMediaId
    ? { mediaId: draft.logoMediaId, url: logoUrl }
    : null;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
      <div className="grid min-w-0 gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="grid max-w-prose gap-1">
            <h2 className="type-heading">{t("tenantSettings.theme.title")}</h2>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("tenantSettings.theme.description")}
            </p>
          </div>
          <SegmentedControl<ColorMode>
            label={t("tenantSettings.theme.modeLabel")}
            value={mode}
            onValueChange={setMode}
            options={[
              { value: "light", label: t("tenantSettings.theme.modeLight") },
              { value: "dark", label: t("tenantSettings.theme.modeDark") },
            ]}
          />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{t("tenantSettings.theme.logoTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <LogoField
              value={logo}
              onChange={(next) => {
                setLogoUrl(next?.url ?? null);
                edit({ ...draft, logoMediaId: next?.mediaId ?? null });
              }}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("tenantSettings.theme.colorsTitle")}</CardTitle>
            <CardDescription>
              {t("tenantSettings.theme.colorsHint")}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {TENANT_COLOR_TOKENS.map((token) => {
              const override = draft.tokens[mode][token] ?? "";
              const overridden = isOverridden(draft, mode, token);
              const invalid = overridden && !isHexColor(override);
              const shown = effectiveColor(draft, mode, token);
              const id = `color-${mode}-${token}`;
              return (
                <div
                  key={token}
                  className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1"
                >
                  <input
                    type="color"
                    aria-label={t("tenantSettings.theme.pickColor", {
                      token: t(tokenLabelKey(token)),
                    })}
                    value={isHexColor(shown) ? shown : `#${"0".repeat(6)}`}
                    onChange={(event) =>
                      edit(setOverride(draft, mode, token, event.target.value))
                    }
                    className="size-control cursor-pointer rounded-field border-(length:--border-w) border-input bg-background p-1"
                  />
                  <div className="grid min-w-0 gap-1">
                    <Label htmlFor={id}>{t(tokenLabelKey(token))}</Label>
                    <Input
                      id={id}
                      value={override}
                      placeholder={shown}
                      onChange={(event) =>
                        edit(
                          setOverride(draft, mode, token, event.target.value),
                        )
                      }
                      onBlur={() =>
                        override &&
                        edit(
                          setOverride(
                            draft,
                            mode,
                            token,
                            normalizeHex(override),
                          ),
                        )
                      }
                      aria-invalid={invalid || undefined}
                      aria-describedby={invalid ? `${id}-error` : undefined}
                      spellCheck={false}
                      autoComplete="off"
                      maxLength={7}
                      className="font-mono"
                    />
                    {invalid && (
                      <p
                        id={`${id}-error`}
                        className="text-sm leading-5 font-medium text-danger"
                      >
                        {t("tenantSettings.theme.hexError")}
                      </p>
                    )}
                  </div>
                  {overridden ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("tenantSettings.theme.resetColor", {
                        token: t(tokenLabelKey(token)),
                      })}
                      onClick={() => edit(setOverride(draft, mode, token, ""))}
                    >
                      <RotateCcw aria-hidden="true" />
                    </Button>
                  ) : (
                    <Badge tone="neutral">
                      {t("tenantSettings.theme.baseValue")}
                    </Badge>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("tenantSettings.theme.shapeTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-1.5">
              <span className="text-sm leading-5 font-medium">
                {t("tenantSettings.theme.fontLabel")}
              </span>
              <SegmentedControl
                label={t("tenantSettings.theme.fontLabel")}
                value={draft.fontFamily}
                onValueChange={(fontFamily) => edit({ ...draft, fontFamily })}
                options={BRAND_FONTS.map((font) => ({
                  value: font,
                  label: t(`tenantSettings.theme.fonts.${font}`),
                }))}
              />
            </div>
            <div className="grid gap-1.5">
              <span className="text-sm leading-5 font-medium">
                {t("tenantSettings.theme.cornersLabel")}
              </span>
              <SegmentedControl
                label={t("tenantSettings.theme.cornersLabel")}
                value={draft.corners}
                onValueChange={(corners) => edit({ ...draft, corners })}
                options={CORNER_STYLES.map((corner) => ({
                  value: corner,
                  label: t(`tenantSettings.theme.corners.${corner}`),
                }))}
              />
            </div>
          </CardContent>
        </Card>

        <ThemeHistory
          themes={themes}
          onLoad={(theme) => {
            edit(draftFromTheme(theme));
            setLogoUrl(null);
          }}
        />
      </div>

      <div className="grid min-w-0 gap-5 lg:sticky lg:top-4">
        <ThemePreview
          draft={draft}
          mode={mode}
          brandName={brandName}
          logoUrl={logoUrl}
        />
        <ContrastPanel draft={draft} evaluation={evaluation} />
        <div className="grid gap-2">
          {!evaluation.ok && (
            <p
              id={blockedId}
              role="alert"
              className="text-sm leading-5 font-medium text-danger"
            >
              {t("tenantSettings.theme.saveBlocked")}
            </p>
          )}
          {serverError && (
            <p
              role="alert"
              className="text-sm leading-5 font-medium text-danger"
            >
              {serverError}
            </p>
          )}
          {canManage ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={submit}
                disabled={!allowed}
                loading={save.isPending}
                aria-describedby={!evaluation.ok ? blockedId : undefined}
              >
                <Save aria-hidden="true" />
                {t("tenantSettings.theme.save")}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!dirty || save.isPending}
                onClick={() => {
                  setEdited(null);
                  setServerError(null);
                }}
              >
                {t("tenantSettings.theme.discard")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={save.isPending}
                onClick={() => edit(BASE_THEME_DRAFT)}
              >
                {t("tenantSettings.theme.useBase")}
              </Button>
            </div>
          ) : (
            <p className="text-sm leading-5 text-muted-foreground">
              {t("tenantSettings.theme.readOnly")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function ThemeHistory({
  themes,
  onLoad,
}: {
  themes: readonly TenantTheme[];
  onLoad: (theme: TenantTheme) => void;
}) {
  const t = useT();
  const sorted = [...themes].sort((a, b) => b.version - a.version);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("tenantSettings.theme.historyTitle")}</CardTitle>
        <CardDescription>
          {t("tenantSettings.theme.historyHint")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sorted.length === 0 ? (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("tenantSettings.theme.historyEmpty")}
          </p>
        ) : (
          <ul className="grid divide-y">
            {sorted.map((theme) => (
              <li
                key={theme.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">
                    {t("tenantSettings.theme.version", {
                      version: theme.version,
                    })}
                  </span>
                  <Badge
                    tone={
                      theme.status === "active"
                        ? "success"
                        : theme.status === "draft"
                          ? "info"
                          : "neutral"
                    }
                  >
                    {t(`tenantSettings.theme.status.${theme.status}`)}
                  </Badge>
                  {!theme.contrastCheckPassed && (
                    <Badge tone="danger">
                      {t("tenantSettings.theme.contrastFailedBadge")}
                    </Badge>
                  )}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onLoad(theme)}
                >
                  {t("tenantSettings.theme.loadVersion")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
