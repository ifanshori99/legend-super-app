// Super Admin opens a support session (PRD v1.7 §3 F4 "Support Access", TEN-04):
// tenant, written reason (required), duration (60 minutes by default),
// read-only scope and a fresh authenticator code.
import * as React from "react";
import { Eye, Pencil, ShieldCheck } from "lucide-react";
import {
  requestSupportAccessInputSchema,
  requestSupportWriteAccessInputSchema,
  SUPPORT_ACCESS_DEFAULT_MINUTES,
  SUPPORT_ACCESS_DURATIONS,
  SUPPORT_ACCESS_WRITE_DEFAULT_MINUTES,
  SUPPORT_ACCESS_WRITE_DURATIONS,
  type SupportAccessMode,
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
import {
  useRequestSupportAccess,
  useRequestSupportWriteAccess,
} from "../hooks.ts";
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
  const readRequest = useRequestSupportAccess();
  const writeRequest = useRequestSupportWriteAccess();
  const [mode, setMode] = React.useState<SupportAccessMode>("read_only");
  const writeMode = mode === "read_write";
  const request = writeMode ? writeRequest : readRequest;
  const durations: readonly number[] = writeMode
    ? SUPPORT_ACCESS_WRITE_DURATIONS
    : SUPPORT_ACCESS_DURATIONS;
  const defaultMinutes = writeMode
    ? SUPPORT_ACCESS_WRITE_DEFAULT_MINUTES
    : SUPPORT_ACCESS_DEFAULT_MINUTES;

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
    setMode("read_only");
    setErrors({});
    setServerError(null);
    readRequest.reset();
    writeRequest.reset();
  };

  const changeOpen = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const changeMode = (next: string) => {
    const nextMode = next as SupportAccessMode;
    setMode(nextMode);
    // 60 and 120 minutes are read-only durations; read_write caps at 30.
    setDuration(
      String(
        nextMode === "read_write"
          ? SUPPORT_ACCESS_WRITE_DEFAULT_MINUTES
          : SUPPORT_ACCESS_DEFAULT_MINUTES,
      ),
    );
    setServerError(null);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setServerError(null);
    const nextErrors: Errors = {};
    if (!tenantId)
      nextErrors.tenant = t("supportAccess.request.tenantRequired");
    const parsed = (
      writeMode
        ? requestSupportWriteAccessInputSchema
        : requestSupportAccessInputSchema
    ).safeParse({
      reason,
      durationMinutes: Number(duration),
      ...(writeMode ? {} : { accessMode: "read_only" }),
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
    const handlers = {
      onSuccess: () => {
        toast({
          title: t(
            writeMode
              ? "supportAccess.request.sentToOwner"
              : "supportAccess.request.started",
          ),
        });
        changeOpen(false);
      },
      onError: (failure: unknown) =>
        setServerError(supportErrorMessage(failure, t)),
    };
    if (writeMode)
      writeRequest.mutate(
        {
          tenantId,
          body: parsed.data as Parameters<
            typeof writeRequest.mutate
          >[0]["body"],
        },
        handlers,
      );
    else
      readRequest.mutate(
        {
          tenantId,
          body: parsed.data as Parameters<typeof readRequest.mutate>[0]["body"],
        },
        handlers,
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
                  {durations.map((minutes) => (
                    <SelectItem key={minutes} value={String(minutes)}>
                      {t(
                        minutes === defaultMinutes
                          ? "supportAccess.request.durationDefault"
                          : "supportAccess.request.durationOption",
                        { minutes },
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField
              id="support-request-scope"
              label={t("supportAccess.request.scope")}
              required
            >
              <Select value={mode} onValueChange={changeMode}>
                <SelectTrigger id="support-request-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="read_only">
                    {t("supportAccess.request.scopeReadOnly")}
                  </SelectItem>
                  <SelectItem value="read_write">
                    {t("supportAccess.request.scopeReadWrite")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          </div>
          <p className="-mt-2 text-sm text-muted-foreground">
            {writeMode ? (
              <Pencil
                className="mr-1 inline size-4 text-warning"
                aria-hidden="true"
              />
            ) : (
              <Eye
                className="mr-1 inline size-4 text-info"
                aria-hidden="true"
              />
            )}
            {t(
              writeMode
                ? "supportAccess.request.scopeWriteHint"
                : "supportAccess.request.scopeHint",
            )}
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
              {t(
                writeMode
                  ? "supportAccess.request.submitWrite"
                  : "supportAccess.request.submit",
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
