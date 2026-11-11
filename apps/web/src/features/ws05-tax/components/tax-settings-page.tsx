// Calculation options (PRD §3.14 "Opsi Perhitungan"): the version in force,
// its history, and the draft-publish flow. Menu prices exclude tax and service
// charge by default (owner decision 2026-11-01); visible prices are inclusive
// only when this setting says so.
import * as React from "react";
import { Plus } from "lucide-react";
import type { TaxSettings } from "@starter/shared/tax";
import { formatNumber } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardShell,
  CardShellFooter,
  CardTitle,
} from "@/components/ui/card";
import { DataTableShell } from "@/components/ui/data-table-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { taxMutationError } from "../errors";
import {
  useArchiveTaxSettings,
  usePublishTaxSettings,
  useTaxSettings,
} from "../hooks";
import { PACKAGE_ALLOCATION_KEYS, ROUNDING_KEYS } from "../labels";
import {
  businessDateToday,
  effectiveSettings,
  formatBusinessDate,
} from "../lib";
import { DiscardDraftDialog } from "./discard-draft-dialog";
import { DraftActions } from "./draft-actions";
import { PublishDialog } from "./publish-dialog";
import { TaxSettingsDialog } from "./tax-settings-dialog";
import { VersionStatusBadge } from "./version-badges";
import { newIdempotencyKey } from "../../../lib/idempotency.ts";

