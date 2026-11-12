// Restore an archived tenant or a closed outlet within 30 days (bead
// legend-nb4iy, Q40). Mounted by the tenant detail page: one section for an
// archived tenant, one inline panel per closed outlet. States follow
// design/mockups/platform/restore-nb4iy.html: loading, empty, error, review,
// confirm with a required reason, validation, blocked, expired and success.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { Check, Clock } from "lucide-react";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  useOutletRestoreWindow,
  useRestoreOutlet,
  useRestoreTenant,
  useTenantRestoreWindow,
} from "../restore-hooks";
import {
  RESTORE_REASON_MAX,
  classifyRestoreError,
  formatRestoreDate,
  restoreView,
  validateRestoreReason,
  type RestoreFailure,
  type RestoreKind,
} from "../restore-state";

const k = (key: string) => `platformTenants.restore.${key}` as MessageKey;

type Target = { kind: RestoreKind; tenantId: string; outletId?: string };

/** Window read for either kind, with the same shape for the screen. */
function useRestoreWindow(target: Target) {
  const tenant = useTenantRestoreWindow(target.tenantId);
  const outlet = useOutletRestoreWindow(
    target.tenantId,
    target.outletId ?? "",
  );
  return target.kind === "tenant" ? tenant : outlet;
}

function useRestoreAction(target: Target) {
  const tenant = useRestoreTenant(target.tenantId);
  const outlet = useRestoreOutlet(target.tenantId, target.outletId ?? "");
  return target.kind === "tenant" ? tenant : outlet;
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <CardShell>
      <CardShellBody className="p-card">{children}</CardShellBody>
    </CardShell>
  );
}

function Banner({
  tone,
  title,
  silent,
  children,
}: {
  tone: "success" | "danger" | "warning";
  title: string;
  /** No own live role: a live region that already exists announces it. */
  silent?: boolean;
  children?: React.ReactNode;
}) {
  const style = {
    success: "bg-success-subtle text-success",
    danger: "bg-danger-subtle text-danger",
    warning: "bg-warning-subtle text-warning",
  }[tone];
  return (
    <p
      role={silent ? undefined : tone === "danger" ? "alert" : "status"}
      className={`rounded-container border-(length:--border-w) p-card text-sm ${style}`}
    >
      <strong className="font-semibold">{title}</strong>
      {children ? ` ${children}` : null}
    </p>
  );
}

function Fact({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid content-start gap-0.5 border-t-(length:--border-w) py-3">
      <dt className="type-eyebrow text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">
        {children}
        {hint && (
          <span className="block text-xs font-normal text-muted-foreground">
            {hint}
          </span>
        )}
      </dd>
    </div>
  );
}

function Heading({
  name,
  caption,
  pill,
}: {
  name: string;
  caption: string;
  pill: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h3 className="type-title break-words">{name}</h3>
        <p className="text-xs text-muted-foreground">{caption}</p>
      </div>
      {pill}
    </div>
  );
}

type SectionProps = {
  kind: RestoreKind;
  tenantId: string;
  outletId?: string;
  /** Tenant or outlet name shown in the summary. */
  name: string;
  /** Parent tenant name, shown under an outlet. */
  tenantName?: string;
  /** Status of the parent tenant, read by an outlet panel. */
  parentStatus?: string;
  /** Words for a restoreTo status ("active" -> "Aktif"). */
  statusLabel: (status: string) => string;
};

/**
 * The success banner lives in a status region that is already in the page
 * before the restore ends, so screen readers announce it when it fills.
 */
export function RestoreSection(props: SectionProps) {
  const t = useT();
  const [restoredTo, setRestoredTo] = React.useState<string | null>(null);
  const success = `platformTenants.restore.${props.kind}.success`;
  return (
    <div>
      <div
        role="status"
        aria-live="polite"
        className={restoredTo !== null ? "mb-3" : undefined}
      >
        {restoredTo !== null && (
          <Banner silent tone="success" title={`✓ ${t(success as MessageKey)}`}>
            {t(`${success}Body` as MessageKey, {
              status: props.statusLabel(restoredTo).toLowerCase(),
            })}
          </Banner>
        )}
      </div>
      <RestoreBody
        {...props}
        restoredTo={restoredTo}
        onRestored={setRestoredTo}
      />
    </div>
  );
}

