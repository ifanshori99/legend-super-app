// "Lupa PIN?" (bead ur82k; mockups payslip-pin-inbound). The employee proves the
// number by sending a WhatsApp message with a code; once the server reports it
// verified, a dialog leads to the new-PIN form and the PIN is saved with the
// proof. HR is the other way out and never sees or sets a PIN. This container
// is only the step machine: choose -> waiting -> verified (dialog) -> new-pin
// -> done, plus HR help and the blocked screens. The screens are the pure
// components in `wa-reset/`; the calls are in `wa-reset-hooks.ts`.
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { ApiError } from "@/lib/api/errors";
import type { WaResetChallenge } from "../wa-reset-api.ts";
import { cancelWaReset } from "../wa-reset-api.ts";
import type {
  WaResetBlockedKind,
  WaResetPinFailure,
} from "../wa-reset-hooks.ts";
import {
  classifyWaResetError,
  classifyWaResetPinError,
  useStartWaReset,
  useSubmitWaResetPin,
  useWaResetStatus,
  waResetRetryAfterSeconds,
} from "../wa-reset-hooks.ts";
import { SuccessCard } from "./success-card.tsx";
import { WaResetBlocked } from "./wa-reset/blocked.tsx";
import { WaResetChoose } from "./wa-reset/choose.tsx";
import { WaResetHrHelp } from "./wa-reset/hr-help.tsx";
import { WaResetNewPin } from "./wa-reset/new-pin.tsx";
import { WaResetVerifiedDialog } from "./wa-reset/verified-dialog.tsx";
import { WaResetWaiting } from "./wa-reset/waiting.tsx";

type Step =
  | "choose"
  | "hr-help"
  | "waiting"
  | "verified"
  | "new-pin"
  | "done"
  | "blocked";

/** Tells the server to drop a challenge; a failure changes nothing for the user. */
function dropChallenge(challengeId: string | null) {
  if (challengeId === null) return;
  void cancelWaReset(challengeId).catch(() => undefined);
}