export function TaxSettingsPage() {
  const t = useT();
  const toast = useToast();
  const settingsQuery = useTaxSettings();
  const publishSettings = usePublishTaxSettings();
  const archiveSettings = useArchiveTaxSettings();

  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<TaxSettings | null>(null);
  const [discarding, setDiscarding] = React.useState<TaxSettings | null>(null);
  const [discardError, setDiscardError] = React.useState<string>();
  const [publishing, setPublishing] = React.useState<TaxSettings | null>(null);
  const [publishError, setPublishError] = React.useState<string>();

  const today = businessDateToday();
  const rows = React.useMemo(
    () =>
      [...(settingsQuery.data?.data ?? [])].sort(
        (a, b) => b.version - a.version,
      ),
    [settingsQuery.data],
  );
  const current = effectiveSettings(rows, today);
  const base = current ?? rows[0];

  function billRoundingLabel(row: TaxSettings): string {
    if (row.billRounding === null) return t("tax.settings.noBillRounding");
    return t("tax.settings.billRoundingValue", {
      amount: formatNumber(row.billRounding.incrementIdr),
      mode: t(ROUNDING_KEYS[row.billRounding.mode]),
    });
  }

  function confirmPublish() {
    if (!publishing) return;
    publishSettings.mutate(
      {
        params: { taxSettingsId: publishing.id },
        idempotencyKey: newIdempotencyKey(),
      },
      {
        onSuccess: () => {
          toast({ title: t("tax.settings.publishedToast"), tone: "success" });
          setPublishing(null);
          setPublishError(undefined);
        },
        onError: (error) => setPublishError(taxMutationError(error, t)),
      },
    );
  }

  function confirmDiscard() {
    if (!discarding) return;
    archiveSettings.mutate(
      { params: { taxSettingsId: discarding.id } },
      {
        onSuccess: () => {
          toast({ title: t("tax.discard.success"), tone: "success" });
          setDiscarding(null);
          setDiscardError(undefined);
        },
        onError: (error) => setDiscardError(taxMutationError(error, t)),
      },
    );
  }

  const openDiscard = (row: TaxSettings) => {
    setDiscardError(undefined);
    setDiscarding(row);
  };

  return (
    <>
      {current && (
        // v3 double shell: the current version is the screen's summary card.
        <CardShell>
          <Card>
            <CardHeader>
              <CardTitle>{t("tax.settings.currentTitle")}</CardTitle>
              <CardAction>
                <Badge tone="success">{t("tax.effective.now")}</Badge>
              </CardAction>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-0.5">
                  <dt className="text-sm text-muted-foreground">
                    {t("tax.settings.pricesIncludeTax")}
                  </dt>
                  <dd className="font-medium">
                    {current.pricesIncludeTax
                      ? t("tax.settings.included")
                      : t("tax.settings.excluded")}
                  </dd>
                </div>
                <div className="grid gap-0.5">
                  <dt className="text-sm text-muted-foreground">
                    {t("tax.settings.order")}
                  </dt>
                  <dd className="font-medium">
                    {t("tax.settings.orderValue")}
                  </dd>
                </div>
                <div className="grid gap-0.5">
                  <dt className="text-sm text-muted-foreground">
                    {t("tax.settings.serviceRounding")}
                  </dt>
                  <dd className="font-medium">
                    {t(ROUNDING_KEYS[current.serviceRoundingMode])}
                  </dd>
                </div>
                <div className="grid gap-0.5">
                  <dt className="text-sm text-muted-foreground">
                    {t("tax.settings.taxRounding")}
                  </dt>
                  <dd className="font-medium">
                    {t(ROUNDING_KEYS[current.taxRoundingMode])}
                  </dd>
                </div>
                <div className="grid gap-0.5">
                  <dt className="text-sm text-muted-foreground">
                    {t("tax.settings.inclusiveBaseRounding")}
                  </dt>
                  <dd className="font-medium">
                    {t(ROUNDING_KEYS[current.inclusiveBaseRoundingMode])}
                  </dd>
                </div>
                <div className="grid gap-0.5">
                  <dt className="text-sm text-muted-foreground">
                    {t("tax.settings.billRounding")}
                  </dt>
                  <dd className="font-medium">{billRoundingLabel(current)}</dd>
                </div>
                <div className="grid gap-0.5">
                  <dt className="text-sm text-muted-foreground">
                    {t("tax.settings.packageAllocation")}
                  </dt>
                  <dd className="font-medium">
                    {t(PACKAGE_ALLOCATION_KEYS[current.packageAllocation])}
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>
          <CardShellFooter>
            {t("tax.settings.currentSince", {
              date: formatBusinessDate(current.effectiveFrom),
              version: current.version,
            })}
          </CardShellFooter>
        </CardShell>
      )}

      <DataTableShell
        title={t("tax.settings.historyTitle")}
        description={t("tax.settings.historyDescription")}
        state={
          settingsQuery.isPending
            ? "loading"
            : settingsQuery.isError
              ? "error"
              : rows.length === 0
                ? "empty"
                : "ready"
        }
        actions={
          <Button type="button" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" />
            {t("tax.settings.newVersion")}
          </Button>
        }
        error={settingsQuery.error}
        onRetry={() => void settingsQuery.refetch()}
        empty={{
          title: t("tax.settings.emptyTitle"),
          description: t("tax.settings.emptyHint"),
          action: (
            <Button
              type="button"
              variant="outline"
              onClick={() => setCreating(true)}
            >
              {t("tax.settings.newVersion")}
            </Button>
          ),
        }}
        rowCount={rows.length}
      >
        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("tax.settings.columns.version")}</TableHead>
                <TableHead>
                  {t("tax.settings.columns.pricesIncludeTax")}
                </TableHead>
                <TableHead>{t("tax.settings.columns.taxRounding")}</TableHead>
                <TableHead>
                  {t("tax.settings.columns.packageAllocation")}
                </TableHead>
                <TableHead>{t("tax.rules.columns.effective")}</TableHead>
                <TableHead numeric>{t("tax.rules.columns.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const isCurrent = current?.id === row.id;
                const scheduled =
                  row.status === "published" &&
                  row.effectiveFrom > today &&
                  !isCurrent;
                return (
                  <TableRow key={row.id}>
                    <TableCell>
                      <VersionStatusBadge version={row} />
                    </TableCell>
                    <TableCell>
                      {row.pricesIncludeTax
                        ? t("tax.settings.included")
                        : t("tax.settings.excluded")}
                    </TableCell>
                    <TableCell>
                      {t(ROUNDING_KEYS[row.taxRoundingMode])}
                    </TableCell>
                    <TableCell>
                      {t(PACKAGE_ALLOCATION_KEYS[row.packageAllocation])}
                    </TableCell>
                    <TableCell>
                      <div className="grid justify-items-start gap-1">
                        <span className="tabular">
                          {formatBusinessDate(row.effectiveFrom)}
                        </span>
                        {isCurrent ? (
                          <Badge tone="success">{t("tax.effective.now")}</Badge>
                        ) : scheduled ? (
                          <Badge tone="info">
                            {t("tax.effective.scheduled")}
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell numeric>
                      {row.status === "draft" && (
                        <DraftActions
                          context={`${t("tax.tabs.settings")} ${t("tax.versionLabel", { version: row.version })}`}
                          onEdit={() => setEditing(row)}
                          onPublish={() => {
                            setPublishError(undefined);
                            setPublishing(row);
                          }}
                          onDiscard={() => openDiscard(row)}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        <ul className="md:hidden">
          {rows.map((row) => {
            const isCurrent = current?.id === row.id;
            const scheduled =
              row.status === "published" &&
              row.effectiveFrom > today &&
              !isCurrent;
            return (
              <li
                key={row.id}
                className="grid gap-2 border-b px-card py-3 last:border-b-0"
              >
                <div className="flex items-start justify-between gap-2">
                  <VersionStatusBadge version={row} />
                  {isCurrent ? (
                    <Badge tone="success">{t("tax.effective.now")}</Badge>
                  ) : scheduled ? (
                    <Badge tone="info">{t("tax.effective.scheduled")}</Badge>
                  ) : null}
                </div>
                <p className="text-sm text-muted-foreground">
                  {t("tax.rules.effectiveFrom", {
                    date: formatBusinessDate(row.effectiveFrom),
                  })}
                </p>
                <p className="text-sm">
                  {row.pricesIncludeTax
                    ? t("tax.settings.included")
                    : t("tax.settings.excluded")}
                  {" · "}
                  {t(ROUNDING_KEYS[row.taxRoundingMode])}
                  {" · "}
                  {t(PACKAGE_ALLOCATION_KEYS[row.packageAllocation])}
                </p>
                {row.status === "draft" && (
                  <DraftActions
                    context={`${t("tax.tabs.settings")} ${t("tax.versionLabel", { version: row.version })}`}
                    onEdit={() => setEditing(row)}
                    onPublish={() => {
                      setPublishError(undefined);
                      setPublishing(row);
                    }}
                    onDiscard={() => openDiscard(row)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </DataTableShell>

      {creating && (
        <TaxSettingsDialog
          base={base}
          versions={rows}
          today={today}
          onClose={() => setCreating(false)}
        />
      )}

      {editing && (
        <TaxSettingsDialog
          draft={editing}
          base={editing}
          versions={rows}
          today={today}
          onClose={() => setEditing(null)}
        />
      )}

      {discarding && (
        <DiscardDraftDialog
          title={t("tax.discard.settingsTitle")}
          version={discarding.version}
          name={t("tax.settings.discardName")}
          meta={t("tax.discard.meta", {
            date: formatBusinessDate(discarding.effectiveFrom),
          })}
          error={discardError}
          pending={archiveSettings.isPending}
          onCancel={() => {
            setDiscarding(null);
            setDiscardError(undefined);
          }}
          onConfirm={confirmDiscard}
        />
      )}

      {publishing && (
        <PublishDialog
          title={t("tax.settings.publishTitle", {
            version: publishing.version,
          })}
          description={t("tax.publish.body")}
          error={publishError}
          pending={publishSettings.isPending}
          onCancel={() => {
            setPublishing(null);
            setPublishError(undefined);
          }}
          onConfirm={confirmPublish}
        />
      )}
    </>
  );
}
