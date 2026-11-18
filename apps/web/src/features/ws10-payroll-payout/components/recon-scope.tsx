// Batch card and loading shapes of the recon screen. The batch card also
// stands in (with "—" or 0) while there is no batch to pick: loading, error,
// empty.
import * as React from "react";
import { cn } from "cn";
import { formatRupiah } from "@starter/shared/i18n";
import type { PayoutReconFlagDto } from "@starter/shared/types";
import { useT } from "@/components/i18n";
import { FormField } from "@/components/ui/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PAYROLL_TIME_ZONE } from "../../ws10-payroll-run/outlet";
import type { ReconFacts } from "./recon-facts";
import { heldPayslipIds, heldSlipValue, shortId } from "./recon-model";

/** Day the newest flag of a batch was raised; the list carries no batch date. */
function flagDate(
  flags: readonly PayoutReconFlagDto[],
  batchId: string,
): string {
  const newest = flags
    .filter((flag) => flag.batchId === batchId)
    .map((flag) => flag.flaggedAt)
    .sort()
    .at(-1);
  return newest
    ? new Intl.DateTimeFormat("id-ID", {
        dateStyle: "medium",
        timeZone: PAYROLL_TIME_ZONE,
      }).format(new Date(newest))
    : "—";
}

export function ScopeCard({
  batchIds,
  flags,
  batchId,
  facts,
  batchFlags,
  truncated,
  onBatch,
}: {
  batchIds: string[];
  flags: readonly PayoutReconFlagDto[];
  batchId: string | undefined;
  facts: ReconFacts;
  batchFlags: typeof flags;
  truncated: boolean;
  onBatch: (id: string) => void;
}) {
  const t = useT();
  const value = heldSlipValue(batchFlags, facts.items);
  // A cut list can hide held flags: the held figures are a minimum then.
  const minimum = truncated ? "+" : "";
  const unknown = t("payrollPayoutReview.recon.unknown");
  const stats = [
    {
      label: t("payrollPayoutReview.recon.scope.flags"),
      value: String(batchFlags.length),
      wide: false,
    },
    {
      label: t("payrollPayoutReview.recon.scope.held"),
      value: `${heldPayslipIds(batchFlags).length}${minimum}`,
      wide: false,
    },
    {
      label: t("payrollPayoutReview.recon.scope.heldValue"),
      value: value === null ? unknown : `${formatRupiah(value)}${minimum}`,
      wide: true,
    },
  ];
  return (
    <ScopeFrame
      stats={stats}
      note={truncated ? t("payrollPayoutReview.recon.scope.incomplete") : null}
      field={
        <FormField
          required
          label={t("payrollPayoutReview.recon.scope.batch")}
          hint={
            facts.batchState === "ready" && facts.channel
              ? t("payrollPayoutReview.recon.scope.meta", {
                  items: facts.itemCount ?? 0,
                  channel: t(`payrollPayoutReview.channel.${facts.channel}`),
                })
              : facts.batchState === "unavailable"
                ? t("payrollPayoutReview.recon.scope.metaUnavailable")
                : undefined
          }
        >
          <Select value={batchId} onValueChange={onBatch}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {batchIds.map((id) => (
                <SelectItem key={id} value={id}>
                  {t("payrollPayoutReview.recon.scope.option", {
                    id: shortId(id),
                    count: flags.filter((flag) => flag.batchId === id).length,
                    date: flagDate(flags, id),
                  })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      }
    />
  );
}

type ScopeStat = { label: string; value: string; wide: boolean };

/** The batch card: picker on the left, three figures on the right. */
function ScopeFrame({
  field,
  stats,
  note,
}: {
  field: React.ReactNode;
  stats: ScopeStat[];
  note: string | null;
}) {
  const t = useT();
  return (
    <section
      aria-label={t("payrollPayoutReview.recon.scope.batch")}
      className="rounded-container border-(length:--border-w) bg-card p-4 sm:p-5"
    >
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
        <div className="grid min-w-0 gap-1 sm:max-w-md">{field}</div>
        <dl className="grid grid-cols-2 gap-4 tabular sm:grid-cols-3">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className={cn(
                "flex min-w-0 flex-col-reverse",
                stat.wide && "max-sm:col-span-2",
              )}
            >
              <dt className="text-xs text-muted-foreground">{stat.label}</dt>
              <dd className="text-xl leading-7 font-semibold whitespace-nowrap">
                {stat.value}
              </dd>
            </div>
          ))}
        </dl>
        {note && (
          <p
            role="note"
            className="text-xs text-muted-foreground md:col-span-2"
          >
            {note}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * The batch card while there is no batch to pick (loading, error, empty): the
 * figures read "—" when unknown and 0 only when the list really is empty.
 */
export function PlaceholderScope({
  kind,
}: {
  kind: "loading" | "error" | "empty";
}) {
  const t = useT();
  const unknown = t("payrollPayoutReview.recon.unknown");
  const empty = kind === "empty";
  const stats: ScopeStat[] = [
    {
      label: t("payrollPayoutReview.recon.scope.flags"),
      value: empty ? "0" : unknown,
      wide: false,
    },
    {
      label: t("payrollPayoutReview.recon.scope.held"),
      value: empty ? "0" : unknown,
      wide: false,
    },
    {
      label: t("payrollPayoutReview.recon.scope.heldValue"),
      value: empty ? formatRupiah(0) : unknown,
      wide: true,
    },
  ];
  const placeholder = {
    loading: "payrollPayoutReview.recon.scope.placeholderLoading",
    error: "payrollPayoutReview.recon.scope.placeholderError",
    empty: "payrollPayoutReview.recon.scope.placeholderEmpty",
  } as const;
  return (
    <ScopeFrame
      stats={stats}
      note={null}
      field={
        <FormField required label={t("payrollPayoutReview.recon.scope.batch")}>
          <Select disabled>
            <SelectTrigger>
              <SelectValue placeholder={t(placeholder[kind])} />
            </SelectTrigger>
            <SelectContent />
          </Select>
        </FormField>
      }
    />
  );
}

export function PanelSkeleton() {
  const t = useT();
  return (
    <div
      role="status"
      aria-label={t("payrollPayoutReview.recon.loading")}
      className="grid gap-4 rounded-container border-(length:--border-w) bg-card p-4 sm:p-5"
    >
      <p className="text-lg font-semibold">
        {t("payrollPayoutReview.recon.loading")}
      </p>
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-11 w-full" />
    </div>
  );
}

export function ReconSkeleton() {
  const t = useT();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <header className="max-w-3xl text-sm leading-5 text-muted-foreground">
        {t("payrollPayoutReview.recon.subtitle")}
      </header>
      <PlaceholderScope kind="loading" />
      <div
        role="status"
        aria-label={t("payrollPayoutReview.recon.loading")}
        className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"
      >
        <section className="min-w-0 rounded-container border-(length:--border-w) bg-card p-4 sm:p-5">
          <h2 className="text-lg font-semibold">
            {t("payrollPayoutReview.recon.loading")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("payrollPayoutReview.recon.loadingHint")}
          </p>
          {[0, 1, 2].map((row) => (
            <div key={row} className="mt-4 grid gap-2 border-t pt-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
        </section>
        <div className="grid gap-4 rounded-container border-(length:--border-w) bg-card p-4 sm:p-5">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      </div>
    </div>
  );
}
