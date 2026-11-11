// The WhatsApp reverse-OTP panel (PRD v1.7 §3 F3 "Pelanggan — WhatsApp Reverse
// OTP", §4 Alur C; AUTH-01/AUTH-03). Used by /masuk as the primary sign-in and
// by /masuk/hubungkan to attach a number to a signed-in account.
//
// The guest asks for a challenge, gets an 8-symbol code bound to this browser,
// opens WhatsApp with the message filled in (QR on a desktop), and sends it.
// This browser polls its own challenge and signs in by itself. The system never
// sends a WhatsApp message; the code lives only in component state and is shown
// once. States: start → waiting → (message landed: confirm card) → signed in /
// expired / cancelled / browser mismatch / rate limited, plus inline failures
// with a retry.
//
// With a confirm step (bead kmndq) the sign-in does not finish when the message
// lands: the card shows the masked sender the API reports and asks "Masuk
// sebagai nomor ini?". "Ya, masuk" confirms; "Bukan saya" cancels the code and
// returns to the start with a message.
import { useEffect, useRef, useState } from "react";
import {
  CircleSlash,
  Clock3,
  Hourglass,
  MessageCircle,
  ShieldAlert,
  ShieldCheck,
  TimerOff,
  type LucideIcon,
} from "lucide-react";
import type { LoginChallengeIssued, Session } from "@starter/shared/identity";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { QrCode } from "@/components/ui/qr-code";
import { API_MOCK } from "@/lib/api/mock-flag.ts";
import {
  challengeFailure,
  formatRemaining,
  loginChallengeOutcome,
  loginCodeRemainingMs,
  type ChallengeFailure,
} from "../flow";
import {
  useCancelWhatsAppLogin,
  useConfirmWhatsAppLogin,
  useLoginChallenge,
  useStartWhatsAppLogin,
} from "../hooks";
import { InlineFailure, Notice, useNow, type NoticeTone } from "./shared";

/** Copy that differs between signing in and linking a number. */
export type WhatsAppCopy = {
  heading: string;
  hint: string;
  action: string;
};

/** Every way a code can end; each one offers a fresh code. */
type EndState = ChallengeFailure | "cancelled";

const END_COPY: Record<
  EndState,
  {
    title: MessageKey;
    hint: MessageKey;
    tone: NoticeTone;
    icon: LucideIcon;
    /** A fresh code helps for every end except "belongs to another account". */
    restart?: boolean;
  }
> = {
  expired: {
    title: "login.whatsapp.expiredTitle",
    hint: "login.whatsapp.expiredHint",
    tone: "warning",
    icon: Clock3,
  },
  mismatch: {
    title: "login.whatsapp.mismatchTitle",
    hint: "login.whatsapp.mismatchHint",
    tone: "danger",
    icon: ShieldAlert,
  },
  used: {
    title: "login.whatsapp.usedTitle",
    hint: "login.whatsapp.usedHint",
    tone: "warning",
    icon: Clock3,
  },
  rateLimited: {
    title: "login.whatsapp.rateLimitedTitle",
    hint: "login.whatsapp.rateLimitedHint",
    tone: "warning",
    icon: TimerOff,
  },
  alreadyLinked: {
    title: "login.link.alreadyLinkedTitle",
    hint: "login.link.alreadyLinkedHint",
    tone: "danger",
    icon: ShieldAlert,
    restart: false,
  },
  cancelled: {
    title: "login.whatsapp.cancelledTitle",
    hint: "login.whatsapp.cancelledHint",
    tone: "muted",
    icon: CircleSlash,
  },
};

