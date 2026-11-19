// Card 1 "Login ChatGPT": the primary AI service. Device-code login in five
// states (disconnected, pending, connected, failed, expired). The API decides
// who may manage (`viewerCanManage`, owner only); the UI only presents it.
// `disabled` is the platform kill switch: every control is off except the way
// out ("Cabut koneksi", "Batalkan koneksi"), which stays open for the owner so
// access can always be cut. The reason is explained by the page banner.
import * as React from "react";
import { cn } from "cn";
import {
  Ban,
  Check,
  CircleCheck,
  Clock,
  Copy,
  ExternalLink,
  Circle,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ErrorState } from "@/components/ui/feedback-state";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AdminCard,
  isOfflineError,
} from "@/features/ws12-ai-admin/components/shared";
import { ApiError } from "@/lib/api/errors";
import { pollChatgpt } from "../api";
import { getChatgptLogin, type ChatgptLoginStatus } from "@starter/shared/ai";
import { useChatgptLogin, useRevokeChatgpt, useStartChatgpt } from "../hooks";
import { showsPlatformLock } from "./lock-status";
import { RevokeChatgptDialog } from "./revoke-chatgpt-dialog";

/** Milliseconds between status checks while a code is pending (the API rate-limits). */
const POLL_MS = 5000;
/** A 429 doubles the wait up to this ceiling. */
const POLL_MAX_MS = 60_000;
/** Consecutive failed checks before polling stops and asks the owner. */
const POLL_MAX_FAILURES = 5;
/** Wait after a hidden tab becomes visible again. */
const POLL_RESUME_MS = 1000;

export function ChatgptPanel({ disabled }: { disabled: boolean }) {
  const t = useT();
  const login = useChatgptLogin(true);

  if (login.isPending) {
    return (
      <AdminCard aria-busy="true" aria-labelledby="ai-chatgpt-title">
        <PanelHeading />
        <span className="sr-only" role="status">
          {t("aiSettingsChatgpt.loading")}
        </span>
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-11 w-48" />
      </AdminCard>
    );
  }
  if (!login.data) {
    const offline = isOfflineError(login.error);
    return (
      <AdminCard aria-labelledby="ai-chatgpt-title">
        <PanelHeading />
        <ErrorState
          error={login.error}
          title={t(
            offline
              ? "aiSettingsChatgpt.error.offlineTitle"
              : "aiSettingsChatgpt.error.title",
          )}
          description={t(
            offline
              ? "aiSettingsChatgpt.error.offlineHint"
              : "aiSettingsChatgpt.error.hint",
          )}
          onRetry={() => void login.refetch()}
        />
      </AdminCard>
    );
  }
  return (
    <ChatgptBody
      status={login.data.data}
      disabled={disabled}
      refreshFailed={login.isRefetchError}
    />
  );
}

function PanelHeading({
  badge,
  titleRef,
}: {
  badge?: React.ReactNode;
  titleRef?: React.Ref<HTMLHeadingElement>;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="grid gap-1">
        <p className="type-eyebrow text-muted-foreground">
          {t("aiSettingsChatgpt.eyebrow")}
        </p>
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="grid size-7 place-items-center rounded-control border-(length:--border-w) text-sm font-semibold text-primary"
          >
            {t("aiSettingsChatgpt.step")}
          </span>
          <h2
            id="ai-chatgpt-title"
            ref={titleRef}
            tabIndex={-1}
            className="type-title rounded-control focus-visible:shadow-focus focus-visible:outline-none"
          >
            {t("aiSettingsChatgpt.title")}
          </h2>
        </div>
      </div>
      {badge}
    </div>
  );
}

const BADGES: Record<
  "disconnected" | "pending" | "connected" | "retry" | "locked",
  {
    tone: React.ComponentProps<typeof Badge>["tone"];
    icon: LucideIcon;
    label:
      | "aiSettingsChatgpt.badge.disconnected"
      | "aiSettingsChatgpt.badge.pending"
      | "aiSettingsChatgpt.badge.connected"
      | "aiSettingsChatgpt.badge.retry"
      | "aiSettingsChatgpt.badge.locked";
  }
