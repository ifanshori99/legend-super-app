// Tenant Owner section for Super Admin (legend-be0lx; mockup
// design/mockups/platform/owner-be0lx.html): shows the current Owner, assigns
// the first one and replaces it. Every change needs a reason and a fresh TOTP
// code (TEN-04); the API audits each attempt.
//
// Mount: <OwnerSection tenantId={tenant.id} tenantName={tenant.name} /> inside
// tenant-detail-page.tsx. It reads and writes through owner-hooks.ts only.
import * as React from "react";
import { CircleAlert, CircleCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useSaveTenantOwner, useTenantOwner } from "../owner-hooks";
import {
  accountLabel,
  classifyOwnerError,
  OWNER_COPY as C,
  OWNER_REASON_MAX,
  OWNER_TOTP_LENGTH,
  ownerDisplay,
  ownerLine,
  ownerView,
  sanitizeTotp,
  validateOwnerForm,
  type OwnerAccountOption,
  type OwnerFieldErrors,
  type OwnerFormMode,
  type OwnerFormValues,
  type OwnerSummary,
} from "../owner-state";

const EMPTY_FORM: OwnerFormValues = { account: "", reason: "", code: "" };

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <CardShell>
      <CardShellBody className="p-card">{children}</CardShellBody>
    </CardShell>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: "danger" | "success";
  children: React.ReactNode;
}) {
  const Icon = tone === "danger" ? CircleAlert : CircleCheck;
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={
        tone === "danger"
          ? "flex items-start gap-2 rounded-field border-l-4 border-danger bg-danger-subtle px-4 py-3 text-sm text-danger"
          : "flex items-start gap-2 rounded-field border-l-4 border-success bg-success-subtle px-4 py-3 text-sm text-success"
      }
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p>{children}</p>
    </div>
  );
}

function Guide() {
  return (
    <Shell>
      <h4 className="type-title">{C.guideTitle}</h4>
      <p className="mt-1 text-sm text-muted-foreground">{C.guideBody}</p>
    </Shell>
  );
}

function CurrentOwner({
  owner,
  tenantName,
  compact = false,
  onReplace,
}: {
  owner: OwnerSummary;
  tenantName: string;
  /** Success view of the mockup: the account only, no name row. */
  compact?: boolean;
  onReplace: () => void;
}) {
  const display = ownerDisplay(owner);
  return (
    <Shell>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="type-title">{C.currentTitle}</h4>
          <p className="mt-0.5 text-sm text-muted-foreground">{tenantName}</p>
        </div>
        <Badge tone="success">{C.active}</Badge>
      </div>
      <dl className="mt-4 grid gap-4 border-t-(length:--border-w) pt-4">
        {owner.name && !compact && (
          <div className="grid gap-0.5">
            <dt className="text-sm font-semibold text-muted-foreground">
              {C.name}
            </dt>
            <dd className="font-semibold [overflow-wrap:anywhere]">
              {display.name}
            </dd>
          </div>
        )}
        <div className="grid gap-0.5">
          <dt className="text-sm font-semibold text-muted-foreground">
            {C.account}
          </dt>
          <dd className="font-semibold [overflow-wrap:anywhere]">
            {display.account}
          </dd>
        </div>
      </dl>
      <div className="mt-5">
        <Button type="button" onClick={onReplace}>
          {C.replaceAction}
        </Button>
      </div>
    </Shell>
  );
}