export function WhatsAppLogin({
  copy,
  returnTo,
  onSignedIn,
}: {
  copy: WhatsAppCopy;
  /** Where the API returns after sign-in; the parent decides the landing. */
  returnTo?: string;
  onSignedIn: (result: { session: Session; mfaRequired: boolean }) => void;
}) {
  const t = useT();
  const [issued, setIssued] = useState<LoginChallengeIssued | null>(null);
  const [checking, setChecking] = useState(false);
  // "Bukan saya" was tapped: the start view shows why there is no code.
  const [declined, setDeclined] = useState(false);
  const handled = useRef(false);
  const start = useStartWhatsAppLogin();
  const cancel = useCancelWhatsAppLogin();
  const confirm = useConfirmWhatsAppLogin();
  const poll = useLoginChallenge(issued?.challenge.id ?? null);
  const view = poll.data;

  const now = useNow(issued !== null);
  // The clock never runs behind the code's own issue time, so a screen that
  // sat idle before the code existed still counts from the code's real start.
  const judgedAt = issued
    ? Math.max(now, Date.parse(issued.challenge.createdAt))
    : now;
  const outcome = view
    ? loginChallengeOutcome(view, judgedAt)
    : issued
      ? "pending"
      : null;
  const failure = poll.error
    ? challengeFailure(poll.error)
    : start.error
      ? challengeFailure(start.error)
      : confirm.error
        ? challengeFailure(confirm.error)
        : null;
  // A local countdown that reached zero is expired per the contract's own rule
  // (isLoginChallengeExpired), even before the server sweeps the row; a
  // challenge another tab cancelled reads as cancelled here too.
  const endState: EndState | null =
    failure ??
    (outcome === "expired"
      ? "expired"
      : outcome === "cancelled"
        ? "cancelled"
        : null);

  useEffect(() => {
    if (outcome !== "signed_in" || !view?.session || handled.current) return;
    handled.current = true;
    onSignedIn({ session: view.session, mfaRequired: view.mfaRequired });
  }, [outcome, view, onSignedIn]);

  async function begin() {
    handled.current = false;
    setDeclined(false);
    cancel.reset();
    confirm.reset();
    try {
      setIssued(await start.mutateAsync(returnTo));
    } catch {
      // Rendered from start.error below.
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

  async function decline() {
    await abort();
    setDeclined(true);
  }

  async function accept() {
    if (!issued) return;
    try {
      await confirm.mutateAsync(issued.challenge.id);
    } catch {
      // Rendered from confirm.error below, or as an end state.
    }
  }

  async function check() {
    setChecking(true);
    try {
      await poll.refetch();
    } finally {
      setChecking(false);
    }
  }

  // ---------------------------------------------------------------- end states
  if (endState) {
    const meta = END_COPY[endState];
    return (
      <Notice
        tone={meta.tone}
        icon={meta.icon}
        title={t(meta.title)}
        hint={t(meta.hint)}
        live
        action={
          meta.restart === false ? undefined : (
            <Button
              size="lg"
              className="w-full sm:w-auto"
              loading={start.isPending}
              onClick={() => void begin()}
            >
              {t("login.whatsapp.restart")}
            </Button>
          )
        }
      />
    );
  }

  // -------------------------------------------------------------- start state
  if (issued === null) {
    return (
      <section aria-labelledby="login-whatsapp-heading" className="grid gap-4">
        {declined && (
          <Notice
            tone="muted"
            icon={CircleSlash}
            title={t("login.whatsapp.declined")}
            live
          />
        )}
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-container bg-surface-3 text-muted-foreground">
            <MessageCircle className="size-5" aria-hidden="true" />
          </span>
          <div className="grid min-w-0 gap-1">
            <h2 id="login-whatsapp-heading" className="font-brand type-title">
              {copy.heading}
            </h2>
            <p className="text-sm leading-5 text-muted-foreground">
              {copy.hint}
            </p>
          </div>
        </div>
        <Button
          size="lg"
          className="w-full"
          loading={start.isPending}
          onClick={() => void begin()}
        >
          <MessageCircle aria-hidden="true" />
          {copy.action}
        </Button>
        {start.isError && <InlineFailure error={start.error} />}
        <p className="text-sm leading-5 text-muted-foreground">
          {t("login.whatsapp.noReply")}
        </p>
      </section>
    );
  }

  // ------------------------------------------------------- confirm card state
  if (outcome === "awaiting_confirmation" && view) {
    return (
      <section
        aria-labelledby="login-confirm-heading"
        className="grid gap-4"
      >
        <h2 id="login-confirm-heading" className="sr-only">
          {t("login.whatsapp.confirmHeading")}
        </h2>
        <div
          role="status"
          aria-live="polite"
          className="flex items-start gap-3 rounded-container bg-surface-2 p-card"
        >
          <span className="grid size-10 shrink-0 place-items-center rounded-container bg-background/70">
            <ShieldCheck className="size-5" aria-hidden="true" />
          </span>
          <p className="min-w-0 pt-2 type-heading">
            {t("login.whatsapp.confirmPrompt", {
              sender: view.senderMasked ?? "",
            })}
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Button
            size="lg"
            className="w-full"
            loading={confirm.isPending}
            disabled={cancel.isPending}
            onClick={() => void accept()}
          >
            {t("login.whatsapp.confirmYes")}
          </Button>
          <Button
            size="lg"
            variant="outline"
            className="w-full"
            loading={cancel.isPending}
            disabled={confirm.isPending}
            onClick={() => void decline()}
          >
            {t("login.whatsapp.confirmNo")}
          </Button>
        </div>
        {confirm.isError && (
          <InlineFailure error={confirm.error} onRetry={() => void accept()} />
        )}
        <p className="text-sm leading-5 text-muted-foreground">
          {t("login.whatsapp.confirmHint")}
        </p>
      </section>
    );
  }

  // ---------------------------------------------------------- waiting state
  const { challenge } = issued;
  const expiryLine = t("login.whatsapp.expiresIn", {
    time: formatRemaining(loginCodeRemainingMs(challenge, judgedAt)),
  });

  return (
    <section aria-labelledby="login-challenge-heading" className="grid gap-5">
      <div className="grid gap-1">
        <h2
          id="login-challenge-heading"
          className="type-eyebrow text-muted-foreground"
        >
          {t("login.whatsapp.codeLabel")}
        </h2>
        <p
          className="font-mono type-display tracking-widest tabular"
          aria-live="polite"
        >
          {issued.codeFormatted}
        </p>
        <p className="text-sm leading-5 text-muted-foreground tabular">
          {expiryLine}
        </p>
      </div>

      <div className="grid gap-4 border-t-(length:--border-w) pt-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
        <div className="hidden sm:block">
          <QrCode
            value={issued.whatsAppDeepLink}
            label={t("login.whatsapp.qrLabel", { code: issued.codeFormatted })}
            size={148}
            className="rounded-container border-(length:--border-w) p-2"
          />
        </div>
        <div className="grid gap-3">
          <Button asChild size="lg" className="w-full">
            <a
              href={issued.whatsAppDeepLink}
              target="_blank"
              rel="noopener noreferrer"
            >
              <MessageCircle aria-hidden="true" />
              {t("login.whatsapp.openWhatsApp")}
            </a>
          </Button>
          <p className="hidden text-sm leading-5 text-muted-foreground sm:block">
            {t("login.whatsapp.qrHint")}
          </p>
        </div>
      </div>

      <ol className="grid gap-2 text-sm leading-5">
        {(
          [
            ["step1", "login.whatsapp.step1"],
            ["step2", "login.whatsapp.step2"],
            ["step3", "login.whatsapp.step3"],
          ] as const
        ).map(([step, key], index) => (
          <li key={step} className="flex items-start gap-2">
            <span
              aria-hidden="true"
              className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-surface-3 text-xs font-semibold tabular"
            >
              {index + 1}
            </span>
            <span className="min-w-0">{t(key)}</span>
          </li>
        ))}
      </ol>

      <p
        role="status"
        className="flex items-center gap-2 rounded-container bg-surface-2 px-3 py-2 text-sm leading-5 font-medium"
      >
        <Hourglass className="size-4 shrink-0" aria-hidden="true" />
        {t("login.whatsapp.waiting")}
      </p>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          loading={checking}
          onClick={() => void check()}
        >
          {t("login.whatsapp.sent")}
        </Button>
        <Button
          variant="ghost"
          loading={cancel.isPending}
          onClick={() => void abort()}
        >
          {t("login.whatsapp.cancel")}
        </Button>
      </div>

      {poll.isError && (
        <InlineFailure error={poll.error} onRetry={() => void check()} />
      )}

      <p className="text-sm leading-5 text-muted-foreground">
        {t("login.whatsapp.noReply")}
      </p>
      {API_MOCK && (
        <p className="text-sm leading-5 text-muted-foreground">
          {t("login.whatsapp.mockHint")}
        </p>
      )}
    </section>
  );
}