function RestoreBody({
  kind,
  tenantId,
  outletId,
  name,
  tenantName,
  parentStatus,
  statusLabel,
  restoredTo,
  onRestored,
}: SectionProps & {
  restoredTo: string | null;
  onRestored: (status: string) => void;
}) {
  const t = useT();
  const target: Target = { kind, tenantId, outletId };
  const win = useRestoreWindow(target);
  const mutation = useRestoreAction(target);
  const [step, setStep] = React.useState<"review" | "confirm">("review");
  const [reason, setReason] = React.useState("");
  const [reasonError, setReasonError] = React.useState(false);
  const [failure, setFailure] = React.useState<RestoreFailure | null>(null);
  const confirmTitle = React.useRef<HTMLHeadingElement>(null);
  // Review -> confirm swaps the whole panel: move focus to the new title so
  // keyboard and screen reader users land on the confirm step.
  React.useEffect(() => {
    if (step === "confirm") confirmTitle.current?.focus();
  }, [step]);
  const kt = (key: string) => k(`${kind}.${key}`);
  const caption =
    kind === "outlet" && tenantName
      ? `${tenantName} · ${t(kt("kind"))}`
      : t(kt("kind"));

  // Success outranks everything: the refetch after the write already reports
  // the record as restored, which would otherwise read as "empty".
  if (restoredTo !== null)
    return (
      <Panel>
        <Heading
          name={name}
          caption={caption}
          pill={
            <Badge tone="neutral">
              <Check aria-hidden="true" />
              {statusLabel(restoredTo)}
            </Badge>
          }
        />
        {kind === "tenant" && (
          <div className="mt-5">
            <Button asChild variant="outline">
              <Link to="/platform/tenant">{t(k("backToList"))}</Link>
            </Button>
          </div>
        )}
      </Panel>
    );

  if (win.isPending)
    return (
      <Panel>
        <div role="status" aria-busy="true" aria-label={t(kt("loading"))}>
          <h3 className="type-title">{t(kt("loading"))}</h3>
          <Skeleton className="mt-4 h-4 w-[55%]" />
          <Skeleton className="mt-3 h-4 w-[85%]" />
          <Skeleton className="mt-3 h-4 w-[65%]" />
          <p className="mt-3 text-xs text-muted-foreground">
            {t(k("loadingHint"))}
          </p>
        </div>
      </Panel>
    );

  if (win.isError)
    return (
      <div className="grid gap-3">
        <Banner tone="danger" title={t(k("errorBanner"))} />
        <Panel>
          <EmptyState
            title={t(k("errorTitle"))}
            description={t(k("errorBody"))}
            action={
              <Button variant="outline" onClick={() => void win.refetch()}>
                {t("common.retry")}
              </Button>
            }
          />
        </Panel>
      </div>
    );

  const view = restoreView(kind, win.data.data, parentStatus);

  if (view.kind === "none")
    return (
      <Panel>
        <EmptyState
          title={t(kt("emptyTitle"))}
          description={t(kt("emptyBody"))}
        />
      </Panel>
    );

  const changedLabel = t(kt("changedOn"));

  // Outlet inside its window, parent tenant still archived: not final.
  if (view.kind === "parent_archived" || failure === "parent_archived")
    return (
      <div className="grid gap-3">
        <Banner tone="warning" title={t(k("parentArchivedTitle"))}>
          {t(k("outlet.parentArchivedBody"))}
        </Banner>
        <Panel>
          <Heading
            name={name}
            caption={caption}
            pill={<Badge tone="warning">{t(kt("pill"))}</Badge>}
          />
          <dl className="my-4">
            <Fact label={changedLabel}>
              {formatRestoreDate(view.changedAt)}
            </Fact>
            <Fact label={t(k("windowLimit"))}>
              {formatRestoreDate(view.restorableUntil)}
            </Fact>
          </dl>
          <p className="rounded-control bg-surface-2 p-3 text-sm">
            {t(k("parentArchivedNote"))}
          </p>
        </Panel>
      </div>
    );

  // Final: past 30 days, or the change time was never recorded.
  if (view.kind === "expired" || failure === "expired")
    return (
      <div className="grid gap-3">
        <Banner tone="warning" title={t(k("expiredTitle"))}>
          {t(k("expiredBanner"))}
        </Banner>
        <Panel>
          <Heading
            name={name}
            caption={caption}
            pill={<Badge tone="neutral">{t(kt("pill"))}</Badge>}
          />
          <dl className="my-4">
            <Fact label={changedLabel}>
              {formatRestoreDate(view.changedAt)}
            </Fact>
            <Fact label={t(k("windowLimit"))}>
              {formatRestoreDate(view.restorableUntil)}
            </Fact>
          </dl>
          <p className="text-sm text-muted-foreground">{t(k("expiredBody"))}</p>
        </Panel>
      </div>
    );

  const previous = statusLabel(view.restoreTo);
  const summary = (
    <>
      <Heading
        name={name}
        caption={caption}
        pill={
          <Badge tone="warning">
            <Clock aria-hidden="true" />
            {t(kt("pill"))}
          </Badge>
        }
      />
      <dl className="my-4">
        <Fact label={t(k("previousStatus"))}>{previous}</Fact>
        <Fact label={changedLabel}>{formatRestoreDate(view.changedAt)}</Fact>
        <Fact label={t(k("windowLimit"))} hint={t(k("windowHint"))}>
          {formatRestoreDate(view.restorableUntil)}
        </Fact>
      </dl>
    </>
  );

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const checked = validateRestoreReason(reason);
    if (!checked.ok) {
      setReasonError(true);
      return;
    }
    setReasonError(false);
    setFailure(null);
    mutation.mutate(
      { reason: checked.value },
      {
        onSuccess: () => onRestored(view.restoreTo),
        onError: (error) => {
          const next = classifyRestoreError(error, kind);
          setFailure(next);
          // A 409 means the window moved on: read the current state again.
          if (
            next === "expired" ||
            next === "not_available" ||
            next === "parent_archived"
          )
            void win.refetch();
        },
      },
    );
  };

  const backToReview = () => {
    setStep("review");
    setReason("");
    setReasonError(false);
    setFailure(null);
  };

  if (failure === "not_available")
    return (
      <div className="grid gap-3">
        <Banner tone="warning" title={t(k("notAvailableTitle"))}>
          {t(kt("notAvailableBody"))}
        </Banner>
        <Panel>
          {summary}
          <p className="rounded-control bg-surface-2 p-3 text-sm">
            {t(k("notAvailableNote"))}
          </p>
          <div className="mt-5">
            <Button variant="outline" onClick={backToReview}>
              {t(k("back"))}
            </Button>
          </div>
        </Panel>
      </div>
    );

  if (failure === "blocked")
    return (
      <div className="grid gap-3">
        <Banner tone="danger" title={t(k("blockedTitle"))}>
          {t(kt("blockedBody"))}
        </Banner>
        <Panel>
          {summary}
          <p className="rounded-control bg-surface-2 p-3 text-sm">
            {t(k("blockedNote"))}
          </p>
          <div className="mt-5">
            <Button variant="outline" onClick={backToReview}>
              {t(k("back"))}
            </Button>
          </div>
        </Panel>
      </div>
    );

  if (step === "review")
    return (
      <Panel>
        {summary}
        <p className="rounded-control bg-surface-2 p-3 text-sm">
          {t(kt("note"))}
        </p>
        <div className="mt-5">
          <Button onClick={() => setStep("confirm")}>{t(k("review"))}</Button>
        </div>
      </Panel>
    );

  const problem =
    failure === "network"
      ? t(k("offline"))
      : failure === "unknown"
        ? t(k("failed"))
        : undefined;

  return (
    <Panel>
      <form onSubmit={submit} noValidate className="grid max-w-[700px] gap-4">
        <div>
          <h3
            ref={confirmTitle}
            tabIndex={-1}
            className="type-title outline-none"
          >
            {t(kt("confirmTitle"))}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(kt("confirmLead"))}
          </p>
        </div>
        <div>{summary}</div>
        <p className="rounded-control bg-surface-2 p-3 text-sm">
          {t(kt("confirmNote"), { status: previous })}
        </p>
        <FormField
          label={t(k("reason"))}
          hint={t(k("reasonHint"))}
          error={reasonError ? t(k("reasonError")) : problem}
          required
        >
          <Textarea
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              if (reasonError && validateRestoreReason(event.target.value).ok)
                setReasonError(false);
            }}
            placeholder={t(k("reasonPlaceholder"))}
            rows={4}
            maxLength={RESTORE_REASON_MAX}
          />
        </FormField>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button
            type="button"
            variant="outline"
            className="w-full sm:w-auto"
            onClick={backToReview}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            className="w-full sm:w-auto"
            aria-busy={mutation.isPending || undefined}
            disabled={mutation.isPending}
          >
            {t(kt("confirm"))}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