function OwnerForm({
  tenantId,
  mode,
  current,
  accounts,
  onCancel,
  onSaved,
}: {
  tenantId: string;
  mode: OwnerFormMode;
  current: OwnerSummary | null;
  accounts: readonly OwnerAccountOption[];
  onCancel: () => void;
  onSaved: (mode: OwnerFormMode) => void;
}) {
  const replace = mode === "replace";
  const save = useSaveTenantOwner(tenantId);
  const [values, setValues] = React.useState<OwnerFormValues>(EMPTY_FORM);
  const [errors, setErrors] = React.useState<OwnerFieldErrors>({});
  const [banner, setBanner] = React.useState<string | null>(null);
  const listId = React.useId();

  const set = (field: keyof OwnerFormValues, value: string) => {
    setValues((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) => ({ ...previous, [field]: undefined }));
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setBanner(null);
    const check = validateOwnerForm(values, { mode, current, accounts });
    if (!check.ok) {
      setErrors(check.errors);
      return;
    }
    setErrors({});
    save.mutate(
      {
        mode,
        assignmentId: current?.assignmentId ?? null,
        userId: check.userId,
        option: check.option,
        reason: values.reason.trim(),
        mfaCode: values.code.trim(),
      },
      {
        onSuccess: () => onSaved(mode),
        onError: (failure) => {
          const result = classifyOwnerError(failure);
          if (result.kind === "field")
            setErrors({ [result.field]: result.message });
          else setBanner(result.message);
        },
      },
    );
  };

  return (
    <div className="grid gap-4">
      {banner && (
        <Banner tone="danger">
          <strong>{C.failedTitle}</strong> {banner}
        </Banner>
      )}
      <div className="grid items-start gap-5 md:grid-cols-[1.2fr_0.8fr]">
        <Shell>
          <form onSubmit={submit} noValidate className="grid gap-4">
            <div>
              <h4 className="type-title">
                {replace ? C.formTitleReplace : C.formTitleAssign}
              </h4>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {replace && current
                  ? C.formHintReplace(ownerLine(current))
                  : C.formHintAssign}
              </p>
            </div>
            <FormField
              label={replace ? C.accountLabelReplace : C.accountLabelAssign}
              hint={C.accountHint}
              error={errors.account}
              required
            >
              <Input
                value={values.account}
                onChange={(event) => set("account", event.target.value)}
                placeholder={C.accountPlaceholder}
                autoComplete="off"
                list={accounts.length > 0 ? listId : undefined}
              />
            </FormField>
            {accounts.length > 0 && (
              <datalist id={listId}>
                {accounts.map((option) => (
                  <option key={option.userId} value={accountLabel(option)} />
                ))}
              </datalist>
            )}
            <FormField
              label={C.reasonLabel}
              error={errors.reason}
              required
            >
              <Textarea
                rows={3}
                maxLength={OWNER_REASON_MAX}
                value={values.reason}
                onChange={(event) => set("reason", event.target.value)}
              />
            </FormField>
            <FormField
              label={C.totpLabel}
              hint={errors.code ? undefined : C.totpHint}
              error={errors.code}
              required
            >
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={OWNER_TOTP_LENGTH}
                value={values.code}
                onChange={(event) => set("code", sanitizeTotp(event.target.value))}
                placeholder={C.totpPlaceholder}
                className="tabular"
              />
            </FormField>
            <p className="rounded-field bg-surface-2 px-3.5 py-3 text-sm">
              {C.note}
            </p>
            <div className="flex flex-wrap gap-2.5 max-sm:[&>button]:flex-1">
              <Button
                type="button"
                variant="outline"
                onClick={onCancel}
                disabled={save.isPending}
              >
                {C.cancel}
              </Button>
              <Button
                type="submit"
                aria-busy={save.isPending || undefined}
                disabled={save.isPending}
              >
                {save.isPending
                  ? C.submitting
                  : replace
                    ? C.replaceAction
                    : C.assignAction}
              </Button>
            </div>
          </form>
        </Shell>
        <Guide />
      </div>
    </div>
  );
}

export function OwnerSection({
  tenantId,
  tenantName,
  accounts = [],
}: {
  tenantId: string;
  tenantName: string;
  /** Accounts the Super Admin can pick; when empty, an account id is typed. */
  accounts?: readonly OwnerAccountOption[];
}) {
  const query = useTenantOwner(tenantId);
  const [form, setForm] = React.useState<OwnerFormMode | null>(null);
  const [saved, setSaved] = React.useState<OwnerFormMode | null>(null);

  const owner = query.data ?? null;
  const view = ownerView({
    loading: query.isPending,
    loadFailed: query.isError,
    owner,
    form,
  });

  const open = (mode: OwnerFormMode) => {
    setSaved(null);
    setForm(mode);
  };

  let body: React.ReactNode;
  if (view === "loading") {
    body = (
      <Shell>
        <div aria-busy="true">
          <h4 className="type-title">{C.loadingTitle}</h4>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {C.loadingBody}
          </p>
          <div className="mt-4 grid gap-3">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-2/5" />
          </div>
        </div>
      </Shell>
    );
  } else if (view === "load-error") {
    body = (
      <Shell>
        <div role="alert" className="grid justify-items-start gap-3">
          <div>
            <h4 className="type-title">{C.loadErrorTitle}</h4>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {C.loadErrorBody}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void query.refetch()}
          >
            {C.retry}
          </Button>
        </div>
      </Shell>
    );
  } else if (view === "assign" || view === "replace") {
    body = (
      <OwnerForm
        key={view}
        tenantId={tenantId}
        mode={view}
        current={owner}
        accounts={accounts}
        onCancel={() => setForm(null)}
        onSaved={(mode) => {
          setForm(null);
          setSaved(mode);
        }}
      />
    );
  } else if (view === "empty") {
    body = (
      <Shell>
        <div className="grid justify-items-center gap-2 px-2 py-8 text-center">
          <h4 className="type-title">{C.emptyTitle}</h4>
          <p className="max-w-sm text-sm text-muted-foreground">
            {C.emptyBody(tenantName)}
          </p>
          <div className="mt-2">
            <Button type="button" onClick={() => open("assign")}>
              {C.assignAction}
            </Button>
          </div>
        </div>
      </Shell>
    );
  } else if (owner && saved) {
    // Mockup success state: the saved Owner alone, without the guide card.
    body = (
      <CurrentOwner
        owner={owner}
        tenantName={tenantName}
        compact
        onReplace={() => open("replace")}
      />
    );
  } else if (owner) {
    body = (
      <div className="grid items-start gap-5 md:grid-cols-[1.2fr_0.8fr]">
        <CurrentOwner
          owner={owner}
          tenantName={tenantName}
          onReplace={() => open("replace")}
        />
        <Guide />
      </div>
    );
  }

  return (
    <section
      aria-labelledby={`owner-${tenantId}-title`}
      className="grid min-w-0 gap-4"
    >
      <div>
        <h3 id={`owner-${tenantId}-title`} className="type-title">
          {C.title}
        </h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {C.subtitle(tenantName)}
        </p>
      </div>
      {saved && (
        <Banner tone="success">
          <strong>
            {saved === "assign" ? C.successAssigned : C.successReplaced}
          </strong>{" "}
          {C.successBody}
        </Banner>
      )}
      {body}
    </section>
  );
}
