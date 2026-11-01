// Step 1 of the facility journey: WhatsApp login (PRD §3 F22 Titik Masuk,
// alur S langkah 2: "Pemesanan wajib login dengan WhatsApp terverifikasi").
//
// Reverse OTP from the identity contract (AUTH-01/AUTH-03): the guest gets a
// one-time 8-symbol code bound to this browser, opens WhatsApp with the
// message already filled in (QR on a desktop), sends it, and this screen
// continues once its polled challenge carries a session. Nothing is typed and
// no message is sent to the guest; the code lives only in component state.
import { useEffect, useState } from "react";
import { MessageCircle, ShieldCheck } from "lucide-react";
import type { LoginChallengeIssued } from "@starter/shared/identity";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/i18n";
import { API_MOCK } from "@/lib/api/mock-flag.ts";
import { formatClock, loginChallengeOutcome } from "../flow";
import {
  useCancelWhatsAppLogin,
  useLoginChallenge,
  useStartWhatsAppLogin,
} from "../hooks";
import { AccessTicketQr } from "./access-ticket-qr";
import { ApiFailure } from "./shared";

export function LoginStep({
  returnTo,
  onVerified,
}: {
  /** Path the API sends the guest back to (returnPathSchema). */
  returnTo?: string;
  onVerified: () => void;
}) {
  const t = useT();
  const [issued, setIssued] = useState<LoginChallengeIssued | null>(null);
  const start = useStartWhatsAppLogin();
  const cancel = useCancelWhatsAppLogin();
  const poll = useLoginChallenge(issued?.challenge.id ?? null);

  // Judged at the moment of the last poll (polling runs every 2 s while
  // pending), so render stays pure and a dead code still reads as expired.
  const outcome = poll.data
    ? loginChallengeOutcome(poll.data, poll.dataUpdatedAt)
    : issued
      ? "pending"
      : null;

  useEffect(() => {
    if (outcome === "signed_in") onVerified();
  }, [outcome, onVerified]);

  async function begin() {
    cancel.reset();
    try {
      setIssued(await start.mutateAsync(returnTo));
    } catch {
      // Rendered by ApiFailure below.
    }
  }

  async function abort() {
    if (!issued) return;
    try {
      await cancel.mutateAsync(issued.challenge.id);
    } catch {
      // A failed cancel still drops the code here; it expires on its own.
    }
    setIssued(null);
  }

  const ended = outcome === "expired" || outcome === "cancelled";

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="flex items-center gap-2 text-xl leading-7 font-semibold">
          <ShieldCheck className="size-5" aria-hidden="true" />
          {t("facility.login.title")}
        </h2>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("facility.login.hint")}
        </p>
      </div>

      {issued === null || ended ? (
        <div className="grid gap-3">
          {ended && (
            <div className="grid gap-0.5 rounded-lg bg-muted px-3 py-2 text-sm leading-5">
              <p className="font-semibold">
                {t("facility.login.expiredTitle")}
              </p>
              <p className="text-muted-foreground">
                {t("facility.login.expiredHint")}
              </p>
            </div>
          )}
          <Button size="lg" loading={start.isPending} onClick={() => begin()}>
            <MessageCircle aria-hidden="true" />
            {ended ? t("facility.login.restart") : t("facility.login.start")}
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 rounded-xl border-(length:--border-w) bg-card p-card">
          <div className="grid gap-1">
            <p className="text-sm leading-5 font-medium text-muted-foreground">
              {t("facility.login.codeLabel")}
            </p>
            <p className="font-mono text-3xl leading-tight font-semibold tracking-widest tabular">
              {issued.codeFormatted}
            </p>
            <p className="text-sm leading-5 text-muted-foreground tabular">
              {t("facility.login.expiresAt", {
                time: formatClock(issued.challenge.expiresAt),
              })}
            </p>
          </div>

          <Button asChild size="lg">
            <a href={issued.whatsAppDeepLink} target="_blank" rel="noopener">
              <MessageCircle aria-hidden="true" />
              {t("facility.login.openWhatsApp")}
            </a>
          </Button>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("facility.login.sendHint")}
          </p>

          <div className="hidden gap-2 sm:grid sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
            <AccessTicketQr
              value={issued.whatsAppDeepLink}
              label={t("facility.login.qrLabel")}
            />
            <p className="text-sm leading-5 text-muted-foreground">
              {t("facility.login.qrHint")}
            </p>
          </div>

          <p
            role="status"
            className="text-sm leading-5 font-medium text-foreground"
          >
            {t("facility.login.waiting")}
          </p>

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void poll.refetch()}>
              {t("facility.login.sent")}
            </Button>
            <Button
              variant="ghost"
              onClick={() => void abort()}
              loading={cancel.isPending}
            >
              {t("facility.login.cancel")}
            </Button>
          </div>
        </div>
      )}

      {start.isError && (
        <ApiFailure error={start.error} onRetry={() => void begin()} />
      )}
      {poll.isError && (
        <ApiFailure error={poll.error} onRetry={() => void poll.refetch()} />
      )}

      {API_MOCK && (
        <p className="text-sm leading-5 text-muted-foreground">
          {t("facility.login.mockHint")}
        </p>
      )}
    </div>
  );
}
