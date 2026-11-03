// Config export/import (PRD v1.7 §3 F4 "Konfigurasi sebagai Data & Template
// Tenant", TEN-09). Export downloads the tenant's configuration as one JSON
// bundle (no ids of this tenant, no secrets, no transactions). Import is two
// steps: read and validate the file, show a section-by-section diff against the
// current configuration, and apply only after an explicit confirmation.
import type { MessageKey } from "@starter/shared/i18n";
import * as React from "react";
import {
  CircleCheck,
  Download,
  FileJson,
  TriangleAlert,
  Upload,
} from "lucide-react";
import {
  CONFIG_SECTIONS,
  type ConfigBundle,
  type ConfigSection,
} from "@starter/shared/platform";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import type { AreaAccess } from "@/lib/areas/access";
import { holdsAny } from "@/lib/areas/guard";
import {
  bundleFileName,
  diffBundles,
  diffTotals,
  parseBundleText,
  selectedSections,
  serializeBundle,
  exportIsSafe,
  type ParsedBundle,
  type SectionDiff,
  type SectionStatus,
} from "../config-lib";
import { settingsErrorMessage } from "../errors";
import { useExportConfig, useImportConfig } from "../hooks";
import { SettingsPage } from "./settings-shell";

const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;

const STATUS_TONE = {
  added: "info",
  changed: "warning",
  unchanged: "neutral",
} as const satisfies Record<SectionStatus, string>;

function download(fileName: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

type ImportState =
  | { kind: "idle" }
  | { kind: "reading" }
  | {
      kind: "invalid";
      fileName: string;
      parsed: Extract<ParsedBundle, { ok: false }>;
    }
  | { kind: "failed"; fileName: string; message: string }
  | {
      kind: "preview";
      fileName: string;
      bundle: ConfigBundle;
      diffs: SectionDiff[];
    }
  | { kind: "done"; applied: ConfigSection[] };

export function ConfigPage({ access }: { access: AreaAccess }) {
  const t = useT();
  return (
    <SettingsPage active="config" access={access}>
      <div className="grid max-w-prose gap-1">
        <h2 className="type-heading">{t("tenantSettings.config.title")}</h2>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("tenantSettings.config.description")}
        </p>
      </div>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] xl:items-start">
        <ExportCard />
        <ImportCard canApply={holdsAny(access, ["platform.tenant.manage"])} />
      </div>
    </SettingsPage>
  );
}

