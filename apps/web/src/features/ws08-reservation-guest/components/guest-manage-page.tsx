// "/reservasi/kelola#<token>" (bead legend-g12il): the guest's page for one
// reservation. The token lives in the URL fragment, so it never reaches a
// server log; this component only hands it to the hooks. State machine:
// token -> query -> deriveGuestScreen (what the server data says) plus a local
// step the guest chose (detail, reschedule form, cancel confirmation).
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useT } from "@/components/i18n";
import { API_MOCK } from "@/lib/api/mock-flag.ts";
import { publicSiteQuery } from "../../ws08-website/queries.ts";
import {
  useGuestReservation,
  useGuestTimeZone,
  useLinkToken,
} from "../hooks.ts";
import {
  deriveGuestScreen,
  guestErrorKind,
  isLateForReschedule,
} from "../lib.ts";
import { GuestShell } from "./guest-shell";
import { CancelledScreen } from "./screens/cancelled-screen";
import { CancelScreen } from "./screens/cancel-screen";
import { DetailScreen } from "./screens/detail-screen";
import { LateScreen } from "./screens/late-screen";
import {
  ClosedScreen,
  GuestLoadErrorScreen,
  GuestLoadingScreen,
  GuestRateLimitedScreen,
  InvalidLinkScreen,
} from "./screens/recovery-screens";
import { RequestStatusScreen } from "./screens/request-status-screen";
import { RescheduleScreen } from "./screens/reschedule-screen";

// What the guest chose to look at. "main" shows the screen the server data
// implies; the others override it until the guest goes back.
type Step = "main" | "detail" | "reschedule" | "cancel";

/** Brand name for the header; optional, the page never waits for it. */
function useGuestBrand(): string | null {
  const query = useQuery({
    ...publicSiteQuery(),
    enabled: typeof window !== "undefined",
  });
  return query.data?.brand.name ?? null;
}

export function GuestManagePage() {
  const token = useLinkToken();
  // Keyed by token: a new link starts with a fresh step and no late answer.
  return <GuestManageBody key={token ?? "none"} token={token} />;
}

