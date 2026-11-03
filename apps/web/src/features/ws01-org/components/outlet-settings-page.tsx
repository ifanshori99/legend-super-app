// Outlet settings (bead legend-1mi5; PRD v1.7 §3 "Pengaturan", owner Q39).
// Lists the tenant's outlets (GET /api/org/outlets) and edits one through the
// contract's PATCH: name, address and the business-day cutoff ("Jam tutup
// buku", contracts.md D-CORE-7). The cutoff is the only business-date setting
// a manager changes here; time zone stays the outlet's IANA zone.
//
// Business dates use the outlet clock, never the device clock. The form wraps
// itself in a nested TenantProvider whose `overrides` carry the cutoff being
// edited, so the live business-date preview follows the field through
// `useOutletClock()` (lib/tenant-context.tsx documents this settings-screen
// use case). The app-wide provider stays where it is: its config source is the
// tenant-context bead's, not this screen's.
import * as React from "react";
import { CircleAlert, Store } from "lucide-react";
import { z } from "zod";
import { businessDateOf, businessDayCutoffSchema } from "@starter/shared/core";
import type { Outlet } from "@starter/shared/platform";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardShell,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { API_MOCK } from "@/lib/api/mock-flag";
import { TenantProvider, useOutletClock } from "@/lib/tenant-context";
import { useOnline } from "@/lib/use-online";
import { useOutlets, useUpdateOutlet } from "../hooks";
import { useOrgOutletT } from "../t";

const OUTLET_LIST_LIMIT = 100;

/** Same client shape as `updateOutletInputSchema` (platform/org.ts). */
const formSchema = z.object({
  name: z.string().trim().min(1).max(150),
  address: z.string().trim().min(1).max(500),
  businessDayCutoff: businessDayCutoffSchema,
});

const businessDateFormat = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** "2026-11-03" → "3 Nov 2026", locale-stable (id-ID, UTC). */
function formatBusinessDate(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  return businessDateFormat.format(new Date(Date.UTC(year, month - 1, day)));
}

export function OutletSettingsPage() {
  const t = useT();
  const tt = useOrgOutletT();
  const online = useOnline();
  const outletsQuery = useOutlets({ limit: OUTLET_LIST_LIMIT });

  if (outletsQuery.isPending)
    return (
      <div className="grid gap-3" aria-busy="true">
        <span className="sr-only">{t("common.loading")}</span>
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-64" />
      </div>
    );

  if (outletsQuery.isError)
    return (
      <ErrorState
        title={online ? undefined : tt("orgOutlet.offline")}
        onRetry={() => void outletsQuery.refetch()}
      />
    );

  const outlets = outletsQuery.data?.data ?? [];
  if (outlets.length === 0)
    return (
      <EmptyState
        icon={Store}
        title={t("state.emptyTitle")}
        description={t("state.emptyHint")}
      />
    );

  return <OutletSettingsScreen outlets={outlets} online={online} />;
}