function ExportCard() {
  const t = useT();
  const toast = useToast();
  const exporter = useExportConfig();
  const [off, setOff] = React.useState<ReadonlySet<ConfigSection>>(new Set());
  const [error, setError] = React.useState<string | null>(null);
  const chosen = CONFIG_SECTIONS.filter((section) => !off.has(section));

  const run = () => {
    setError(null);
    exporter.mutate(
      chosen.length === CONFIG_SECTIONS.length ? undefined : [...chosen],
      {
        onSuccess: (bundle) => {
          if (!exportIsSafe(bundle)) {
            setError(t("tenantSettings.config.exportUnsafe"));
            return;
          }
          download(bundleFileName(bundle.exportedAt), serializeBundle(bundle));
          toast({
            tone: "success",
            title: t("tenantSettings.config.exported", {
              count: Object.keys(bundle.sections).length,
            }),
          });
        },
        onError: (failure) => setError(settingsErrorMessage(failure, t)),
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("tenantSettings.config.exportTitle")}</CardTitle>
        <CardDescription>
          {t("tenantSettings.config.exportHint")}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm leading-5 font-medium">
            {t("tenantSettings.config.sectionsLegend")}
          </legend>
          <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
            {CONFIG_SECTIONS.map((section) => {
              const id = `export-${section}`;
              return (
                <div
                  key={section}
                  className="flex min-h-control-sm items-center gap-2"
                >
                  <Checkbox
                    id={id}
                    checked={!off.has(section)}
                    onCheckedChange={(checked) =>
                      setOff((current) => {
                        const next = new Set(current);
                        if (checked === true) next.delete(section);
                        else next.add(section);
                        return next;
                      })
                    }
                  />
                  <Label htmlFor={id} className="font-normal">
                    {t(`tenantSettings.config.sections.${section}`)}
                  </Label>
                </div>
              );
            })}
          </div>
        </fieldset>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("tenantSettings.config.exportExcludes")}
        </p>
        {error && (
          <p role="alert" className="text-sm leading-5 font-medium text-danger">
            {error}
          </p>
        )}
        <div>
          <Button
            type="button"
            onClick={run}
            loading={exporter.isPending}
            disabled={chosen.length === 0}
          >
            <Download aria-hidden="true" />
            {t("tenantSettings.config.exportAction")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ImportCard({ canApply }: { canApply: boolean }) {
  const t = useT();
  const toast = useToast();
  const current = useExportConfig();
  const importer = useImportConfig();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [state, setState] = React.useState<ImportState>({ kind: "idle" });
  const [off, setOff] = React.useState<ReadonlySet<ConfigSection>>(new Set());
  const [confirming, setConfirming] = React.useState(false);
  const [applyError, setApplyError] = React.useState<string | null>(null);

  const reset = () => {
    setState({ kind: "idle" });
    setOff(new Set());
    setApplyError(null);
  };

  async function handleFile(file: File | undefined) {
    if (!file) return;
    reset();
    if (file.size > MAX_BUNDLE_BYTES) {
      setState({
        kind: "invalid",
        fileName: file.name,
        parsed: {
          ok: false,
          reason: "size",
          schemaIssues: [],
          identifierIssues: [],
        },
      });
      return;
    }
    setState({ kind: "reading" });
    const parsed = parseBundleText(await file.text());
    if (!parsed.ok) {
      setState({ kind: "invalid", fileName: file.name, parsed });
      return;
    }
    try {
      const now = await current.mutateAsync(undefined);
      setState({
        kind: "preview",
        fileName: file.name,
        bundle: parsed.bundle,
        diffs: diffBundles(now, parsed.bundle),
      });
    } catch (failure) {
      setState({
        kind: "failed",
        fileName: file.name,
        message: settingsErrorMessage(failure, t),
      });
    }
  }

  const apply = () => {
    if (state.kind !== "preview") return;
    const sections = selectedSections(state.diffs, off);
    setApplyError(null);
    importer.mutate(
      { bundle: state.bundle, sections },
      {
        onSuccess: (result) => {
          setConfirming(false);
          setState({ kind: "done", applied: result.appliedSections });
          toast({
            tone: "success",
            title: t("tenantSettings.config.applied", {
              count: result.appliedSections.length,
            }),
          });
        },
        onError: (failure) => {
          setConfirming(false);
          setApplyError(settingsErrorMessage(failure, t));
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("tenantSettings.config.importTitle")}</CardTitle>
        <CardDescription>
          {t("tenantSettings.config.importHint")}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            loading={state.kind === "reading" || current.isPending}
            onClick={() => inputRef.current?.click()}
          >
            <Upload aria-hidden="true" />
            {t("tenantSettings.config.chooseFile")}
          </Button>
          {state.kind !== "idle" && state.kind !== "reading" && (
            <Button type="button" variant="ghost" onClick={reset}>
              {t("tenantSettings.config.clear")}
            </Button>
          )}
          <input
            ref={inputRef}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            tabIndex={-1}
            aria-label={t("tenantSettings.config.chooseFile")}
            onChange={(event) => {
              void handleFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </div>

        {state.kind === "idle" && (
          <p className="flex items-start gap-2 rounded-container border-(length:--border-w) border-dashed px-4 py-3 text-sm leading-5 text-muted-foreground">
            <FileJson className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {t("tenantSettings.config.idleHint")}
          </p>
        )}

        {state.kind === "invalid" && (
          <InvalidBundle fileName={state.fileName} parsed={state.parsed} />
        )}

        {state.kind === "failed" && (
          <p role="alert" className="text-sm leading-5 font-medium text-danger">
            {state.message}
          </p>
        )}

        {state.kind === "done" && (
          <p
            role="status"
            className="flex items-start gap-2 rounded-control bg-success-subtle px-3 py-2 text-sm leading-5 font-semibold text-success"
          >
            <CircleCheck
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            {t("tenantSettings.config.doneBanner", {
              count: state.applied.length,
            })}
          </p>
        )}

        {state.kind === "preview" && (
          <Preview
            fileName={state.fileName}
            diffs={state.diffs}
            off={off}
            onToggle={(section, include) =>
              setOff((previous) => {
                const next = new Set(previous);
                if (include) next.delete(section);
                else next.add(section);
                return next;
              })
            }
            canApply={canApply}
            applying={importer.isPending}
            error={applyError}
            onApply={() => setConfirming(true)}
          />
        )}
      </CardContent>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("tenantSettings.config.confirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("tenantSettings.config.confirmBody", {
                count:
                  state.kind === "preview"
                    ? selectedSections(state.diffs, off).length
                    : 0,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirming(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button type="button" loading={importer.isPending} onClick={apply}>
              {t("tenantSettings.config.applyAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function InvalidBundle({
  fileName,
  parsed,
}: {
  fileName: string;
  parsed: Extract<ParsedBundle, { ok: false }>;
}) {
  const t = useT();
  const details = [
    ...parsed.schemaIssues,
    ...parsed.identifierIssues.map(
      (issue) => `${issue.path} (${issue.reason})`,
    ),
  ].slice(0, 6);
  return (
    <div
      role="alert"
      className="grid gap-2 rounded-container border-(length:--border-w) bg-danger-subtle p-card"
    >
      <p className="flex items-start gap-2 text-sm leading-5 font-semibold text-danger">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {t(`tenantSettings.config.invalid.${parsed.reason}`, {
          file: fileName,
        })}
      </p>
      <p className="text-sm leading-5 text-foreground">
        {t(`tenantSettings.config.invalidHint.${parsed.reason}`)}
      </p>
      {details.length > 0 && (
        <ul className="grid gap-0.5">
          {details.map((detail) => (
            <li key={detail} className="font-mono text-xs break-all">
              {detail}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Preview({
  fileName,
  diffs,
  off,
  onToggle,
  canApply,
  applying,
  error,
  onApply,
}: {
  fileName: string;
  diffs: readonly SectionDiff[];
  off: ReadonlySet<ConfigSection>;
  onToggle: (section: ConfigSection, include: boolean) => void;
  canApply: boolean;
  applying: boolean;
  error: string | null;
  onApply: () => void;
}) {
  const t = useT();
  const totals = diffTotals(diffs);
  const chosen = selectedSections(diffs, off);
  const removedChosen = diffs
    .filter((diff) => chosen.includes(diff.section))
    .reduce((sum, diff) => sum + diff.removed.length, 0);
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <h3 className="type-heading">
          {t("tenantSettings.config.previewTitle")}
        </h3>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("tenantSettings.config.previewSummary", {
            file: fileName,
            sections: totals.sections,
            changed: totals.changedSections,
          })}
        </p>
      </div>

      <ul className="grid gap-2">
        {diffs.map((diff) => {
          const id = `import-${diff.section}`;
          const unchanged = diff.status === "unchanged";
          const lines = [
            ...diff.added.map((key) => ({ sign: "+", key, kind: "added" })),
            ...diff.changed.map((key) => ({ sign: "~", key, kind: "changed" })),
            ...diff.removed.map((key) => ({ sign: "−", key, kind: "removed" })),
          ];
          return (
            <li
              key={diff.section}
              className="grid gap-2 rounded-container border-(length:--border-w) bg-card p-3"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Checkbox
                  id={id}
                  checked={!unchanged && !off.has(diff.section)}
                  disabled={unchanged}
                  onCheckedChange={(checked) =>
                    onToggle(diff.section, checked === true)
                  }
                />
                <Label htmlFor={id} className="font-semibold">
                  {t(`tenantSettings.config.sections.${diff.section}`)}
                </Label>
                <Badge tone={STATUS_TONE[diff.status]}>
                  {t(`tenantSettings.config.diffStatus.${diff.status}`)}
                </Badge>
                {!unchanged && (
                  <span className="text-sm leading-5 text-muted-foreground tabular-nums">
                    {t("tenantSettings.config.diffCounts", {
                      added: diff.added.length,
                      changed: diff.changed.length,
                      removed: diff.removed.length,
                    })}
                  </span>
                )}
              </div>
              {lines.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-sm leading-5 font-medium text-primary">
                    {t("tenantSettings.config.showDetails", {
                      count: lines.length,
                    })}
                  </summary>
                  <ul className="mt-2 grid gap-0.5">
                    {lines.slice(0, 50).map((line) => (
                      <li
                        key={`${line.kind}-${line.key}`}
                        className="flex gap-2 font-mono text-xs leading-4 break-all"
                      >
                        <span
                          aria-label={t(
                            `tenantSettings.config.lineKind.${line.kind}` as MessageKey,
                          )}
                        >
                          {line.sign}
                        </span>
                        <span>{line.key}</span>
                      </li>
                    ))}
                  </ul>
                  {lines.length > 50 && (
                    <p className="mt-1 text-xs leading-4 text-muted-foreground">
                      {t("tenantSettings.config.moreLines", {
                        count: lines.length - 50,
                      })}
                    </p>
                  )}
                </details>
              )}
            </li>
          );
        })}
      </ul>

      {removedChosen > 0 && (
        <p className="flex items-start gap-2 rounded-control bg-warning-subtle px-3 py-2 text-sm leading-5 font-medium text-foreground">
          <TriangleAlert
            className="mt-0.5 size-4 shrink-0 text-warning"
            aria-hidden="true"
          />
          {t("tenantSettings.config.removeWarning", { count: removedChosen })}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm leading-5 font-medium text-danger">
          {error}
        </p>
      )}
      {!canApply && (
        <p className="text-sm leading-5 text-muted-foreground">
          {t("tenantSettings.config.applyRestricted")}
        </p>
      )}
      {totals.changedSections === 0 && (
        <p className="text-sm leading-5 text-muted-foreground">
          {t("tenantSettings.config.noChanges")}
        </p>
      )}
      <div>
        <Button
          type="button"
          onClick={onApply}
          loading={applying}
          disabled={!canApply || chosen.length === 0}
        >
          {t("tenantSettings.config.applyAction")}
        </Button>
      </div>
    </div>
  );
}