export function PinForgot() {
  const t = useT();
  const navigate = useNavigate();
  const start = useStartWaReset();

  const [step, setStep] = useState<Step>("choose");
  const [challenge, setChallenge] = useState<WaResetChallenge | null>(null);
  const [blockedKind, setBlockedKind] = useState<WaResetBlockedKind>(
    "service-unavailable",
  );
  // Server wait of a 429, for the countdown on the rate-limited screen.
  const [retryAfterSeconds, setRetryAfterSeconds] = useState<
    number | undefined
  >();
  const [pinFailure, setPinFailure] = useState<WaResetPinFailure | null>(null);
  const [startFailed, setStartFailed] = useState(false);
  // The code of a challenge that just expired, shown struck through on the
  // expired screen (the challenge itself is gone by then).
  const [expiredCode, setExpiredCode] = useState<string | undefined>();

  const challengeId = challenge?.challengeId ?? null;
  const submit = useSubmitWaResetPin(challengeId);
  // The poll runs while waiting and also behind the "no matching message"
  // screen: the message may still land, and then the dialog takes over.
  const watching =
    step === "waiting" ||
    (step === "blocked" && blockedKind === "mismatch" && challenge !== null);
  const status = useWaResetStatus(
    // Off while a new code is being asked for: the old id must not flip the
    // screen to "expired" mid-switch.
    watching && !start.isPending ? challengeId : null,
    challenge?.expiresAt,
  );
  // True once the closing refetch after `expiresAt` found no verified proof.
  const [expiryChecked, setExpiryChecked] = useState(false);

  // The challenge that is still open on the server. Cleared once it is closed
  // (cancelled, or used to save the PIN), so leaving never cancels twice.
  const openChallenge = useRef<string | null>(null);

  // Leaving the screen (back link, navigation, tab close of the router) stops
  // the code from working.
  // `mounted` lets a start that finishes after leaving cancel its own challenge.
  const mounted = useRef(false);
  const starting = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      dropChallenge(openChallenge.current);
      openChallenge.current = null;
    };
  }, []);

  function closeChallenge() {
    dropChallenge(openChallenge.current);
    openChallenge.current = null;
  }

  // "No matching message": the challenge stays open and the poll keeps going,
  // so a late message still ends in the verified dialog.
  function showMismatch() {
    setBlockedKind("mismatch");
    setStep("blocked");
  }

  function goToList() {
    void navigate({ to: "/karyawan/slip-gaji" });
  }

  function block(kind: WaResetBlockedKind, waitSeconds?: number) {
    closeChallenge();
    setRetryAfterSeconds(waitSeconds);
    setExpiredCode(kind === "expired" ? challenge?.code : undefined);
    setChallenge(null);
    setBlockedKind(kind);
    setStep("blocked");
  }

  // The poll decides when the message has landed or the code is no longer good.
  // A passing error (network, 5xx) is not an answer: only a 404 ends the wait.
  const polled = status.data?.status;
  const polledGone =
    status.error instanceof ApiError && status.error.status === 404;
  useEffect(() => {
    if (!watching) return;
    if (polled === "verified") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- state follows the polled challenge status, the expiry timer and the screen change
      setStep("verified");
    } else if (polled === "expired" || polled === "cancelled") {
      block("expired");
    } else if (polled === "used") {
      // The PIN was already saved with this proof (another tab): nothing to do.
      openChallenge.current = null;
      setStep("done");
    } else if (polledGone) {
      block("expired");
    } else if (step === "blocked" && expiryChecked) {
      // Behind the mismatch screen nothing else shows the clock running out.
      block("expired");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `block` only closes over refs, setters and the code
  }, [watching, step, polled, polledGone, expiryChecked]);

  // The poll stops at `expiresAt`. One last ask decides what the screen says:
  // verified (the message landed in the last seconds) wins over the local
  // clock, which only the server may overrule.
  const refetchStatus = status.refetch;
  const expiresAt = challenge?.expiresAt;
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- state follows the polled challenge status, the expiry timer and the screen change
    setExpiryChecked(false);
  }, [challengeId, expiresAt]);
  useEffect(() => {
    if (!watching || !expiresAt || start.isPending) return;
    let cancelled = false;
    const timer = setTimeout(
      () => {
        void refetchStatus().finally(() => {
          if (!cancelled) setExpiryChecked(true);
        });
      },
      Math.max(0, Date.parse(expiresAt) - Date.now()),
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [watching, challengeId, expiresAt, refetchStatus, start.isPending]);

  // Focus and announcements. Each new screen puts focus on its heading and a
  // single live region says what changed (the dialog manages its own focus).
  const containerRef = useRef<HTMLDivElement>(null);
  const [announcement, setAnnouncement] = useState("");
  const screenKey = step === "blocked" ? `blocked:${blockedKind}` : step;
  const previousScreen = useRef(screenKey);
  useEffect(() => {
    if (previousScreen.current === screenKey) return;
    previousScreen.current = screenKey;
    if (screenKey === "verified") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- state follows the polled challenge status, the expiry timer and the screen change
      setAnnouncement("Nomor terverifikasi");
      return;
    }
    setAnnouncement(screenKey === "blocked:expired" ? "Kode kedaluwarsa" : "");
    // new-pin sets its own focus (PIN box on fine pointers, heading on touch).
    if (screenKey === "new-pin") return;
    const heading = containerRef.current?.querySelector("h2");
    if (heading instanceof HTMLElement) {
      heading.tabIndex = -1;
      heading.focus();
    }
  }, [screenKey]);

  async function begin() {
    // One start at a time: a second tap must not open a second challenge.
    if (starting.current) return;
    starting.current = true;
    setPinFailure(null);
    setStartFailed(false);
    setExpiredCode(undefined);
    try {
      const next = await start.mutateAsync();
      if (!mounted.current) {
        // The employee left meanwhile: this code must never work.
        dropChallenge(next.challengeId);
        return;
      }
      // A new code replaces the old one, but only once the new one exists.
      const previous = openChallenge.current;
      openChallenge.current = next.challengeId;
      dropChallenge(previous);
      setChallenge(next);
      setStep("waiting");
    } catch (error) {
      if (!mounted.current) return;
      // The old code (if any) stops working; the screen is leaving it anyway.
      closeChallenge();
      const kind = classifyWaResetError(error);
      if (kind !== null) {
        block(kind, waResetRetryAfterSeconds(error));
      } else if (
        error instanceof ApiError &&
        error.code === "PAYSLIP_PIN_NOT_SET"
      ) {
        // No PIN to reset: the list takes the employee to creating one.
        goToList();
      } else {
        // Network or 5xx: an inline error on the choices, no dead end.
        setChallenge(null);
        setStartFailed(true);
        setStep("choose");
      }
    } finally {
      starting.current = false;
    }
  }

  async function savePin(pin: string) {
    setPinFailure(null);
    try {
      await submit.mutateAsync(pin);
      // Nothing keeps the PIN once the success screen shows.
      submit.reset();
      openChallenge.current = null;
      setChallenge(null);
      setStep("done");
    } catch (error) {
      setPinFailure(classifyWaResetPinError(error));
    }
  }

  function restart() {
    closeChallenge();
    setChallenge(null);
    setPinFailure(null);
    submit.reset();
    setStep("choose");
  }

  function leaveWaiting() {
    closeChallenge();
    setChallenge(null);
    setStep("choose");
  }

  let content: ReactNode;
  if (step === "done") {
    content = (
      <div className="mx-auto grid w-full max-w-xl gap-6">
        <SuccessCard
          title={t("payslipPin.pinTersimpan.title")}
          description={t("payslipPin.pinTersimpan.description")}
          actionLabel={t("payslipPin.pinTersimpan.continue")}
          onAction={goToList}
        />
      </div>
    );
  } else if (step === "blocked") {
    content = (
      <WaResetBlocked
        // A fresh 429 restarts the countdown.
        key={`${blockedKind}:${retryAfterSeconds ?? ""}`}
        kind={blockedKind}
        retryAfterSeconds={retryAfterSeconds}
        senderHint={challenge?.senderHint}
        code={blockedKind === "expired" ? expiredCode : undefined}
        onRetry={
          blockedKind === "expired" ||
          blockedKind === "service-unavailable" ||
          blockedKind === "mismatch"
            ? () => void begin()
            : undefined
        }
        onWaitMore={
          blockedKind === "mismatch" && challenge
            ? () => setStep("waiting")
            : undefined
        }
        retrying={start.isPending}
        onHrHelp={() => {
          // Leaving for the HR guide ends the open code.
          if (blockedKind === "mismatch") {
            closeChallenge();
            setChallenge(null);
          }
          setStep("hr-help");
        }}
        onBack={goToList}
      />
    );
  } else if (step === "hr-help") {
    content = <WaResetHrHelp onBack={goToList} />;
  } else if (step === "new-pin" && challenge) {
    content = (
      <WaResetNewPin
        onSubmit={(pin) => void savePin(pin)}
        submitting={submit.isPending}
        error={pinFailure}
        onRestart={restart}
      />
    );
  } else if ((step === "waiting" || step === "verified") && challenge) {
    content = (
      <>
        <WaResetWaiting
          code={challenge.code}
          waLink={challenge.waLink}
          senderHint={challenge.senderHint}
          expiresAt={challenge.expiresAt}
          expired={expiryChecked}
          onNotVerified={showMismatch}
          onRegenerate={() => void begin()}
          regenerating={start.isPending}
          onCancel={() => {
            leaveWaiting();
            goToList();
          }}
          onHrHelp={() => {
            leaveWaiting();
            setStep("hr-help");
          }}
        />
        <WaResetVerifiedDialog
          open={step === "verified"}
          onContinue={() => setStep("new-pin")}
        />
      </>
    );
  } else {
    content = (
      <WaResetChoose
        onChooseWhatsApp={() => void begin()}
        onChooseHrHelp={() => setStep("hr-help")}
        pending={start.isPending}
        error={startFailed}
      />
    );
  }

  return (
    <div ref={containerRef}>
      {content}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