function OutletSettingsScreen({
  outlets,
  online,
}: {
  outlets: readonly Outlet[];
  online: boolean;
}) {
  const t = useT();
  const tt = useOrgOutletT();
  const [selectedId, setSelectedId] = React.useState(
    () => outlets[0]?.id ?? "",
  );
  const selected =
    outlets.find((outlet) => outlet.id === selectedId) ?? outlets[0];

  if (!selected) return null;

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <h2 className="type-title">{tt("orgOutlet.title")}</h2>
          <p className="max-w-2xl text-sm leading-5 text-muted-foreground">
            {tt("orgOutlet.subtitle")}
          </p>
        </div>
        {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <CardShell className="self-start">
          <Card className="gap-3">
            <h3 className="type-heading">{tt("orgOutlet.listTitle")}</h3>
            <ul className="grid gap-1">
              {outlets.map((outlet) => {
                const current = outlet.id === selected.id;
                return (
                  <li key={outlet.id}>
                    <button
                      type="button"
                      aria-pressed={current}
                      onClick={() => setSelectedId(outlet.id)}
                      className={[
                        "grid w-full min-w-0 gap-1 rounded-control border-(length:--border-w) px-3 py-2 text-start transition-colors duration-(--duration-fast)",
                        // Selection reads in ink, not accent (DESIGN.md
                        // accent budget: the Save CTA owns the accent).
                        current
                          ? "border-border bg-surface-3"
                          : "border-transparent hover:bg-surface-2",
                      ].join(" ")}
                    >
                      <span className="flex min-w-0 items-center justify-between gap-2">
                        <span className="truncate text-sm leading-5 font-semibold">
                          {outlet.name}
                        </span>
                        <Badge tone="neutral">{outlet.code}</Badge>
                      </span>
                      <span className="truncate text-sm leading-5 text-muted-foreground tabular">
                        {outlet.timeZone} · {outlet.businessDayCutoff}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>
        </CardShell>

        <OutletForm key={selected.id} outlet={selected} online={online} />
      </div>
    </div>
  );
}

type FormValues = { name: string; address: string; businessDayCutoff: string };

function initialValues(outlet: Outlet): FormValues {
  return {
    name: outlet.name,
    address: outlet.address,
    businessDayCutoff: outlet.businessDayCutoff,
  };
}

/**
 * One outlet's settings form. It is mounted inside a nested TenantProvider so
 * `useOutletClock()` in the preview sees the cutoff being edited (owner Q39);
 * a failed save leaves the provider on the last valid value.
 */
function OutletForm({ outlet, online }: { outlet: Outlet; online: boolean }) {
  const t = useT();
  const tt = useOrgOutletT();
  const toast = useToast();
  const updateOutlet = useUpdateOutlet();

  const [values, setValues] = React.useState<FormValues>(() =>
    initialValues(outlet),
  );
  const [errors, setErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  const [formError, setFormError] = React.useState<string | undefined>();
  const [saved, setSaved] = React.useState(false);

  const update = (patch: Partial<FormValues>) =>
    setValues((current) => ({ ...current, ...patch }));

  // The preview needs a valid clock; while the field is invalid it keeps the
  // outlet's last saved cutoff instead of throwing inside businessDateOf.
  const cutoffValid = businessDayCutoffSchema.safeParse(
    values.businessDayCutoff,
  ).success;
  const previewCutoff = cutoffValid
    ? values.businessDayCutoff
    : outlet.businessDayCutoff;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = formSchema.safeParse({
      name: values.name.trim(),
      address: values.address.trim(),
      businessDayCutoff: values.businessDayCutoff.trim(),
    });
    if (!parsed.success) {
      const next: Record<string, string | undefined> = {};
      for (const issue of parsed.error.issues)
        next[String(issue.path[0] ?? "")] = t("form.invalid");
      setErrors(next);
      setFormError(
        t("form.errorSummary", { count: parsed.error.issues.length }),
      );
      setSaved(false);
      return;
    }

    setErrors({});
    setFormError(undefined);
    setSaved(false);
    updateOutlet.mutate(
      { outletId: outlet.id, body: parsed.data },
      {
        onSuccess: (result) => {
          setValues(initialValues(result.data));
          setSaved(true);
          toast({ title: tt("orgOutlet.saved"), tone: "success" });
        },
        onError: (error) =>
          setFormError(
            error instanceof ApiError
              ? error.message
              : tt("orgOutlet.saveFailed"),
          ),
      },
    );
  }

  return (
    <TenantProvider
      config={{
        outlet: {
          id: outlet.id,
          name: outlet.name,
          timeZone: outlet.timeZone,
          businessDayCutoff: outlet.businessDayCutoff,
        },
      }}
      overrides={{ outlet: { businessDayCutoff: previewCutoff } }}
    >
      <div className="grid min-w-0 gap-4">
        <CardShell>
          <Card>
            <CardHeader>
              <CardTitle>{outlet.name}</CardTitle>
              <CardDescription className="tabular">
                {outlet.code} · {outlet.timeZone}
              </CardDescription>
            </CardHeader>
            <form
              onSubmit={submit}
              noValidate
              className="grid gap-4"
              aria-busy={updateOutlet.isPending || undefined}
            >
              <FormField
                label={tt("orgOutlet.fields.name")}
                id="outlet-name"
                error={errors.name}
                required
              >
                <Input
                  id="outlet-name"
                  value={values.name}
                  onChange={(event) => update({ name: event.target.value })}
                  autoComplete="off"
                  maxLength={150}
                />
              </FormField>

              <FormField
                label={tt("orgOutlet.fields.address")}
                id="outlet-address"
                error={errors.address}
                required
              >
                <Textarea
                  id="outlet-address"
                  value={values.address}
                  onChange={(event) => update({ address: event.target.value })}
                  rows={3}
                  maxLength={500}
                />
              </FormField>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="outlet-time-zone">
                    {tt("orgOutlet.fields.timeZone")}
                  </Label>
                  <Input
                    id="outlet-time-zone"
                    value={outlet.timeZone}
                    readOnly
                    className="bg-muted"
                  />
                  <p className="text-sm leading-5 text-muted-foreground">
                    {tt("orgOutlet.timeZoneHint")}
                  </p>
                </div>

                <FormField
                  label={tt("orgOutlet.fields.cutoff")}
                  id="outlet-cutoff"
                  hint={tt("orgOutlet.cutoffHint", {
                    cutoff: values.businessDayCutoff,
                  })}
                  error={errors.businessDayCutoff}
                  required
                >
                  <Input
                    id="outlet-cutoff"
                    value={values.businessDayCutoff}
                    onChange={(event) =>
                      update({ businessDayCutoff: event.target.value })
                    }
                    placeholder="04:00"
                    maxLength={5}
                    autoComplete="off"
                    spellCheck={false}
                    className="tabular"
                  />
                </FormField>
              </div>

              {formError && (
                <p
                  role="alert"
                  className="flex items-start gap-1.5 rounded-control border-(length:--border-w) border-danger bg-danger-subtle px-3 py-2 text-sm font-medium text-danger"
                >
                  <CircleAlert
                    className="mt-0.5 size-4 shrink-0"
                    aria-hidden="true"
                  />
                  <span>{formError}</span>
                </p>
              )}

              {saved && (
                <p
                  role="status"
                  className="rounded-control border-(length:--border-w) border-success bg-success-subtle px-3 py-2 text-sm font-medium text-success"
                >
                  {tt("orgOutlet.saved")}
                </p>
              )}

              <div className="flex justify-end">
                <Button
                  type="submit"
                  loading={updateOutlet.isPending}
                  disabled={!online}
                >
                  {t("common.save")}
                </Button>
              </div>
            </form>
          </Card>
        </CardShell>

        <BusinessDayPreview />
      </div>
    </TenantProvider>
  );
}

/**
 * What "today" means for this outlet under the cutoff being edited (D-CORE-7):
 * the local date of (now − cutoff) in the outlet time zone. Reads the nested
 * provider through the same hook every screen uses, so the preview cannot
 * drift from the real business-date maths.
 */
function BusinessDayPreview() {
  const t = useT();
  const tt = useOrgOutletT();
  const { clock } = useOutletClock();
  const today = businessDateOf(new Date(), clock);

  return (
    <CardShell>
      <Card>
        <CardHeader>
          <CardTitle>{tt("orgOutlet.previewTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-0.5">
              <dt className="text-sm leading-5 text-muted-foreground">
                {t("opname.create.businessDate")}
              </dt>
              <dd className="text-(length:--density-text) font-semibold tabular">
                <time dateTime={today} data-testid="outlet-business-date">
                  {formatBusinessDate(today)}
                </time>
              </dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-sm leading-5 text-muted-foreground">
                {tt("orgOutlet.fields.cutoff")}
              </dt>
              <dd className="text-(length:--density-text) font-semibold tabular">
                {clock.cutoff} · {clock.timeZone}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-sm leading-5 text-muted-foreground">
            {tt("orgOutlet.previewHint")}
          </p>
        </CardContent>
      </Card>
    </CardShell>
  );
}
