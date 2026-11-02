import * as React from "react";
import { Check, Copy, RotateCw } from "lucide-react";
import type { TotpEnrollment } from "@starter/shared/identity";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { QrCode } from "@/components/ui/qr-code";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { enrollmentErrorKey, secondFactorErrorKey } from "../errors";
import { formatTime } from "../format";
import { useEnrollMfa, useVerifyMfa } from "../hooks";
import { isTotpCodeComplete, normalizeTotpCode } from "../state";

/**
 * TOTP enrollment (PRD §3 F6 "Staf — Login Web": MFA via TOTP). The secret is
 * shown once by the contract; the factor becomes active only after a correct
 * six-digit code, which is the same call that finishes enrollment.
 */
export function TotpEnrollFlow({ onEnrolled }: { onEnrolled: () => void }) {
  const t = useT();
  const toast = useToast();
  const enroll = useEnrollMfa();
  const verify = useVerifyMfa();
  const [enrollment, setEnrollment] = React.useState<TotpEnrollment | null>(
    null,
  );
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const { mutate: startEnrollment, isPending: starting } = enroll;

  // One request when the flow appears; a failed request shows the retry
  // button and does not loop. The mutation itself is idempotent on the server.
  React.useEffect(() => {
    if (enrollment || starting || error) return;
    startEnrollment(
      { type: "totp" },
      {
        onSuccess: (result) => {
          if (result.type === "totp") setEnrollment(result);
        },
        onError: (cause) => setError(t(enrollmentErrorKey(cause))),
      },
    );
  }, [enrollment, starting, error, startEnrollment, t]);

  function retry() {
    setError(null);
  }

  async function copySecret(secret: string) {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      toast({ title: t("staffAuth.enroll.copied"), tone: "success" });
    } catch {
      // Clipboard can be blocked; the key stays selectable in the field.
      setCopied(false);
    }
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!enrollment || !isTotpCodeComplete(code)) return;
    setError(null);
    verify.mutate(
      { factorId: enrollment.factorId, code: normalizeTotpCode(code) },
      {
        onSuccess: () => {
          toast({ title: t("staffAuth.enroll.success"), tone: "success" });
          onEnrolled();
        },
        onError: (cause) => setError(t(secondFactorErrorKey(cause))),
      },
    );
  }

  if (error && !enrollment) {
    return (
      <div className="grid gap-3" role="alert">
        <p className="text-sm leading-5 text-danger">{error}</p>
        <Button variant="outline" onClick={retry}>
          <RotateCw aria-hidden="true" />
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  if (!enrollment) {
    return (
      <div className="grid gap-3" aria-busy="true">
        <span className="sr-only">{t("common.loading")}</span>
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-11 w-full" />
      </div>
    );
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <div className="flex flex-col gap-3 rounded-lg border-(length:--border-w) bg-muted p-3 sm:flex-row sm:items-start">
        <QrCode
          value={enrollment.otpauthUri}
          label={t("staffAuth.enroll.qrLabel")}
          size={132}
          className="self-center rounded-lg border bg-card p-2 sm:self-start"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-5 font-semibold">
            {t("staffAuth.enroll.secretLabel")}
          </p>
          <code className="mt-1 block rounded-md border bg-card px-3 py-2 font-mono text-sm break-all select-all">
            {enrollment.secretBase32}
          </code>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            {t("staffAuth.enroll.expires", {
              time: formatTime(enrollment.expiresAt),
            })}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => copySecret(enrollment.secretBase32)}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {t("staffAuth.enroll.copySecret")}
        </Button>
        <Button asChild variant="outline">
          <a href={enrollment.otpauthUri}>{t("staffAuth.enroll.openUri")}</a>
        </Button>
      </div>

      <p className="text-sm leading-5 text-muted-foreground">
        {t("staffAuth.enroll.secretHint")}
      </p>

      <FormField
        label={t("staffAuth.enroll.codeLabel")}
        hint={t("staffAuth.enroll.codeHint")}
        error={error ?? undefined}
        required
      >
        <Input
          value={code}
          onChange={(event) => setCode(normalizeTotpCode(event.target.value))}
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          className="max-w-40 text-center font-mono text-lg tracking-[0.3em] tabular"
        />
      </FormField>

      <Button
        type="submit"
        loading={verify.isPending}
        disabled={!isTotpCodeComplete(code)}
      >
        {t("staffAuth.enroll.submit")}
      </Button>
    </form>
  );
}
