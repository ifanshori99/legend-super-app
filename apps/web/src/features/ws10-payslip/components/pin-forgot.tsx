// "Lupa PIN?" (bead ur82k; mockups payslip-pin-inbound). The employee proves the
// number by sending a WhatsApp message with a code; once the server reports it
// verified, a dialog leads to the new-PIN form and the PIN is saved with the
// proof. HR is the other way out and never sees or sets a PIN. This container
// is only the step machine: choose -> waiting -> verified (dialog) -> new-pin
// -> done, plus HR help and the blocked screens. The screens are the pure
// components in `wa-reset/`; the calls are in `wa-reset-hooks.ts`.
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
  const [pinFailure, setPinFailure] = useState<WaResetPinFailure | null>(null);
  const [startFailed, setStartFailed] = useState(false);

  const challengeId = challenge?.challengeId ?? null;
  const submit = useSubmitWaResetPin(challengeId);
  const status = useWaResetStatus(
    step === "waiting" ? challengeId : null,
    challenge?.expiresAt,
  );
  // True once the closing refetch after `expiresAt` found no verified proof.
  const [expiryChecked, setExpiryChecked] = useState(false);

  // The challenge that is still open on the server. Cleared once it is closed
  // (cancelled, or used to save the PIN), so leaving never cancels twice.
  const openChallenge = useRef<string | null>(null);

  // Leaving the screen (back link, navigation, tab close of the router) stops
  // the code from working.
  useEffect(
    () => () => {
      dropChallenge(openChallenge.current);
      openChallenge.current = null;
    },
    [],
  );

  function closeChallenge() {
    dropChallenge(openChallenge.current);
    openChallenge.current = null;
  }

  function goToList() {
    void navigate({ to: "/karyawan/slip-gaji" });
  }

  function block(kind: WaResetBlockedKind) {
    closeChallenge();
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
    if (step !== "waiting") return;
    if (polled === "verified") {
      setStep("verified");
    } else if (polled === "expired" || polled === "cancelled") {
      block("expired");
    } else if (polled === "used") {
      // The PIN was already saved with this proof (another tab): nothing to do.
      openChallenge.current = null;
      setStep("done");
    } else if (polledGone) {
      block("expired");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `block` only closes over refs and setters
  }, [step, polled, polledGone]);

  // The poll stops at `expiresAt`. One last ask decides what the screen says:
  // verified (the message landed in the last seconds) wins over the local
  // clock, which only the server may overrule.
  const refetchStatus = status.refetch;
  const expiresAt = challenge?.expiresAt;
  useEffect(() => {
    setExpiryChecked(false);
    if (step !== "waiting" || !expiresAt) return;
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
  }, [step, challengeId, expiresAt, refetchStatus]);

  async function begin() {
    // A new code replaces the old one: the old message must stop working.
    closeChallenge();
    setPinFailure(null);
    setStartFailed(false);
    try {
      const next = await start.mutateAsync();
      openChallenge.current = next.challengeId;
      setChallenge(next);
      setStep("waiting");
    } catch (error) {
      const kind = classifyWaResetError(error);
      if (kind !== null) {
        block(kind);
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

  if (step === "done") {
    return (
      <div className="mx-auto grid w-full max-w-xl gap-6">
        <SuccessCard
          title={t("payslipPin.pinTersimpan.title")}
          description={t("payslipPin.pinTersimpan.description")}
          actionLabel={t("payslipPin.pinTersimpan.continue")}
          onAction={goToList}
        />
      </div>
    );
  }

  if (step === "blocked") {
    return (
      <WaResetBlocked
        kind={blockedKind}
        onRetry={
          blockedKind === "expired" ||
          blockedKind === "service-unavailable" ||
          blockedKind === "mismatch"
            ? () => void begin()
            : undefined
        }
        onHrHelp={() => setStep("hr-help")}
        onBack={goToList}
      />
    );
  }

  if (step === "hr-help") {
    return <WaResetHrHelp onBack={goToList} />;
  }

  if (step === "new-pin" && challenge) {
    return (
      <WaResetNewPin
        onSubmit={(pin) => void savePin(pin)}
        submitting={submit.isPending}
        error={pinFailure}
        onRestart={restart}
      />
    );
  }

  if ((step === "waiting" || step === "verified") && challenge) {
    return (
      <>
        <WaResetWaiting
          code={challenge.code}
          waLink={challenge.waLink}
          senderHint={challenge.senderHint}
          expiresAt={challenge.expiresAt}
          expired={expiryChecked}
          onNotVerified={() => block("mismatch")}
          onRegenerate={() => void begin()}
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
  }

  return (
    <WaResetChoose
      onChooseWhatsApp={() => void begin()}
      onChooseHrHelp={() => setStep("hr-help")}
      pending={start.isPending}
      error={startFailed}
    />
  );
}