> = {
  disconnected: {
    tone: "neutral",
    icon: Circle,
    label: "aiSettingsChatgpt.badge.disconnected",
  },
  pending: {
    tone: "warning",
    icon: Clock,
    label: "aiSettingsChatgpt.badge.pending",
  },
  connected: {
    tone: "success",
    icon: CircleCheck,
    label: "aiSettingsChatgpt.badge.connected",
  },
  retry: {
    tone: "danger",
    icon: TriangleAlert,
    label: "aiSettingsChatgpt.badge.retry",
  },
  locked: {
    tone: "neutral",
    icon: Ban,
    label: "aiSettingsChatgpt.badge.locked",
  },
};

const ANNOUNCE: Record<
  ChatgptLoginStatus["state"],
  | "aiSettingsChatgpt.pending.waiting"
  | "aiSettingsChatgpt.connected.title"
  | "aiSettingsChatgpt.failed.title"
  | "aiSettingsChatgpt.expired.title"
  | "aiSettingsChatgpt.announce.disconnected"
> = {
  disconnected: "aiSettingsChatgpt.announce.disconnected",
  pending: "aiSettingsChatgpt.pending.waiting",
  connected: "aiSettingsChatgpt.connected.title",
  failed: "aiSettingsChatgpt.failed.title",
  expired: "aiSettingsChatgpt.expired.title",
};

function ChatgptBody({
  status: serverStatus,
  disabled,
  refreshFailed,
}: {
  status: ChatgptLoginStatus;
  disabled: boolean;
  refreshFailed: boolean;
}) {
  const t = useT();
  const [revokeOpen, setRevokeOpen] = React.useState(false);
  // The code the UI already treats as expired (its `expiresAt`), so a new code
  // starts fresh without clearing anything.
  const [expiredFor, setExpiredFor] = React.useState<string | null>(null);
  const status: ChatgptLoginStatus =
    serverStatus.state === "pending" &&
    serverStatus.expiresAt !== null &&
    expiredFor === serverStatus.expiresAt
      ? { ...serverStatus, state: "expired" }
      : serverStatus;
  // `disabled` is the tenant lock; `platformDisabled` is the global ChatGPT env switch.
  const off = disabled || status.platformDisabled;
  const locked = off || !status.viewerCanManage;
  // A locked card that is not connected reads "Dikunci platform", in step with
  // the page banner. A saved connection keeps its own status visible.
  const kind = showsPlatformLock(
    status.state,
    disabled,
    status.platformDisabled,
  )
    ? "locked"
    : status.state === "failed" || status.state === "expired"
      ? "retry"
      : status.state;
  const badge = BADGES[kind];
  const BadgeIcon = badge.icon;

  // A state change moves focus to the card title and is spoken once.
  const titleRef = React.useRef<HTMLHeadingElement>(null);
  const previous = React.useRef(status.state);
  const [announced, setAnnounced] = React.useState(status.state);
  const [announcement, setAnnouncement] = React.useState("");
  if (announced !== status.state) {
    setAnnounced(status.state);
    setAnnouncement(t(ANNOUNCE[status.state]));
  }
  React.useEffect(() => {
    if (previous.current === status.state) return;
    previous.current = status.state;
    // Never pull focus out of another card the visitor is working in.
    const active = document.activeElement;
    const card = titleRef.current?.closest("section");
    if (!active || active === document.body || card?.contains(active))
      titleRef.current?.focus();
  }, [status.state]);

  return (
    <AdminCard aria-labelledby="ai-chatgpt-title">
      <PanelHeading
        titleRef={titleRef}
        badge={
          <Badge tone={badge.tone}>
            <BadgeIcon aria-hidden="true" />
            {t(badge.label)}
          </Badge>
        }
      />
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {refreshFailed && (
        <p role="status" className="text-sm leading-5 text-muted-foreground">
          {t("aiSettingsChatgpt.error.refreshNote")}
        </p>
      )}
      {status.platformDisabled && (
        <Notice tone="warning" title={t("aiSettingsChatgpt.platformOff.title")}>
          {t("aiSettingsChatgpt.platformOff.body")}
        </Notice>
      )}
      {/* No `disabled` on the group: every control sets its own `locked`, so
          "Cabut" and "Batalkan" can stay open under the platform lock. */}
      <div className="grid min-w-0 gap-4">
        {status.state === "pending" ? (
          <PendingView
            status={status}
            locked={locked}
            onExpired={() => setExpiredFor(status.expiresAt)}
          />
        ) : status.state === "connected" ? (
          <ConnectedView
            canRevoke={status.viewerCanManage}
            onRevoke={() => setRevokeOpen(true)}
          />
        ) : (
          <DisconnectedView status={status} locked={locked} />
        )}
        {!status.viewerCanManage && (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("aiSettingsChatgpt.ownerOnly")}
          </p>
        )}
      </div>
      <RevokeChatgptDialog
        open={revokeOpen}
        onClose={() => setRevokeOpen(false)}
        onRevoked={() => titleRef.current?.focus()}
      />
    </AdminCard>
  );
}