function GuestManageBody({
  token,
}: {
  token: ReturnType<typeof useLinkToken>;
}) {
  const t = useT();
  const brand = useGuestBrand();
  const query = useGuestReservation(token);
  const view = query.data;
  const { timeZone, ready: timeZoneReady } = useGuestTimeZone(view?.outletId);
  const [step, setStep] = React.useState<Step>("main");
  // legend-z5ygw: the server answers RESERVATION_RESCHEDULE_LATE only on the
  // reschedule call, so the page remembers it and shows the late screen.
  const [lateForced, setLateForced] = React.useState(false);

  // Move focus to the new screen's heading after a step change, so a keyboard
  // or screen reader user lands on the new content. This effect is the only
  // focus mechanism (screens just expose the h1) and it never fires for the
  // first reservation content shown after loading.
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const screen = view ? deriveGuestScreen(view, new Date()) : null;
  // A server late answer wins over every screen that still offers a reschedule.
  // A pending request keeps its own screen: no new ask is possible then.
  const shown =
    lateForced &&
    (screen === "detail" || screen === "approved" || screen === "rejected")
      ? "late"
      : screen;
  // The detail screen offers no reschedule once the deadline passed or the
  // server refused one.
  const late =
    lateForced || (view !== undefined && isLateForReschedule(view, new Date()));
  // A finished reservation ignores a stale step (e.g. a refetch closed it), and
  // a pending request wins over the reschedule form.
  const current: Step =
    shown === "cancelled" ||
    shown === "closed" ||
    (shown === "pending" && step === "reschedule")
      ? "main"
      : step;
  // Error, rate-limit, and invalid-link screens replace the loading screen, so
  // they take focus too. The error timestamp is in the key: "Coba lagi" that
  // fails again is a new error and the guest hears it again.
  const errorKind = query.isError ? guestErrorKind(query.error) : null;
  let recoveryKey: string | null = null;
  if (token === null || (token !== undefined && errorKind === "invalid")) {
    recoveryKey = "invalid";
  } else if (token !== undefined && (!view || !shown) && query.isError) {
    recoveryKey = `${errorKind === "rate_limited" ? "rate_limited" : "error"}:${query.errorUpdatedAt}`;
  }
  const focusKey = recoveryKey ?? `${current}:${shown ?? "none"}`;
  const contentShown =
    recoveryKey !== null ||
    (view !== undefined && shown !== null && timeZoneReady);
  const lastKey = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!contentShown) return;
    const previous = lastKey.current;
    lastKey.current = focusKey;
    if (previous === focusKey) return;
    if (previous === null && recoveryKey === null) return;
    const heading = bodyRef.current?.querySelector("h1");
    if (heading instanceof HTMLElement) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }, [focusKey, contentShown, recoveryKey]);

  let body: React.ReactNode;
  if (token === undefined) {
    body = <GuestLoadingScreen />;
  } else if (token === null) {
    body = <InvalidLinkScreen />;
  } else if (query.isError && guestErrorKind(query.error) === "invalid") {
    body = <InvalidLinkScreen />;
  } else if (view && shown && !timeZoneReady) {
    // Hold the loading screen until the outlet zone is known (success or
    // failure), so times are not shown in WIB and then shifted.
    body = <GuestLoadingScreen />;
  } else if (!view || !shown) {
    if (query.isError) {
      body =
        guestErrorKind(query.error) === "rate_limited" ? (
          <GuestRateLimitedScreen onRetry={() => void query.refetch()} />
        ) : (
          <GuestLoadErrorScreen onRetry={() => void query.refetch()} />
        );
    } else {
      body = <GuestLoadingScreen />;
    }
  } else if (current === "reschedule" && late) {
    // founder: a late reschedule is refused, so the form is never shown.
    body = (
      <LateScreen
        view={view}
        timeZone={timeZone}
        onKeep={() => setStep("detail")}
        onCancel={() => setStep("cancel")}
      />
    );
  } else if (current === "reschedule") {
    body = (
      <RescheduleScreen
        view={view}
        timeZone={timeZone}
        token={token}
        onBack={() => setStep("detail")}
        onSubmitted={() => setStep("main")}
        onLate={() => {
          setLateForced(true);
          setStep("main");
        }}
      />
    );
  } else if (current === "cancel") {
    body = (
      <CancelScreen
        view={view}
        timeZone={timeZone}
        token={token}
        onBack={() => setStep(shown === "late" ? "main" : "detail")}
        onCancelled={() => setStep("main")}
      />
    );
  } else if (current === "detail" || shown === "detail") {
    body = (
      <DetailScreen
        view={view}
        timeZone={timeZone}
        late={late}
        // A pending request or a passed deadline is explained on its own
        // screen; the form is only offered when the server allows a new ask.
        onReschedule={() =>
          setStep(
            shown === "pending" || shown === "late" ? "main" : "reschedule",
          )
        }
        onViewRequest={() => setStep("main")}
        onCancel={() => setStep("cancel")}
      />
    );
  } else if (shown === "late") {
    body = (
      <LateScreen
        view={view}
        timeZone={timeZone}
        onKeep={() => setStep("detail")}
        onCancel={() => setStep("cancel")}
      />
    );
  } else if (shown === "cancelled") {
    body = <CancelledScreen view={view} timeZone={timeZone} />;
  } else if (shown === "closed") {
    body = <ClosedScreen view={view} timeZone={timeZone} />;
  } else {
    // pending, approved, rejected: read from view.rescheduleRequest.status.
    body = (
      <RequestStatusScreen
        view={view}
        timeZone={timeZone}
        onViewDetail={() => setStep("detail")}
      />
    );
  }

  return (
    <GuestShell brand={brand ?? view?.outletName ?? null}>
      {API_MOCK && (
        <p className="text-sm text-muted-foreground">
          {t("reservationGuest.mockNote")}
        </p>
      )}
      <div ref={bodyRef} className="grid gap-6">
        {body}
      </div>
    </GuestShell>
  );
}
