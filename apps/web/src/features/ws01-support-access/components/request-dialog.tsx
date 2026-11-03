// Super Admin opens a support session (PRD v1.7 §3 F4 "Support Access", TEN-04):
// tenant, written reason (required), duration (60 minutes by default),
// read-only scope and a fresh authenticator code.
import * as React from "react";
import { Eye, ShieldCheck } from "lucide-react";
import {
  requestSupportAccessInputSchema,
  SUPPORT_ACCESS_DEFAULT_MINUTES,
  SUPPORT_ACCESS_DURATIONS,
  type Tenant,
} from "@starter/shared/platform";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { supportErrorMessage } from "../errors.ts";
import { useRequestSupportAccess } from "../hooks.ts";
import {
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
  sanitizeMfaCode,
} from "../logic.ts";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenants: readonly Tenant[];
  tenantsState: "loading" | "error" | "ready";
};

type Errors = { tenant?: string; reason?: string; mfa?: string };

export function RequestSupportAccessDialog({
  open,
  onOpenChange,
  tenants,
  tenantsState,
}: Props) {
  const t = useT();
  const toast = useToast();
  const request = useRequestSupportAccess();

  const [tenantId, setTenantId] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [duration, setDuration] = React.useState(
    String(SUPPORT_ACCESS_DEFAULT_MINUTES),
  );
  const [code, setCode] = React.useState("");
  const [errors, setErrors] = React.useState<Errors>({});
  const [serverError, setServerError] = React.useState<string | null>(null);

  const reset = () => {
    setTenantId("");
    setReason("");
    setDuration(String(SUPPORT_ACCESS_DEFAULT_MINUTES));
    setCode("");
    setErrors({});
    setServerError(null);
    request.reset();
  };

  const changeOpen = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setServerError(null);
    const nextErrors: Errors = {};
    if (!tenantId)
      nextErrors.tenant = t("supportAccess.request.tenantRequired");
    const parsed = requestSupportAccessInputSchema.safeParse({
      reason,
      durationMinutes: Number(duration),
      accessMode: "read_only",
      mfaCode: code,
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === "reason")
          nextErrors.reason ??= t("supportAccess.request.reasonMin", {
            min: REASON_MIN_LENGTH,
          });
        if (issue.path[0] === "mfaCode")
          nextErrors.mfa ??= t("supportAccess.request.mfaInvalid");
      }
    }
    setErrors(nextErrors);
    if (!parsed.success || nextErrors.tenant) return;
    request.mutate(
      { tenantId, body: parsed.data },
      {
        onSuccess: () => {
          toast({ title: t("supportAccess.request.started") });
          changeOpen(false);
        },
        onError: (failure) => setServerError(supportErrorMessage(failure, t)),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="sm:max-w-xl">
        <form className="grid gap-4" onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>{t("supportAccess.request.title")}</DialogTitle>
            <DialogDescription>
              {t("supportAccess.request.description")}
            </DialogDescription>
          </DialogHeader>

          <FormField
            id="support-request-tenant"
            label={t("supportAccess.request.tenant")}
            error={errors.tenant}
            required
          >
            <Select value={tenantId} onValueChange={setTenantId}>
              <SelectTrigger
                id="support-request-tenant"
                aria-required="true"
                aria-invalid={errors.tenant ? true : undefined}
              >
                <SelectValue
                  placeholder={t("supportAccess.request.tenantPlaceholder")}
                />
              </SelectTrigger>
              <SelectContent>
                {tenants.map((row) => (
                  <SelectItem key={row.id} value={row.id}>
                    {row.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          {tenantsState === "error" && (
            <p className="text-sm text-danger" role="alert">
              {t("supportAccess.request.tenantsFailed")}
            </p>
          )}
          {tenantsState === "ready" && tenants.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {t("supportAccess.request.tenantsEmpty")}
            </p>
          )}

          <FormField
            label={t("supportAccess.request.reason")}
            hint={t("supportAccess.request.reasonHint")}
            error={errors.reason}
            required
          >
            <Textarea
              rows={4}
              maxLength={REASON_MAX_LENGTH}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </FormField>
          <p className="-mt-2 text-right text-xs text-muted-foreground tabular">
            {t("supportAccess.request.reasonCount", {
              count: reason.trim().length,
              max: REASON_MAX_LENGTH,
            })}
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              id="support-request-duration"
              label={t("supportAccess.request.duration")}
              required
            >
              <Select value={duration} onValueChange={setDuration}>
                <SelectTrigger id="support-request-duration">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUPPORT_ACCESS_DURATIONS.map((minutes) => (
                    <SelectItem key={minutes} value={String(minutes)}>
                      {t(
                        minutes === SUPPORT_ACCESS_DEFAULT_MINUTES
                          ? "supportAccess.request.durationDefault"
                          : "supportAccess.request.durationOption",
                        { minutes },
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <div className="grid content-start gap-1.5">
              <p className="text-sm font-semibold">
                {t("supportAccess.request.scope")}
              </p>
              <p className="inline-flex min-h-control items-center gap-2 rounded-control border-(length:--border-w) bg-surface-2 px-3 text-sm font-semibold">
                <Eye className="size-4 text-info" aria-hidden="true" />
                {t("supportAccess.request.scopeValue")}
              </p>
            </div>
          </div>
          <p className="-mt-2 text-sm text-muted-foreground">
            {t("supportAccess.request.scopeHint")}
          </p>

          <div className="grid gap-3 rounded-container border-(length:--border-w) p-3">
            <p className="inline-flex items-center gap-2 text-sm font-semibold">
              <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
              {t("supportAccess.request.mfaTitle")}
            </p>
            <p className="text-sm text-muted-foreground">
              {t("supportAccess.request.mfaHint")}
            </p>
            <FormField
              label={t("supportAccess.request.mfaCode")}
              error={errors.mfa}
              required
            >
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(event) =>
                  setCode(sanitizeMfaCode(event.target.value))
                }
                className="tabular tracking-[0.3em]"
              />
            </FormField>
          </div>

          {serverError && (
            <p className="text-sm text-danger" role="alert">
              {serverError}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => changeOpen(false)}
            >
              {t("supportAccess.request.cancel")}
            </Button>
            <Button type="submit" loading={request.isPending}>
              {t("supportAccess.request.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