function ActionError({ error }: { error: unknown }) {
  const t = useT();
  if (!error) return null;
  return (
    <p role="alert" className="text-sm leading-5 font-medium text-danger">
      {t(
        isOfflineError(error)
          ? "aiSettingsChatgpt.actionError.offline"
          : "aiSettingsChatgpt.actionError.generic",
      )}
    </p>
  );
}

function Notice({
  tone,
  title,
  children,
  role,
  large,
}: {
  tone: "warning" | "danger";
  title: string;
  children: string;
  role?: "alert";
  large?: boolean;
}) {
  return (
    <div
      role={role}
      className={cn(
        "grid gap-1 rounded-control border-(length:--border-w) p-3",
        large ? "text-base leading-6" : "text-sm leading-5",
        tone === "danger"
          ? "border-danger/40 bg-danger-subtle text-danger"
          : "border-warning bg-warning-subtle text-warning",
      )}
    >
      <p className="font-semibold">{title}</p>
      <p>{children}</p>
    </div>
  );
}

function DisconnectedView({
  status,
  locked,
}: {
  status: ChatgptLoginStatus;
  locked: boolean;
}) {
  const t = useT();
  const start = useStartChatgpt();
  const [consent, setConsent] = React.useState(false);
  const retry = status.state === "failed" || status.state === "expired";
  const consentId = React.useId();
  const consentLabelId = `${consentId}-label`;
  return (
    <>
      {status.state === "failed" && (
        <Notice
          tone="danger"
          role="alert"
          title={t("aiSettingsChatgpt.failed.title")}
        >
          {t("aiSettingsChatgpt.failed.hint")}
        </Notice>
      )}
      {status.state === "expired" && (
        <Notice
          tone="danger"
          role="alert"
          title={t("aiSettingsChatgpt.expired.title")}
        >
          {t("aiSettingsChatgpt.expired.hint")}
        </Notice>
      )}
      <p className="text-sm leading-5 text-muted-foreground">
        {t("aiSettingsChatgpt.intro")}
      </p>
      <Notice large tone="warning" title={t("aiSettingsChatgpt.risk.title")}>
        {t("aiSettingsChatgpt.risk.body")}
      </Notice>
      <div className="-mb-2 flex min-h-11 items-start gap-3">
        <Checkbox
          id={consentId}
          checked={consent}
          disabled={locked}
          onCheckedChange={(next) => setConsent(next === true)}
          className="mt-0.5"
        />
        <Label
          id={consentLabelId}
          htmlFor={consentId}
          className="min-h-11 items-start py-0.5 font-normal"
        >
          {t("aiSettingsChatgpt.risk.consent")}
        </Label>
      </div>
      <div>
        <Button
          type="button"
          variant={locked ? "outline" : "default"}
          disabled={locked || !consent}
          className="w-full disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100 disabled:shadow-none sm:w-auto"
          aria-describedby={consentLabelId}
          loading={start.isPending}
          onClick={() => start.mutate()}
        >
          {t(retry ? "aiSettingsChatgpt.newCode" : "aiSettingsChatgpt.connect")}
        </Button>
      </div>
      <ActionError error={start.error} />
    </>
  );
}

/** Only https links open; anything else shows as plain text. */
function loginLink(raw: string | null): { href: string; label: string } | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    return {
      href: url.href,
      label: `${url.host}${url.pathname}`.replace(/\/$/, ""),
    };
  } catch {
    return null;
  }
}

/** Why the last status check failed, for the UI. */
type PollProblem = "retry" | "stopped" | "denied" | null;

function PendingView({
  status,
  locked,
  onExpired,
}: {
  status: ChatgptLoginStatus;
  locked: boolean;
  onExpired: () => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const cancel = useRevokeChatgpt();
  const [copy, setCopy] = React.useState<"idle" | "done" | "failed">("idle");
  const [problem, setProblem] = React.useState<PollProblem>(null);
  const [attempt, setAttempt] = React.useState(0);
  const link = loginLink(status.verificationUrl);
  const { expiresAt } = status;
  // A cancel in flight must not race a check that would put `pending` back.
  const polling = !locked && !cancel.isPending;

  // The code runs out at `expiresAt`: from then on the UI treats it as expired.
  React.useEffect(() => {
    if (!expiresAt) return;
    const timer = setTimeout(
      onExpired,
      Math.max(0, new Date(expiresAt).getTime() - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [expiresAt, onExpired]);

  // One check every POLL_MS, the next only after the last answered. A terminal
  // answer replaces the cached status, which unmounts this view and the timer.
  // Cleanup marks the run stopped, so an answer that lands after a cancel (or
  // after unmount) is dropped. 401/403 stop for good, 429 backs off, five
  // failures in a row stop until the owner asks again, a hidden tab waits.
  React.useEffect(() => {
    if (!polling) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waitingVisible = false;
    let failures = 0;
    let delay = POLL_MS;
    const schedule = (ms: number) => {
      timer = setTimeout(() => void tick(), ms);
    };
    const tick = async () => {
      if (stopped) return;
      if (document.hidden) {
        waitingVisible = true;
        return;
      }
      try {
        const view = await pollChatgpt();
        if (stopped) return;
        failures = 0;
        delay = POLL_MS;
        setProblem(null);
        queryClient.setQueryData([getChatgptLogin.id], view);
      } catch (error) {
        if (stopped) return;
        const code = error instanceof ApiError ? error.status : 0;
        if (code === 401 || code === 403) {
          setProblem("denied");
          return;
        }
        if (code === 429) delay = Math.min(delay * 2, POLL_MAX_MS);
        else failures += 1;
        if (failures >= POLL_MAX_FAILURES) {
          setProblem("stopped");
          return;
        }
        setProblem("retry");
      }
      if (!stopped) schedule(delay);
    };
    const onVisible = () => {
      if (document.hidden || !waitingVisible || stopped) return;
      waitingVisible = false;
      schedule(POLL_RESUME_MS);
    };
    document.addEventListener("visibilitychange", onVisible);
    schedule(delay);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [polling, attempt, queryClient]);

  const copyCode = async () => {
    if (!status.deviceCode) return;
    try {
      await navigator.clipboard.writeText(status.deviceCode);
      setCopy("done");
    } catch {
      setCopy("failed");
    }
  };

  // Not the owner: no code and no steps, only the wait (the status refreshes
  // itself slowly through `useChatgptLogin`).
  if (!status.viewerCanManage) {
    return (
      <p className="flex items-center gap-2 text-sm leading-5 font-medium text-warning">
        <Clock className="size-4 shrink-0" aria-hidden="true" />
        {t("aiSettingsChatgpt.pending.waitingOwner")}
      </p>
    );
  }

  return (
    <>
      {status.deviceCode && (
        <div className="grid gap-2 rounded-control border-(length:--border-w) bg-surface-2 p-4">
          <p className="type-eyebrow text-muted-foreground">
            {t("aiSettingsChatgpt.pending.codeLabel")}
          </p>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="font-mono text-2xl leading-8 font-bold tracking-wider break-all select-all">
              {status.deviceCode}
            </span>
            <Button
              type="button"
              variant="outline"
              disabled={locked}
              onClick={() => void copyCode()}
            >
              {copy === "done" ? (
                <Check aria-hidden="true" />
              ) : (
                <Copy aria-hidden="true" />
              )}
              {t("aiSettingsChatgpt.pending.copy")}
            </Button>
          </div>
          <p
            aria-live="polite"
            className={cn(
              "text-sm leading-5",
              copy === "failed" ? "text-danger" : "text-muted-foreground",
            )}
          >
            {copy === "done" && t("aiSettingsChatgpt.pending.copied")}
            {copy === "failed" && t("aiSettingsChatgpt.pending.copyFailed")}
          </p>
        </div>
      )}
      <ol className="grid list-decimal gap-1 pl-5 text-sm leading-6">
        <li>{t("aiSettingsChatgpt.pending.steps.open")}</li>
        <li>{t("aiSettingsChatgpt.pending.steps.enter")}</li>
        <li>{t("aiSettingsChatgpt.pending.steps.back")}</li>
      </ol>
      {link && (
        <div className="grid justify-items-start gap-2 max-sm:justify-items-stretch">
          <Button
            asChild={!locked}
            variant={locked ? "outline" : "default"}
            disabled={locked}
            className="w-full sm:w-auto"
          >
            {locked ? (
              <span>{t("aiSettingsChatgpt.pending.openLogin")}</span>
            ) : (
              <a href={link.href} target="_blank" rel="noopener noreferrer">
                {t("aiSettingsChatgpt.pending.openLogin")}
                <ExternalLink aria-hidden="true" />
                <span className="sr-only">
                  {t("aiSettingsChatgpt.pending.openLoginHint")}
                </span>
              </a>
            )}
          </Button>
          <span className="text-sm leading-5 break-all text-muted-foreground">
            {link.label}
          </span>
        </div>
      )}
      {locked ? (
        <p
          role="status"
          className="flex items-start gap-2 text-sm leading-5 font-medium text-warning"
        >
          <Clock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t("aiSettingsChatgpt.pending.pausedByLock")}
        </p>
      ) : (
        <p className="flex items-center gap-2 text-sm leading-5 font-medium text-warning">
          <Clock className="size-4 shrink-0" aria-hidden="true" />
          {t("aiSettingsChatgpt.pending.waiting")}
        </p>
      )}
      {problem && (
        <div className="grid justify-items-start gap-2">
          <p
            role={problem === "retry" ? "status" : "alert"}
            className="text-sm leading-5 text-muted-foreground"
          >
            {t(
              problem === "retry"
                ? "aiSettingsChatgpt.pending.pollError"
                : problem === "denied"
                  ? "aiSettingsChatgpt.pending.pollDenied"
                  : "aiSettingsChatgpt.pending.pollStopped",
            )}
          </p>
          {problem === "stopped" && (
            <Button
              type="button"
              variant="outline"
              disabled={locked}
              className="w-full sm:w-auto"
              onClick={() => {
                setProblem(null);
                setAttempt((n) => n + 1);
              }}
            >
              {t("aiSettingsChatgpt.pending.checkAgain")}
            </Button>
          )}
        </div>
      )}
      <div>
        <Button
          type="button"
          variant="outline"
          className="w-full sm:w-auto"
          loading={cancel.isPending}
          onClick={() => cancel.mutate()}
        >
          {t("aiSettingsChatgpt.pending.cancel")}
        </Button>
      </div>
      <ActionError error={cancel.error} />
      {!locked && (
        <p className="text-sm leading-5 text-muted-foreground">
          {t("aiSettingsChatgpt.pending.cancelHint")}
        </p>
      )}
    </>
  );
}

function ConnectedView({
  canRevoke,
  onRevoke,
}: {
  /** Only the owner may cut the connection; the platform lock does not matter. */
  canRevoke: boolean;
  onRevoke: () => void;
}) {
  const t = useT();
  return (
    <>
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="grid size-8 shrink-0 place-items-center rounded-full bg-success-subtle text-success"
        >
          <CircleCheck className="size-5" />
        </span>
        <div className="grid gap-0.5">
          <p className="text-base leading-6 font-semibold">
            {t("aiSettingsChatgpt.connected.title")}
          </p>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("aiSettingsChatgpt.connected.hint")}
          </p>
        </div>
      </div>
      <p className="text-sm leading-5 text-muted-foreground">
        {t("aiSettingsChatgpt.connected.priority")}
      </p>
      <div>
        <Button
          type="button"
          variant="outline"
          disabled={!canRevoke}
          onClick={onRevoke}
          className="w-full text-danger sm:w-auto"
        >
          {t("aiSettingsChatgpt.connected.revoke")}
        </Button>
      </div>
    </>
  );
}
